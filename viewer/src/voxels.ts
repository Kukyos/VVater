/**
 * The volumetric layer: a custom VoxelProvider feeding Cesium's own raymarcher.
 *
 * The problem statement asks for "3D volumetric rendering ... using WebGL / Three.js or
 * Cesium.js", and the usual reading is that somebody writes a raymarching shader from
 * scratch. Cesium already has one. `VoxelPrimitive` walks the ray and alpha-composites
 * the result; our fragment function runs at each step and decides what that step looks
 * like. So the work here is a transfer function, not a marcher.
 *
 * Two things are worth knowing before changing anything:
 *
 *   1. `VoxelPrimitive` is @experimental in CesiumJS and takes breaking changes without
 *      deprecation, so the version in package.json is pinned exactly (11-deferred D-03).
 *   2. Voxel data is ordered x fastest, then y, then z, with **z = 0 at the lowest
 *      height** — the deepest water. The server reverses the depth axis to match; see
 *      `server/ocean/volume.py:_flatten`.
 */

import {
  Cartesian2,
  Cartesian3,
  CustomShader,
  CustomShaderMode,
  CustomShaderTranslucencyMode,
  Ellipsoid,
  LightingModel,
  Matrix4,
  Math as CesiumMath,
  MetadataComponentType,
  MetadataType,
  UniformType,
  VoxelContent,
  VoxelPrimitive,
  VoxelShapeType,
} from "@cesium/engine";
import type { VolumeMeta } from "./api";
import { RAMP_STOPS, byId, paletteStops } from "./colorbar";

/**
 * Opacity is defined per this much true water depth, not per raymarch sample.
 *
 * Cesium takes roughly one sample per voxel along the ray, so a per-sample alpha makes
 * the same water more opaque the finer the grid and the smaller the step: GLORYS at
 * 1/12 deg rendered as a solid slab at the opacity that left INCOIS translucent, and a
 * finer vertical grid would have made the same water look denser. Scaling by
 * the distance each step actually travelled makes it independent of sampling. 400 m
 * was chosen by eye on the INCOIS field at the default 0.35: at 80 m the surface layer
 * saturated and hid everything beneath it, at 1600 m the column washed out.
 */
export const OPACITY_REFERENCE_DEPTH_M = 400;

/**
 * Stands in for NaN on the residual layer. Only safe on a nearest-sampled volume:
 * interpolated, a sentinel would smear a -1e30 gradient across every coast.
 */
export const EMPTY_SENTINEL = -1e30;

/** Metadata channel names. These become struct fields in the shader, so no GLSL keywords. */
export const VALUE_FIELD = "oceanValue";
export const ERROR_FIELD = "uncertainty";

export class OceanVoxelProvider {
  readonly shape = VoxelShapeType.ELLIPSOID;

  // Both transforms are mandatory even though the interface marks them readonly rather
  // than required. Leaving them undefined gives the shape a zero-radius bounding sphere,
  // the traversal culls the primitive before it ever asks for data, and the result is a
  // correct, ready, visible primitive that draws absolutely nothing and logs no error.
  // An ELLIPSOID shape works in units of WGS84 radii, so that scale is the transform.
  readonly globalTransform = Matrix4.IDENTITY.clone();
  readonly shapeTransform = Matrix4.fromScale(Ellipsoid.WGS84.radii);
  readonly dimensions: Cartesian3;
  readonly minBounds: Cartesian3;
  readonly maxBounds: Cartesian3;
  readonly names: string[];
  readonly types: MetadataType[];
  readonly componentTypes: MetadataComponentType[];
  readonly minimumValues: number[][];
  readonly maximumValues: number[][];
  readonly maximumTileCount = 1;
  readonly paddingBefore = Cartesian3.ZERO;
  readonly paddingAfter = Cartesian3.ZERO;

  private channels: Float32Array[];

