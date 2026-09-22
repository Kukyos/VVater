/**
 * VVater — 3D ocean data viewer.
 *
 * Wires the volume, the observation overlay and the profile chart onto one Cesium globe.
 * Everything scientific happens on the server; this file is presentation and state.
 */

import {
  Cartesian3,
  Color,
  Ion,
  Math as CesiumMath,
  Color as CesiumColor,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
} from "@cesium/engine";
import { Viewer } from "@cesium/widgets";
import "@cesium/widgets/Source/widgets.css";

import * as api from "./api";
import type { Meta, VolumeMeta } from "./api";
import { DEFAULT_PALETTE_FOR, byId, logScaleAllowed, renderLegend } from "./colorbar";
import { captionFor, drawProfile } from "./profile";
import { OceanVoxelProvider, addVolume, applyRamp, makeOceanShader } from "./voxels";

// Cesium Ion is not used: no token, no account, no network dependency on a third party
// at demo time. Imagery falls back to a plain ellipsoid if the offline tiles are absent,
// which is fine — the data is the point, not the basemap.
Ion.defaultAccessToken = "";

interface State {
  meta: Meta;
  variable: string;
  source: string;
  timeIndex: number;
  paletteId: string;
  reversed: boolean;
  logScale: boolean;
  opacity: number;
  exaggeration: number;
  errorWeight: number;
  isoBand: number;
  isoValue: number;
  range: [number, number];
  volumeMeta?: VolumeMeta;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const status = (message: string, kind: "info" | "warn" | "error" = "info") => {
  const node = el("status");
  node.textContent = message;
  node.dataset.kind = kind;
};

async function main(): Promise<void> {
  status("contacting the API…");
  const meta = await api.getMeta();

  const viewer = new Viewer("globe", {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    fullscreenButton: false,
  });
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.baseColor = CesiumColor.fromCssColorString("#0b2942");

  // The volume lives BELOW the sea surface, so an opaque globe hides all of it — the
  // first working build rendered a perfect volume that nobody could see. Making the
  // surface translucent is what turns a globe into something you can look into, and it
  // is the single control that makes a depth-resolved field legible at all.
  viewer.scene.globe.translucency.enabled = true;
  viewer.scene.globe.translucency.frontFaceAlpha = 0.38;
  // Looking up from beneath the surface should show the water, not a flat fill colour.
  viewer.scene.globe.undergroundColor = CesiumColor.fromCssColorString("#05131f");
  // Without this the camera stops at the surface and cannot be flown into the column.
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.show = true;
  }

  // Natural Earth II ships inside @cesium/engine and is copied next to the bundle by
  // vite.config.ts, so the basemap needs no Ion token, no account and no network. The
  // brief asks for deployment on INCOIS infrastructure with no client-side dependencies;
  // a viewer that needs a third-party tile server at demo time does not meet that.
  try {
    viewer.imageryLayers.addImageryProvider(
      await TileMapServiceImageryProvider.fromUrl("/cesium/Assets/Textures/NaturalEarthII"),
    );
  } catch (error) {
    // A dark ocean blue beats pure black: without it a globe with no imagery is
    // indistinguishable from a globe that failed to render at all.
    viewer.scene.globe.baseColor = CesiumColor.fromCssColorString("#0b2942");
    status(`offline basemap unavailable (${(error as Error).message})`, "warn");
  }

  const [lon0, lon1] = meta.region.lon;
  const [lat0, lat1] = meta.region.lat;

