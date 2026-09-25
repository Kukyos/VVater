/**
 * The Ocean Cube in the Cesium scene: a block of water standing on the sea surface where
 * it came from, with its sides painted as vertical sections, its top as a horizontal
 * section, the sea floor inside it, and depth marked on its edge.
 *
 * **Why it stands above the surface.** The first viewer put the volume where the water
 * is, below the sea surface, and then needed a translucent globe, disabled collision
 * detection and a clipped translucency rectangle to see it at all; at a glancing angle it
 * turned to haze. A cube lifted out and set on the surface is looked at from the side with
 * an opaque globe and no camera tricks, which is the whole point of it. The footprint is
 * exactly the box's; only the vertical is re-placed, and every height maps back to a depth
 * through `depthOf`.
 *
 * Everything is rebuilt synchronously (`asynchronous: false`) and swapped in one frame, so
 * a cut plane being dragged never shows an empty cube in between.
 */

import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ComponentDatatype,
  Ellipsoid,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  PolylineCollection,
  Primitive,
  PrimitiveType,
  Rectangle,
  RectangleGeometry,
  VerticalOrigin,
  WallGeometry,
  type Scene,
} from "@cesium/engine";

import { CubeData, depthTicks, depthToT, tToDepth } from "./data";
import { type Style, paintFloor, paintLevel, paintWall } from "./paint";

/** The visible part of the cube: its own extent, or a cut into it. */
export interface Cut { lon0: number; lon1: number; lat0: number; lat1: number;
                       top: number; bottom: number }