  constructor(meta: VolumeMeta, values: Float32Array, errors: Float32Array | null,
              verticalExaggeration = 1) {
    const [nx, ny, nz] = meta.dimensions;
    this.dimensions = new Cartesian3(nx, ny, nz);

    // Ellipsoid bounds are (longitude, latitude, height): radians, radians, metres.
    // Height is negative below the sea surface and our depths are positive down, so the
    // deepest water is the *minimum* bound. Exaggeration is just a scale on the height
    // span — which is why the vertical slider the brief asks for costs nothing here.
    const [lon0, lon1] = meta.lonRange;
    const [lat0, lat1] = meta.latRange;
    const [shallow, deep] = meta.depthRange;

    this.minBounds = new Cartesian3(
      CesiumMath.toRadians(lon0),
      CesiumMath.toRadians(lat0),
      -deep * verticalExaggeration,
    );
    this.maxBounds = new Cartesian3(
      CesiumMath.toRadians(lon1),
      CesiumMath.toRadians(lat1),
      -shallow * verticalExaggeration,
    );

    const [lo, hi] = meta.valueRange;
    this.channels = errors ? [values, errors] : [values];
    this.names = errors ? [VALUE_FIELD, ERROR_FIELD] : [VALUE_FIELD];
    this.types = this.names.map(() => MetadataType.SCALAR);
    this.componentTypes = this.names.map(() => MetadataComponentType.FLOAT32);
    this.minimumValues = errors ? [[lo], [0]] : [[lo]];
    this.maximumValues = errors ? [[hi], [1]] : [[hi]];
  }

  /** One tile, already in memory. Streaming and tiling are a later problem (L1). */
  requestData(): Promise<VoxelContent> {
    return Promise.resolve(VoxelContent.fromMetadataArray(this.channels));
  }
}

/**
 * The per-step fragment function.
 *
 * Runs once for every sample the raymarcher takes and returns a colour and an alpha;
 * Cesium composites them along the ray. Everything the brief asks for under
 * "customizable colorbar & variable controls" lives in these uniforms, so changing a
 * palette or a range is `setUniform`, not a reshade:
 *
 *   u_palette        256x1 texture, swapped when the user picks a different colourbar
 *   u_range          min/max the palette spans
 *   u_logScale       linear or log mapping
 *   u_opacity        overall layer opacity
 *   u_errorWeight    how strongly uncertainty fades a sample (0 = ignore it)
 *   u_isoValue       isosurface threshold
 *   u_isoBand        half-width of the isosurface shell; 0 disables it
 *
 * NaN is the land and bathymetry mask and is discarded rather than clamped, which is why
 * the continents stay empty instead of taking whatever colour zero maps to.
 */