  // An oblique view, because a volume seen straight down is just a map. The offset is
  // computed rather than guessed: at pitch p and height h the camera looks at a point
  // h / tan(|p|) metres in front of it, so to centre the region the camera has to sit
  // that far south of it. Two earlier hand-picked pairs both ended up staring at Tibet.
  const PITCH = -35;
  const HEIGHT = 1_200_000;
  const METRES_PER_DEGREE = 111_320;
  const lookAheadDegrees =
    HEIGHT / Math.tan(CesiumMath.toRadians(Math.abs(PITCH))) / METRES_PER_DEGREE;

  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(
      (lon0 + lon1) / 2,
      (lat0 + lat1) / 2 - lookAheadDegrees,
      HEIGHT,
    ),
    orientation: { heading: 0, pitch: CesiumMath.toRadians(PITCH), roll: 0 },
  });

  const state: State = {
    meta,
    variable: "temperature",
    source: meta.defaultSource,
    timeIndex: Math.floor(meta.times.length / 2),
    paletteId: DEFAULT_PALETTE_FOR.temperature,
    reversed: false,
    logScale: false,
    opacity: 0.35,
    exaggeration: 40,
    errorWeight: 1,
    isoBand: 0,
    isoValue: 20,
    range: [0, 30],
  };

  let primitive: ReturnType<typeof addVolume> | undefined;
  let shader: ReturnType<typeof makeOceanShader> | undefined;

  async function loadVolume(): Promise<void> {
    status("loading volume…");
    const volumeMeta = await api.getVolumeMeta(state.variable, state.source, state.timeIndex);
    state.volumeMeta = volumeMeta;

    const [nx, ny, nz] = volumeMeta.dimensions;
    const { values, errors } = await api.getVolumeData(
      state.variable, state.source, state.timeIndex, nx * ny * nz, volumeMeta.hasError,
    );

    state.range = [...volumeMeta.valueRange] as [number, number];
    state.isoValue = (state.range[0] + state.range[1]) / 2;

    if (primitive) {
      viewer.scene.primitives.remove(primitive);
    }

    const provider = new OceanVoxelProvider(volumeMeta, values, errors, state.exaggeration);
    shader = makeOceanShader(volumeMeta, state.paletteId, state.reversed);
    primitive = addVolume(viewer.scene, provider, shader);
    applyUniforms();

    renderLegendStrip();
    renderProvenance(volumeMeta);
    status(
      `${volumeMeta.provenance.source} · ${volumeMeta.provenance.time.slice(0, 10)} · ` +
      `${nx}x${ny}x${nz} voxels`,
    );
  }

  function applyUniforms(): void {
    if (!shader) return;
    shader.setUniform("u_opacity", state.opacity);
    shader.setUniform("u_logScale", state.logScale ? 1 : 0);
    shader.setUniform("u_errorWeight", state.errorWeight);
    shader.setUniform("u_isoBand", state.isoBand);
    shader.setUniform("u_isoValue", state.isoValue);
    shader.setUniform("u_range", { x: state.range[0], y: state.range[1] } as never);
  }

  function setPalette(): void {
    if (!shader) return;
    applyRamp(shader, state.paletteId, state.reversed);
    renderLegendStrip();
  }

  function renderLegendStrip(): void {
    const host = el("legend-strip");
    host.replaceChildren(renderLegend(byId(state.paletteId), state.reversed, 240, 12));
    el("legend-min").textContent = state.range[0].toFixed(1);
    el("legend-max").textContent = state.range[1].toFixed(1);
    el("legend-units").textContent = state.volumeMeta?.provenance.units ?? "";
    el("palette-note").textContent = byId(state.paletteId).note ?? "";
  }

  function renderProvenance(volumeMeta: VolumeMeta): void {
    const p = volumeMeta.provenance;
    const lines = [
      `source: ${p.source}`,
      `variable: ${p.variable} (${p.standard_name}), ${p.units}`,
      `depth grid: ${p.depth_grid.levels} levels, ${p.depth_grid.stretch}`,
      p.range_test.checked
        ? `range test: ${p.range_test.failed} of ${p.range_test.checked_cells} cells fail` +
          (p.masked_cells ? ` — ${p.masked_cells} masked from the render` : "")
        : "range test: not applicable",
      ...p.cf_assumptions.map((a) => `assumed: ${a}`),
    ];
    el("provenance").textContent = lines.join("\n");
  }

  // ---- observations ---------------------------------------------------

  async function loadObservations(): Promise<void> {
    viewer.entities.removeAll();
    const { observations } = await api.getObservations(state.meta.demoDate, state.variable);

    // A float can surface more than once inside a +/-5 day window, and a glider emits
    // a cast every few hours, so the platform id is NOT unique here. Cesium throws on a
    // duplicate entity id, which is the correct behaviour and was how this surfaced.
    const seen = new Map<string, number>();

    for (const obs of observations) {
      const unevaluated = obs.dataMode === "U";
      const repeat = seen.get(obs.platform) ?? 0;
      seen.set(obs.platform, repeat + 1);
      const entityId = repeat === 0 ? obs.platform : `${obs.platform}@${obs.time}`;

      viewer.entities.add({
        id: entityId,
        position: Cartesian3.fromDegrees(obs.lon, obs.lat, 20_000),
        point: {
          pixelSize: obs.kind === "glider" ? 7 : 9,
          // Colour carries meaning, not decoration: gliders differ from floats, and a
          // cast whose QC was never run is visibly not the same as one that passed.
          color: obs.kind === "glider"
            ? (unevaluated ? Color.fromCssColorString("#c9a227") : Color.fromCssColorString("#7ee787"))
            : Color.fromCssColorString("#4dd2ff"),
          outlineColor: Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
        },
        properties: { observation: obs, platform: obs.platform } as never,
      });
    }

    const argo = observations.filter((o) => o.kind === "argo").length;
    const glider = observations.length - argo;
    el("obs-count").textContent = `${argo} Argo · ${glider} glider casts`;
  }

  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction(async (movement: { position: unknown }) => {
    const picked = viewer.scene.pick(movement.position as never);
    const entity = picked?.id;
    if (!entity?.id) return;
    // Entity ids are made unique for repeat casts; the API wants the platform.
    const platform = entity.properties?.platform?.getValue?.() ?? String(entity.id).split("@")[0];
    await showProfile(String(platform));
  }, ScreenSpaceEventType.LEFT_CLICK);

  async function showProfile(platform: string): Promise<void> {
    const panel = el("profile-panel");
    panel.classList.remove("hidden");
    el("profile-title").textContent = platform;
    el("profile-caption").textContent = "loading…";

    try {
      const profile = await api.getProfile(platform, state.meta.demoDate, state.variable);
      drawProfile(
        el<HTMLCanvasElement>("profile-chart"),
        profile,
        state.volumeMeta?.provenance.units ?? "",
      );
      el("profile-caption").textContent = captionFor(profile);
    } catch (error) {
      el("profile-caption").textContent = `could not load: ${(error as Error).message}`;
    }
  }

  // ---- controls -------------------------------------------------------

  const bind = (id: string, event: string, fn: (node: HTMLInputElement) => void) => {
    const node = el<HTMLInputElement>(id);
    node.addEventListener(event, () => fn(node));
    return node;
  };

  const variableSelect = el<HTMLSelectElement>("variable");
  const sourceSelect = el<HTMLSelectElement>("source");
  const paletteSelect = el<HTMLSelectElement>("palette");
  const timeSlider = el<HTMLInputElement>("time");

  for (const source of meta.sources) {
    const option = document.createElement("option");
    option.value = source.key;
    option.textContent = source.needsCredentials
      ? `${source.title} (needs credentials)`
      : source.title;
    sourceSelect.append(option);
  }
  sourceSelect.value = state.source;

  function refreshVariables(): void {
    const source = meta.sources.find((s) => s.key === state.source);
    variableSelect.replaceChildren();
    for (const name of source?.variables ?? []) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      variableSelect.append(option);
    }
    if (!source?.variables.includes(state.variable)) {
      // Prefer temperature on a source switch rather than whatever sorts first, which
      // would drop a user coming back from the observation-density layer into salinity.
      state.variable = source?.variables.includes("temperature")
        ? "temperature"
        : source?.variables[0] ?? "temperature";
      state.paletteId = DEFAULT_PALETTE_FOR[state.variable] ?? state.paletteId;
      paletteSelect.value = state.paletteId;
    }
    variableSelect.value = state.variable;
  }
  refreshVariables();

  for (const palette of ["thermal", "haline", "viridis", "grey"]) {
    const option = document.createElement("option");
    option.value = palette;
    option.textContent = byId(palette).label;
    paletteSelect.append(option);
  }
  paletteSelect.value = state.paletteId;

  timeSlider.max = String(meta.times.length - 1);
  timeSlider.value = String(state.timeIndex);
  el("time-label").textContent = meta.times[state.timeIndex].slice(0, 10);

  sourceSelect.addEventListener("change", async () => {
    state.source = sourceSelect.value;
    refreshVariables();
    try {
      await loadVolume();
    } catch (error) {
      status((error as Error).message, "error");
    }
  });

  variableSelect.addEventListener("change", async () => {
    state.variable = variableSelect.value;
    state.paletteId = DEFAULT_PALETTE_FOR[state.variable] ?? state.paletteId;
    paletteSelect.value = state.paletteId;
    await loadVolume();
    await loadObservations();
  });

  paletteSelect.addEventListener("change", () => {
    state.paletteId = paletteSelect.value;
    setPalette();
  });

  bind("reverse", "change", (node) => {
    state.reversed = node.checked;
    setPalette();
  });

  bind("log", "change", (node) => {
    const allowed = logScaleAllowed(state.range[0]);
    if (node.checked && !allowed.ok) {
      node.checked = false;
      status(allowed.reason ?? "log scale unavailable", "warn");
      return;
    }
    state.logScale = node.checked;
    applyUniforms();
  });

  bind("opacity", "input", (node) => {
    state.opacity = Number(node.value) / 100;
    el("opacity-label").textContent = state.opacity.toFixed(2);
    applyUniforms();
  });

  bind("sea-surface", "input", (node) => {
    const alpha = Number(node.value) / 100;
    el("sea-surface-label").textContent = alpha.toFixed(2);
    viewer.scene.globe.translucency.frontFaceAlpha = alpha;
    // Fully opaque means the translucency pass is wasted work, so turn it off entirely.
    viewer.scene.globe.translucency.enabled = alpha < 1;
  });

  bind("error-weight", "input", (node) => {
    state.errorWeight = Number(node.value) / 100;
    el("error-weight-label").textContent = state.errorWeight.toFixed(2);
    applyUniforms();
  });

  bind("iso", "input", (node) => {
    state.isoValue = Number(node.value);
    el("iso-label").textContent = state.isoValue.toFixed(1);
    applyUniforms();
  });

  bind("iso-band", "input", (node) => {
    state.isoBand = Number(node.value) / 10;
    el("iso-band-label").textContent = state.isoBand === 0 ? "off" : state.isoBand.toFixed(1);
    applyUniforms();
  });

  bind("range-min", "change", (node) => {
    state.range = [Number(node.value), state.range[1]];
    applyUniforms();
    renderLegendStrip();
  });

  bind("range-max", "change", (node) => {
    state.range = [state.range[0], Number(node.value)];
    applyUniforms();
    renderLegendStrip();
  });

  // Vertical exaggeration changes the voxel bounds, so it rebuilds the provider rather
  // than setting a uniform. Cheap, because the data is already in memory.
  bind("exaggeration", "change", async (node) => {
    state.exaggeration = Number(node.value);
    el("exaggeration-label").textContent = `${state.exaggeration}x`;
    await loadVolume();
  });

  timeSlider.addEventListener("change", async () => {
    state.timeIndex = Number(timeSlider.value);
    el("time-label").textContent = meta.times[state.timeIndex].slice(0, 10);
    await loadVolume();
  });

  el("close-profile").addEventListener("click", () => {
    el("profile-panel").classList.add("hidden");
  });

  // Dev-only handle. Voxel rendering fails silently far more often than it throws, so
  // being able to poke at the primitive from the console is worth one line.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).vvater = {
      viewer, state, getPrimitive: () => primitive, getShader: () => shader,
    };
  }

  try {
    await loadVolume();
    await loadObservations();
    el("range-min").setAttribute("value", state.range[0].toFixed(1));
    el("range-max").setAttribute("value", state.range[1].toFixed(1));
    el<HTMLInputElement>("iso").min = String(state.range[0]);
    el<HTMLInputElement>("iso").max = String(state.range[1]);
    el<HTMLInputElement>("iso").value = String(state.isoValue);
    el("iso-label").textContent = state.isoValue.toFixed(1);
  } catch (error) {
    status((error as Error).message, "error");
    throw error;
  }
}

main().catch((error) => {
  status(`${error}`, "error");
  console.error(error);
});