/** A face material: the painted image, with land (alpha 0) cut out rather than blended. */
function faceMaterial(image: HTMLCanvasElement, opacity: number): Material {
  return new Material({
    fabric: {
      uniforms: { image, opacity },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          vec4 c = texture(image, materialInput.st);
          if (c.a < 0.5) discard;
          material.diffuse = c.rgb;
          material.alpha = opacity;
          return material;
        }`,
    },
    translucent: opacity < 1,
  });
}

const appearance = (image: HTMLCanvasElement, opacity: number) => new MaterialAppearance({
  material: faceMaterial(image, opacity),
  // Unlit: a face's colour is a data value through the colour bar, and shading would
  // change what the colour says. Depth is carried by the edges and ticks instead.
  flat: true,
  faceForward: true,
  translucent: opacity < 1,
  closed: false,
});

/** Pixels per data cell on a face: enough for smooth bilinear sections, capped. */
const PX_PER_CELL = 8;
const MAX_PX = 2048;
const WALL_ROWS = 512;

export class CubeScene {
  private primitives: Primitive[] = [];
  private edges = new PolylineCollection();
  private labels = new LabelCollection();
  data?: CubeData;
  /** Display height of the cube's full depth range, metres in the scene. */
  height = 400_000;
  /** Where the cube's deepest point sits above the ellipsoid: just clear of the globe. */
  base = 4_000;
  /** Face opacity, 0.1–1: below 1 the far walls show through the near ones. */
  opacity = 1;
  private style?: Style;
  private cut?: Cut;

  constructor(private scene: Scene) {
    scene.primitives.add(this.edges);
    scene.primitives.add(this.labels);
  }

  /** The height in the scene of a depth, through the cube's depth axis. */
  heightOf(depth: number): number {
    const s = this.style!;
    return this.base + (1 - depthToT(depth, s.cubeTop, s.cubeBottom, s.axis)) * this.height;
  }

  /** The inverse: a height in the scene back to a depth in metres (hard rule 4). */
  depthOf(height: number): number {
    const s = this.style!;
    const t = 1 - (height - this.base) / this.height;
    return tToDepth(Math.min(Math.max(t, 0), 1), s.cubeTop, s.cubeBottom, s.axis);
  }

  /** Vertical exaggeration of what is drawn, for the HUD: display metres per metre. */
  get exaggeration(): number {
    const s = this.style!;
    return this.height / Math.max(s.cubeBottom - s.cubeTop, 1);
  }

  /** Kept across redraws: a cube put away stays away when it is recut or reloaded. */
  private visible = true;

  show(visible: boolean): void {
    this.visible = visible;
    for (const p of this.primitives) p.show = visible;
    this.edges.show = visible;
    this.labels.show = visible;
  }

  clear(): void {
    for (const p of this.primitives) this.scene.primitives.remove(p);
    this.primitives = [];
    this.edges.removeAll();
    this.labels.removeAll();
  }

  /** Draw (or redraw) the cube for this data, cut and style. */
  render(data: CubeData, cut: Cut, style: Style, height: number): void {
    this.data = data;
    this.cut = cut;
    this.style = style;
    this.height = height;
    this.base = Math.max(2_000, height * 0.01);

    const next: Primitive[] = [];
    const add = (geometry: unknown, image: HTMLCanvasElement) => {
      next.push(new Primitive({
        geometryInstances: new GeometryInstance({ geometry: geometry as never }),
        appearance: appearance(image, this.opacity),
        asynchronous: false,
      }));
    };

    const cellsX = Math.max(2, Math.round((cut.lon1 - cut.lon0) / this.stepLon() + 1));
    const cellsY = Math.max(2, Math.round((cut.lat1 - cut.lat0) / this.stepLat() + 1));
    const wX = Math.min(MAX_PX, cellsX * PX_PER_CELL);
    const wY = Math.min(MAX_PX, cellsY * PX_PER_CELL);
    const top = this.heightOf(cut.top);
    const bottom = this.heightOf(cut.bottom);

    // The top: a horizontal section at the cut's top depth.
    add(new RectangleGeometry({
      rectangle: Rectangle.fromDegrees(wrap(cut.lon0), cut.lat0, wrap(cut.lon1), cut.lat1),
      height: top,
      vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
    }), paintLevel(data, cut.lon0, cut.lon1, cut.lat0, cut.lat1, cut.top, style, wX, wY));

    // Four walls, each a vertical section along its edge of the cut.
    const walls: [number, number, number, number, number][] = [
      [cut.lon0, cut.lat0, cut.lon1, cut.lat0, wX],  // south
      [cut.lon0, cut.lat1, cut.lon1, cut.lat1, wX],  // north
      [cut.lon0, cut.lat0, cut.lon0, cut.lat1, wY],  // west
      [cut.lon1, cut.lat0, cut.lon1, cut.lat1, wY],  // east
    ];
    for (const [lon0, lat0, lon1, lat1, width] of walls) {
      const positions = this.linePositions(lon0, lat0, lon1, lat1);
      add(new WallGeometry({
        positions,
        minimumHeights: positions.map(() => bottom),
        maximumHeights: positions.map(() => top),
        vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }), paintWall(data, { lon0, lat0, lon1, lat1 }, cut.top, cut.bottom, style, width,
                    WALL_ROWS));
    }

    const floor = this.floorGeometry(data, cut);
    if (floor) add(floor, paintFloor(data, style.cubeBottom));

    // Swap in one go: the new primitives are built synchronously on their first update.
    for (const p of this.primitives) this.scene.primitives.remove(p);
    for (const p of next) {
      p.show = this.visible;
      this.scene.primitives.add(p);
    }
    this.primitives = next;
    this.frame(cut);
  }

  private stepLon(): number {
    const l = this.data!.lons;
    return l.length > 1 ? (l[l.length - 1] - l[0]) / (l.length - 1) : 1;
  }

  private stepLat(): number {
    const l = this.data!.lats;
    return l.length > 1 ? (l[l.length - 1] - l[0]) / (l.length - 1) : 1;
  }

  /**
   * Surface positions along a line of constant latitude or longitude: both ends plus one
   * per data column in between. Two endpoints alone would let a wide wall follow a great
   * circle and bow poleward off the line its texture was sampled along.
   */
  private linePositions(lon0: number, lat0: number, lon1: number, lat1: number): Cartesian3[] {
    const alongLon = lat0 === lat1;
    const axis = alongLon ? this.data!.lons : this.data!.lats;
    const a = alongLon ? lon0 : lat0;
    const b = alongLon ? lon1 : lat1;
    const stops = [a, ...Array.from(axis).filter((v) => v > a && v < b), b];
    return stops.map((v) => alongLon
      ? Cartesian3.fromDegrees(wrap(v), lat0)
      : Cartesian3.fromDegrees(wrap(lon0), v));
  }

  /**
   * The sea floor as a mesh over the data grid, inside the cut. Deeper than the cut's
   * bottom it lies on the bottom; land rises to the cut's top, so coasts stand up as
   * plateaus around the water. Textured with a hillshaded bathymetry image.
   */
  private floorGeometry(c: CubeData, cut: Cut): Geometry | undefined {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < c.nx; i += 1) if (c.lons[i] >= cut.lon0 && c.lons[i] <= cut.lon1) xs.push(i);
    for (let j = 0; j < c.ny; j += 1) if (c.lats[j] >= cut.lat0 && c.lats[j] <= cut.lat1) ys.push(j);
    if (xs.length < 2 || ys.length < 2) return undefined;
    const n = xs.length * ys.length;
    const positions = new Float64Array(n * 3);
    const normals = new Float32Array(n * 3);
    const st = new Float32Array(n * 2);
    const top = this.heightOf(cut.top);
    const bottom = this.heightOf(cut.bottom);
    const scratch = new Cartesian3();
    let v = 0;
    for (const j of ys) {
      for (const i of xs) {
        const f = c.floor(i, j);
        const h = Number.isNaN(f) ? top
          : f >= cut.bottom ? bottom
          : f <= cut.top ? top
          : this.heightOf(f);
        const p = Cartesian3.fromDegrees(wrap(c.lons[i]), c.lats[j], h, Ellipsoid.WGS84, scratch);
        positions[v * 3] = p.x;
        positions[v * 3 + 1] = p.y;
        positions[v * 3 + 2] = p.z;
        const up = Ellipsoid.WGS84.geodeticSurfaceNormal(p, scratch);
        normals[v * 3] = up.x;
        normals[v * 3 + 1] = up.y;
        normals[v * 3 + 2] = up.z;
        st[v * 2] = i / Math.max(c.nx - 1, 1);
        st[v * 2 + 1] = j / Math.max(c.ny - 1, 1);
        v += 1;
      }
    }
    const w = xs.length;
    const indices = new Uint32Array((xs.length - 1) * (ys.length - 1) * 6);
    let k = 0;
    for (let y = 0; y < ys.length - 1; y += 1) {
      for (let x = 0; x < w - 1; x += 1) {
        const a = y * w + x;
        indices.set([a, a + 1, a + w, a + 1, a + w + 1, a + w], k);
        k += 6;
      }
    }
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions,
    });
    attributes.normal = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: normals,
    });
    attributes.st = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st,
    });
    return new Geometry({
      attributes, indices, primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(Array.from(positions)),
    });
  }

  /** Edges of the cut and depth ticks down its south-west corner. */
  private frame(cut: Cut): void {
    this.edges.removeAll();
    this.labels.removeAll();
    const top = this.heightOf(cut.top);
    const bottom = this.heightOf(cut.bottom);
    const edge = Color.WHITE.withAlpha(0.55);
    const along = (lon0: number, lat0: number, lon1: number, lat1: number, h: number) => {
      const steps = 48;
      const pts = [];
      for (let i = 0; i <= steps; i += 1) {
        const f = i / steps;
        pts.push(Cartesian3.fromDegrees(wrap(lon0 + (lon1 - lon0) * f), lat0 + (lat1 - lat0) * f, h));
      }
      this.edges.add({ positions: pts, width: 1.5, material: Material.fromType("Color", { color: edge }) });
    };
    for (const h of [top, bottom]) {
      along(cut.lon0, cut.lat0, cut.lon1, cut.lat0, h);
      along(cut.lon0, cut.lat1, cut.lon1, cut.lat1, h);
      along(cut.lon0, cut.lat0, cut.lon0, cut.lat1, h);
      along(cut.lon1, cut.lat0, cut.lon1, cut.lat1, h);
    }
    for (const [lon, lat] of [[cut.lon0, cut.lat0], [cut.lon1, cut.lat0], [cut.lon0, cut.lat1],
                              [cut.lon1, cut.lat1]]) {
      this.edges.add({
        positions: [Cartesian3.fromDegrees(wrap(lon), lat, bottom),
                    Cartesian3.fromDegrees(wrap(lon), lat, top)],
        width: 1.5, material: Material.fromType("Color", { color: edge }),
      });
    }

    const s = this.style!;
    // Ticks are depths in metres, placed through the depth axis, never voxel indices.
    for (const d of depthTicks(cut.top, cut.bottom, s.axis)) {
      const h = this.heightOf(d);
      this.labels.add({
        position: Cartesian3.fromDegrees(wrap(cut.lon0), cut.lat0, h),
        text: `${d.toLocaleString()} m`,
        font: "500 12px system-ui, sans-serif",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.8),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.RIGHT,
        verticalOrigin: VerticalOrigin.CENTER,
        pixelOffset: new Cartesian2(-8, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      this.edges.add({
        positions: [Cartesian3.fromDegrees(wrap(cut.lon0), cut.lat0, h),
                    Cartesian3.fromDegrees(wrap(cut.lon0 - (cut.lon1 - cut.lon0) * 0.015),
                                           cut.lat0, h)],
        width: 1.5, material: Material.fromType("Color", { color: edge }),
      });
    }
  }

  /**
   * What is under a screen position, if it is on the cube: the place and depth in the
   * data's coordinates. Picks the depth buffer, so it is the face actually seen.
   */
  probe(position: Cartesian2): { lon: number; lat: number; depth: number } | undefined {
    if (!this.data || !this.cut || !this.primitives.length) return undefined;
    const picked = this.scene.pick(position);
    if (!picked || !this.primitives.includes(picked.primitive)) return undefined;
    const world = this.scene.pickPosition(position);
    if (!world) return undefined;
    const c = Cartographic.fromCartesian(world);
    let lon = CesiumMath.toDegrees(c.longitude);
    if (this.cut.lon1 > 180 && lon < this.cut.lon0) lon += 360;
    return { lon, lat: CesiumMath.toDegrees(c.latitude), depth: this.depthOf(c.height) };
  }

  /** Centre and size of the cube, for aiming the camera. */
  extent(): { lon: number; lat: number; widthM: number; heightM: number; mid: number } {
    const cut = this.cut!;
    const lat = (cut.lat0 + cut.lat1) / 2;
    const widthM = Math.max((cut.lon1 - cut.lon0) * 111_320 * Math.cos(lat * Math.PI / 180),
                            (cut.lat1 - cut.lat0) * 110_574);
    return { lon: (cut.lon0 + cut.lon1) / 2, lat, widthM, heightM: this.height,
             mid: this.base + this.height / 2 };
  }
}

/** Longitudes past 180 (a box across the antimeridian) back into -180..180 for Cesium. */
function wrap(lon: number): number {
  return lon > 180 ? lon - 360 : lon;
}