export function makeOceanShader(meta: VolumeMeta, paletteId: string,
                                reversed = false): CustomShader {
  const [lo, hi] = meta.valueRange;
  const hasError = meta.hasError;

  return new CustomShader({
    mode: CustomShaderMode.REPLACE_MATERIAL,
    lightingModel: LightingModel.UNLIT,
    // Without this the primitive is classified opaque from its material and every
    // per-step alpha we compute is discarded, so a correctly built volume renders as
    // nothing at all. Voxel rendering fails silently; this is the switch that matters.
    translucencyMode: CustomShaderTranslucencyMode.TRANSLUCENT,
    uniforms: {
      ...rampUniforms(paletteId, reversed),
      u_range: { type: UniformType.VEC2, value: new Cartesian2(lo, hi) },
      u_logScale: { type: UniformType.FLOAT, value: 0.0 },
      u_opacity: { type: UniformType.FLOAT, value: 0.12 },
      u_errorWeight: { type: UniformType.FLOAT, value: hasError ? 1.0 : 0.0 },
      u_isoValue: { type: UniformType.FLOAT, value: 0.5 * (lo + hi) },
      u_isoBand: { type: UniformType.FLOAT, value: 0.0 },
      // Eye-space metres per opacity unit; OPACITY_REFERENCE_DEPTH_M x exaggeration.
      u_refLength: { type: UniformType.FLOAT, value: OPACITY_REFERENCE_DEPTH_M },
      // 1 = opacity per sample, for sparse binned layers (the residual). See main.ts.
      u_perCell: { type: UniformType.FLOAT, value: 0.0 },
    },
    fragmentShaderText: `
      // The colourbar, evaluated rather than sampled. Six stops, linearly interpolated.
      vec3 ramp(float t) {
        float scaled = clamp(t, 0.0, 1.0) * ${RAMP_STOPS - 1}.0;
        float index = floor(scaled);
        float frac = scaled - index;
        vec3 a = u_c0;
        vec3 b = u_c1;
        if (index >= 4.0)      { a = u_c4; b = u_c5; }
        else if (index >= 3.0) { a = u_c3; b = u_c4; }
        else if (index >= 2.0) { a = u_c2; b = u_c3; }
        else if (index >= 1.0) { a = u_c1; b = u_c2; }
        return mix(a, b, frac);
      }

      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        float value = fsInput.metadata.${VALUE_FIELD};

        // Land and bathymetry mask. Discarding beats clamping: a masked cell must
        // contribute nothing, not the colour that the low end of the palette happens
        // to be.
        // value != value is the portable NaN test. GLSL ES 1.00 has no isnan(), and
        // which GLSL version Cesium compiles to depends on the browser's WebGL level,
        // so the idiom that works everywhere is the one to use.
        // EMPTY_SENTINEL too: on the nearest-sampled residual the NaN test did not
        // survive (empty bins drew opaque at the palette's low end), so empty residual
        // bins are sent as a sentinel instead. See EMPTY_SENTINEL.
        if (value != value || value < -1e29) {
          material.alpha = 0.0;
          return;
        }

        float lo = u_range.x;
        float hi = u_range.y;
        float t;
        if (u_logScale > 0.5) {
          // Guarded so a range straddling zero cannot produce log of a non-positive
          // number; the control that sets this refuses such a range anyway.
          float safeLo = max(lo, 1e-6);
          float safeValue = max(value, safeLo);
          t = (log(safeValue) - log(safeLo)) / max(log(max(hi, safeLo + 1e-6)) - log(safeLo), 1e-6);
        } else {
          t = (value - lo) / max(hi - lo, 1e-6);
        }
        t = clamp(t, 0.0, 1.0);

        material.diffuse = ramp(t);

        float alpha = u_opacity;

        // Isosurface: a shell of raised opacity around the threshold. This is what the
        // brief calls "isosurface extraction", and as a shader mode it costs nothing
        // and follows the timeline for free. A marching-cubes mesh is a separate,
        // server-side path and only earns its keep if somebody needs to export it.
        if (u_isoBand > 0.0) {
          float distance = abs(value - u_isoValue);
          alpha = distance < u_isoBand
            ? mix(1.0, 0.0, distance / u_isoBand)
            : 0.0;
        }

        ${hasError ? `
        // Uncertainty fades the sample. The analysis ships a per-cell error field and
        // most platforms throw it away; here low-confidence water is visibly faint
        // rather than silently as solid as everything else.
        float error = fsInput.metadata.${ERROR_FIELD};
        if (error == error) {
          alpha *= mix(1.0, clamp(1.0 - error, 0.05, 1.0), u_errorWeight);
        }
        ` : ``}

        // Per-distance, not per-sample (see OPACITY_REFERENCE_DEPTH_M). An isosurface
        // shell at alpha 1 stays 1; everything else scales with the step travelled.
        alpha = clamp(alpha, 0.0, 1.0);
        float steps = fsInput.voxel.travelDistance / max(u_refLength, 1e-3);
        material.alpha = (alpha >= 1.0 || u_perCell > 0.5)
          ? alpha
          : 1.0 - pow(1.0 - alpha, steps);
      }
    `,
  });
}

/** The six ramp stops as vec3 uniforms, named u_c0 .. u_c5. */
export function rampUniforms(paletteId: string, reversed: boolean) {
  const stops = paletteStops(byId(paletteId), reversed, RAMP_STOPS);
  return Object.fromEntries(
    stops.map((rgb, i) => [
      `u_c${i}`,
      { type: UniformType.VEC3, value: new Cartesian3(rgb[0], rgb[1], rgb[2]) },
    ]),
  );
}

/** Push a palette change onto a live shader. Six setUniform calls, no upload. */
export function applyRamp(shader: CustomShader, paletteId: string, reversed: boolean): void {
  paletteStops(byId(paletteId), reversed, RAMP_STOPS).forEach((rgb, i) => {
    shader.setUniform(`u_c${i}`, new Cartesian3(rgb[0], rgb[1], rgb[2]));
  });
}

export function addVolume(scene: { primitives: { add: (p: unknown) => unknown } },
                          provider: OceanVoxelProvider,
                          customShader: CustomShader): VoxelPrimitive {
  const primitive = new VoxelPrimitive({ provider: provider as never, customShader });
  scene.primitives.add(primitive);
  return primitive;
}
