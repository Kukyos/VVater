/**
 * VVater — 3D ocean data viewer.
 *
 * Wires the volume, the observation overlay and the profile chart onto one Cesium globe.
 * Everything scientific happens on the server; this file is presentation and state.
 */

import {
  Cartesian3,
  Cartographic,
  Color,
  ImageryLayer,
  Ion,
  Math as CesiumMath,
  Color as CesiumColor,
  Rectangle,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SingleTileImageryProvider,
  TileMapServiceImageryProvider,
} from "@cesium/engine";
import { Viewer } from "@cesium/widgets";
import "@cesium/widgets/Source/widgets.css";

import * as api from "./api";
import type { Meta, VolumeMeta } from "./api";
import {
  DEFAULT_PALETTE_FOR, PALETTES, byId, logScaleAllowed, renderLegend, symmetricRange,
} from "./colorbar";
import { StreamlineLayer } from "./streamlines";
import { captionFor, drawProfile } from "./profile";
import { Graphics, TIER_ORDER, type TierName } from "./settings";
import { demo as sectionDemo, sectionCanvas, surfaceCanvas } from "./section";
import { FlightCamera, OrbitCamera, demo as cameraDemo, typingInto } from "./camera";
import { SimpleUI } from "./simple";
import { ChatPanel } from "./chat";
import {
  EMPTY_SENTINEL, OPACITY_REFERENCE_DEPTH_M, OceanVoxelProvider, addVolume, applyRamp,
  makeOceanShader,
} from "./voxels";

// Cesium Ion is not used: no token, no account, no network dependency on a third party
// at demo time. Imagery falls back to a plain ellipsoid if the offline tiles are absent,
// which is fine — the data is the point, not the basemap.
Ion.defaultAccessToken = "";

type Layer = "field" | "residual";

/**
 * Three ways to look at the same data. The region view is where the work happens; the
 * map is the depth slice as a flat section (the volume itself is 3D-only in Cesium);
 * the globe puts the region in context. Each has its own zoom limit, because in the
 * region view there is no reason to be able to pull back into space.
 */
type ViewName = "region" | "map" | "globe" | "fly";
const ALL_VIEWS: ViewName[] = ["region", "map", "globe", "fly"];

interface State {
  meta: Meta;
  /** "field" is the analysis itself; "residual" is observed minus modelled (N4). */
  layer: Layer;
  showCurrents: boolean;
  depthIndex: number;
  playing: boolean;
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
  view: ViewName;
  /** Simple: the whole ocean, one surface layer. Advanced: the Bay volume and instruments. */
  mode: "simple" | "advanced";
  /** The loaded volume's channels, kept for the 2D section. */
  values?: Float32Array;
  errors?: Float32Array | null;
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const status = (message: string, kind: "info" | "busy" | "warn" | "error" = "info") => {
  const node = el("status");
  node.textContent = message;
  node.dataset.kind = kind;
};

async function main(): Promise<void> {
  status("contacting the API…", "busy");
  const meta = await api.getMeta();
  if (import.meta.env.DEV) {
    sectionDemo();
    cameraDemo();
  }

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
    // No default base layer. Left out, the Viewer adds Ion world imagery, which with no
    // token never loads: the globe then never reports its tiles loaded and requests a
    // frame forever, so render-on-demand rendered continuously at idle (and the console
    // carried a RequestErrorEvent nobody had traced). The offline basemap is added below.
    baseLayer: false,
  });
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.baseColor = CesiumColor.fromCssColorString("#0b2942");

  // The volume lives BELOW the sea surface, so an opaque globe hides all of it — the
  // first working build rendered a perfect volume that nobody could see. Making the
  // surface translucent is what turns a globe into something you can look into, and it
  // is the single control that makes a depth-resolved field legible at all.
  viewer.scene.globe.translucency.enabled = true;
  viewer.scene.globe.translucency.frontFaceAlpha = 0.25;
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
  let basemap: ImageryLayer | undefined;
  try {
    basemap = viewer.imageryLayers.addImageryProvider(
      await TileMapServiceImageryProvider.fromUrl("/cesium/Assets/Textures/NaturalEarthII"),
    );
    // Dimmed: at full brightness the pale shelf seas of Natural Earth show through the
    // translucent surface and wash the volume out to beige.
    basemap.brightness = 0.55;
  } catch (error) {
    // A dark ocean blue beats pure black: without it a globe with no imagery is
    // indistinguishable from a globe that failed to render at all.
    viewer.scene.globe.baseColor = CesiumColor.fromCssColorString("#0b2942");
    status(`offline basemap unavailable (${(error as Error).message})`, "warn");
  }

  const [lon0, lon1] = meta.region.lon;
  const [lat0, lat1] = meta.region.lat;
  // Translucent only over the volume. A see-through surface everywhere turned the rest
  // of the ocean, and the global temperature layer drawn on it, to a dim wash.
  viewer.scene.globe.translucency.rectangle = Rectangle.fromDegrees(lon0 - 0.5, lat0 - 0.5, lon1 + 0.5, lat1 + 0.5);

  // An oblique home view, because a volume seen straight down is just a map. The orbit
  // camera aims at the box centre, so no look-ahead offset is needed any more.
  const PITCH = -48;
  const HEIGHT = 1_750_000;
  const centreLon = (lon0 + lon1) / 2;
  const centreLat = (lat0 + lat1) / 2;

  // Region and Fly are driven by our own cameras (camera.ts); Globe and Map keep Cesium's.
  const bounds = { lon: [lon0, lon1] as [number, number], lat: [lat0, lat1] as [number, number] };
  const orbit = new OrbitCamera(viewer, bounds, {
    lon: centreLon, lat: centreLat, heading: 0,
    pitch: CesiumMath.toRadians(PITCH), range: HEIGHT / Math.sin(CesiumMath.toRadians(-PITCH)),
  }, () => graphics.kick(250));
  const flight = new FlightCamera(viewer, {
    // Steep enough to read the colours: at a glancing angle the volume's opacity integrates
    // along a very long path and the whole field turns one flat haze.
    lat: lat0 - 1.5, lon: centreLon - 2, heading: 12, height: 90_000, speed: 25_000, look: -40,
  }, (f) => {
    graphics.kick(120);
    renderFlightHud(f);
  });

  /** The home camera of each view. Zoom limits are per view and reset on every switch. */
  function homeCamera(view: ViewName): void {
    const controller = viewer.scene.screenSpaceCameraController;
    if (view === "region") {
      orbit.reset();
    } else if (view === "fly") {
      flight.disable();
      flight.enable();
    } else if (view === "map") {
      controller.maximumZoomDistance = 9_000_000;
      viewer.camera.setView({
        destination: Rectangle.fromDegrees(lon0 - 3, lat0 - 2, lon1 + 3, lat1 + 2),
      });
    } else {
      // Straight down from far enough that the whole disk fits the viewport.
      controller.maximumZoomDistance = 40_000_000;
      viewer.camera.setView({
        // Further out in Simple: no docks, a taller viewport, and the whole disk is the picture.
        destination: Cartesian3.fromDegrees(centreLon, centreLat,
          state.mode === "simple" ? 20_000_000 : 12_500_000),
        orientation: { heading: 0, pitch: CesiumMath.toRadians(-90), roll: 0 },
      });
    }
  }

  const state: State = {
    meta,
    layer: "field",
    // Opens on structure rather than on the sea surface: at 5 m the whole Bay is 28-30 degC,
    // the pale end of the ramp, and the first thing anyone saw was a beige slab. A slice
    // in the upper thermocline, with the currents at that depth, shows why this is 3D.
    showCurrents: true,
    depthIndex: 4,
    playing: false,
    variable: "temperature",
    source: meta.defaultSource,
    timeIndex: Math.floor(meta.times.length / 2),
    paletteId: DEFAULT_PALETTE_FOR.temperature,
    reversed: false,
    logScale: false,
    opacity: 0.5,
    exaggeration: 40,
    errorWeight: 1,
    isoBand: 0,
    isoValue: 20,
    range: [0, 30],
    view: "region",
    mode: "advanced",
  };

  let primitive: ReturnType<typeof addVolume> | undefined;
  let shader: ReturnType<typeof makeOceanShader> | undefined;
  const streamlineLayer = new StreamlineLayer(viewer.scene);

  // Render-on-demand plus a quality tier (settings.ts). Any control the user touches
  // asks for a frame; camera movement already does on its own.
  const graphics = new Graphics(viewer);
  graphics.apply();
  orbit.enable();
  for (const type of ["input", "change", "click"]) {
    document.addEventListener(type, () => graphics.kick(), true);
  }

  /**
   * The depth slice cuts the volume: everything shallower than the slice is clipped
   * away, so its top face is a horizontal section at that depth. The slider used to
   * move only the streamlines, so with currents off it did nothing at all, and the
   * brief asks for depth-slice views by name. Clipping is a bounds change, not a
   * reload, so it follows the slider live.
   */
  function applySlice(): void {
    if (!primitive) return;
    const top = primitive.maxBounds;
    const depth = state.depthIndex === 0 ? -top.z / state.exaggeration : sliceDepth();
    primitive.maxClippingBounds = new Cartesian3(top.x, top.y, -depth * state.exaggeration);
    graphics.kick();
    renderHud();
  }

  /** The depth the slice slider points at, always through the grid (hard rule 4). */
  const sliceDepth = (): number => {
    const depths = state.volumeMeta?.provenance.depth_grid.depths_m ?? [0];
    return depths[Math.min(state.depthIndex, depths.length - 1)] ?? 0;
  };

  /**
   * Currents exist only in Copernicus; the INCOIS Argo analyses carry no u/v at all
   * (docs/03-limitations.md L4). Rather than hide the control, it says why when the
   * current source cannot answer.
   */
  // The same ticket pattern as the volume. Without it a slow response for an old depth
  // could land after a newer one, or after the box was unticked, and either redraw stale
  // lines or leave none: the "sometimes they never load" report.
  let streamTicket = 0;
  let streamData: api.Streamlines | undefined;
  /** The slice depth the current lines were asked for. */
  let streamAskedFor: number | undefined;

  /**
   * Refetch when the slice has moved by any route other than the slider: the 20 degC
   * preset, a source switch (a different depth grid), a variable change. Only the
   * slider refetched, so after the preset the lines stayed at 92 m, buried inside the
   * volume under a label that said 5 m.
   */
  function refreshStreamlinesIfStale(): void {
    if (state.showCurrents && streamAskedFor !== sliceDepth()) void loadStreamlines();
  }

  /** Put the lines at their depth in the current exaggeration. No request. */
  function placeStreamlines(): void {
    if (!state.showCurrents || !streamData || state.mode === "simple") {
      streamlineLayer.hide();
      return;
    }
    // Placed at the native GLORYS level the server actually integrated, the nearest
    // one to the slice, not at the slice itself: the two grids differ, and drawing
    // one depth's currents at another's height is a raw-index-as-depth bug.
    const height = state.view === "map" ? 0 : -streamData.depth_m * state.exaggeration;
    streamlineLayer.show(streamData, height);
    graphics.kick(1500);
  }

  async function loadStreamlines(): Promise<void> {
    const ticket = ++streamTicket;
    if (!state.showCurrents) {
      streamlineLayer.hide();
      graphics.kick();
      return;
    }
    status("integrating streamlines…", "busy");
    streamAskedFor = sliceDepth();
    let data: api.Streamlines | undefined;
    let failure: Error | undefined;
    // One retry: the first request after start-up can race the server's own first read
    // of the Copernicus file.
    for (let attempt = 0; attempt < 2 && !data; attempt += 1) {
      try {
        data = await api.getStreamlines("glorys12", 0, sliceDepth());
      } catch (error) {
        failure = error as Error;
      }
    }
    if (ticket !== streamTicket || !state.showCurrents) return;
    if (!data) {
      streamData = undefined;
      streamlineLayer.hide();
      status(`currents unavailable: ${failure?.message}`, "warn");
      return;
    }
    streamData = data;
    placeStreamlines();
    status(`${data.count} streamlines at ${data.depth_m.toFixed(0)} m (nearest GLORYS12 ` +
      `level) · ${data.note}`);
  }

  // Loads can overlap (a slider dragged fast, play, a source switch mid-load). Each one
  // takes a ticket and only the newest may touch the scene; otherwise a slow response
  // for an older step lands last and shows stale data under the newest date label.
  let loadTicket = 0;

  async function loadVolume(): Promise<void> {
    const ticket = ++loadTicket;
    status(state.layer === "residual" ? "co-locating casts…" : "loading volume…", "busy");

    const isResidual = state.layer === "residual";
    const volumeMeta = isResidual
      ? await api.getResidualMeta(state.variable, state.source, meta.demoDate)
      : await api.getVolumeMeta(state.variable, state.source, state.timeIndex);
    state.volumeMeta = volumeMeta;

    const [nx, ny, nz] = volumeMeta.dimensions;
    const { values, errors } = isResidual
      ? await api.getResidualData(state.variable, state.source, meta.demoDate, nx * ny * nz)
      : await api.getVolumeData(
          state.variable, state.source, state.timeIndex, nx * ny * nz, volumeMeta.hasError);
    if (ticket !== loadTicket) return;

    // A residual is signed, so its range is forced symmetric about zero and its palette
    // is diverging. Anything else puts the neutral colour at an arbitrary value.
    state.range = isResidual
      ? symmetricRange(volumeMeta.valueRange[0], volumeMeta.valueRange[1])
      : ([...volumeMeta.valueRange] as [number, number]);
    // Keep the isosurface where the user put it if it is still inside the new range;
    // otherwise recentre. Resetting it on every timestep made play wipe the 20 °C preset.
    if (!(state.isoValue >= state.range[0] && state.isoValue <= state.range[1])) {
      state.isoValue = (state.range[0] + state.range[1]) / 2;
    }

    // The old volume stays on screen until the new one has its data on the GPU, then
    // goes. Removing it first blanked the ocean for a few frames on every timestep,
    // which during playback read as flicker.
    const previous = primitive;
    const channel = isResidual
      ? values.map((v) => (Number.isNaN(v) ? EMPTY_SENTINEL : v))
      : values;
    state.values = channel;
    state.errors = errors;
    const provider = new OceanVoxelProvider(volumeMeta, channel, errors, state.exaggeration);
    shader = makeOceanShader(volumeMeta, state.paletteId, state.reversed);
    primitive = addVolume(viewer.scene, provider, shader);
    // Cesium's voxels are 3D-only; the map shows the section instead.
    primitive.show = state.view !== "map" && state.mode === "advanced";
    // Nearest, not interpolated, for the residual: its filled bins sit among empty (NaN)
    // ones, and interpolating toward a NaN neighbour turns most of a bin into NaN, so
    // each measurement rendered as a sliver. A bin is a bin; it should look like one.
    primitive.nearestSampling = isResidual;
    applySlice();
    applyUniforms();
    if (previous) {
      let removed = false;
      const drop = () => {
        if (removed) return;
        removed = true;
        viewer.scene.primitives.remove(previous);
        graphics.kick();
      };
      primitive.allTilesLoaded.addEventListener(drop);
      window.setTimeout(drop, 1500); // in case the event never fires for a one-tile volume
    }
    graphics.kick(2000);
    syncControls();

    renderLegendStrip();
    renderProvenance(volumeMeta);
    // A rebuild can change the exaggeration the lines were placed for, and a new grid
    // can change the depth the slice index points at.
    placeStreamlines();
    refreshStreamlinesIfStale();
    void renderSection();
    void renderGlobal();
    renderHud();

    const residualStats = volumeMeta.provenance.residual;
    status(
      residualStats
        ? `${residualStats.casts} casts vs analysis steps ` +
          `${residualStats.analysis_steps.join(" and ")} · ${residualStats.cells_filled} of ` +
          `${residualStats.cells_total} cells have an observation ` +
          `(${residualStats.coverage_percent}%) · bias ${residualStats.bias.toFixed(2)}, ` +
          `rmse ${residualStats.rmse.toFixed(2)}`
        : `${volumeMeta.provenance.source} · ${volumeMeta.provenance.time.slice(0, 10)} · ` +
          `${nx}x${ny}x${nz} voxels`,
    );

    // Prefetch the next step so scrubbing and playback do not stall on the network.
    // The responses are cacheable, so this is a warm cache rather than a second copy.
    void prefetch(state.timeIndex + 1);
  }

  /** Warm the HTTP cache for a timestep without using the result. */
  async function prefetch(index: number): Promise<void> {
    if (state.layer !== "field" || index < 0 || index >= meta.times.length) return;
    // A GLORYS step is a live Copernicus download (tens of seconds, ~8 MB). Prefetching
    // it speculatively is how the cache was corrupted once; it loads only when asked.
    if (state.source === "glorys12") return;
    try {
      const m = await api.getVolumeMeta(state.variable, state.source, index);
      const [nx, ny, nz] = m.dimensions;
      await api.getVolumeData(state.variable, state.source, index, nx * ny * nz, m.hasError);
    } catch {
      // A failed prefetch is not an error the user needs to see; the real load will
      // report it if the step is genuinely unavailable.
    }
  }

  function applyUniforms(): void {
    if (!shader) return;
    shader.setUniform("u_opacity", state.opacity);
    shader.setUniform("u_logScale", state.logScale ? 1 : 0);
    shader.setUniform("u_errorWeight", state.errorWeight);
    shader.setUniform("u_isoBand", state.isoBand);
    shader.setUniform("u_isoValue", state.isoValue);
    shader.setUniform("u_range", { x: state.range[0], y: state.range[1] } as never);
    shader.setUniform("u_refLength", OPACITY_REFERENCE_DEPTH_M * state.exaggeration);
    // The residual is not a medium, it is one bin per place somebody measured, 95% of
    // cells empty. Per-metre opacity (right for a continuous field) left a single bin
    // almost invisible, so the layer the whole finding rests on vanished. Each filled
    // bin draws as a block at the chosen opacity instead.
    shader.setUniform("u_perCell", state.layer === "residual" ? 1 : 0);
    graphics.kick();
    scheduleSection();
  }

  /**
   * Every control whose limits depend on the loaded volume, set from it after each load.
   * These were set once at startup, so after switching to salinity the Min/Max boxes
   * and the isosurface slider still spanned temperature values.
   */
  function syncControls(): void {
    const [lo, hi] = state.range;
    el<HTMLInputElement>("range-min").value = lo.toFixed(1);
    el<HTMLInputElement>("range-max").value = hi.toFixed(1);
    const iso = el<HTMLInputElement>("iso");
    iso.min = String(lo);
    iso.max = String(hi);
    iso.step = String(Math.max((hi - lo) / 200, 0.001));
    iso.value = String(state.isoValue);
    el("iso-label").textContent = state.isoValue.toFixed(1);
    const depths = state.volumeMeta?.provenance.depth_grid.depths_m ?? [0];
    const slice = el<HTMLInputElement>("slice");
    slice.max = String(depths.length - 1);
    state.depthIndex = Math.min(state.depthIndex, depths.length - 1);
    slice.value = String(state.depthIndex);
    el("slice-label").textContent = `${sliceDepth().toFixed(0)} m`;
  }

  function setPalette(): void {
    if (!shader) return;
    applyRamp(shader, state.paletteId, state.reversed);
    renderLegendStrip();
    scheduleSection();
  }

  // ---- views ------------------------------------------------------------

  /**
   * The depth slice as a flat image, for the map view. Rebuilt from memory whenever the
   * slice, palette, range or data changes, and only while the map is showing.
   */
  let sectionLayer: ImageryLayer | undefined;
  let sectionTicket = 0;
  let sectionTimer: number | undefined;

  /** Both surface images follow the palette and range; debounced so a drag stays smooth. */
  function scheduleSection(): void {
    window.clearTimeout(sectionTimer);
    sectionTimer = window.setTimeout(() => {
      void renderSection();
      void renderGlobal();
    }, 80);
  }

  /**
   * Whole-Earth surface layers (server/ocean/globalsurface.py). In Advanced they are the
   * surface temperature around the Bay, on the field's own colour scale, for the date the
   * time slider is on, fading out before the box so the surface gives way to the volume
   * instead of meeting it at a hard line. In Simple they are the whole picture, each layer
   * on its own scale, with land drawn flat from the data's own mask.
   */
  type GlobalData = Awaited<ReturnType<typeof api.getGlobalSurface>>;
  let globalLayer: ImageryLayer | undefined;
  let lastGlobal: GlobalData["meta"] | undefined;
  let globalTicket = 0;
  let globalDays: string[] = [];
  const globalCache = new Map<string, Promise<GlobalData>>();
  const LAND: [number, number, number] = [0.84, 0.86, 0.89];

  function loadGlobal(layer: string, day: string): Promise<GlobalData> {
    const key = `${layer}|${day}`;
    let entry = globalCache.get(key);
    if (!entry) {
      entry = api.getGlobalSurface(layer, day);
      entry.catch(() => globalCache.delete(key));
      globalCache.set(key, entry);
      // 3.9 MB each; twenty covers a layer's whole timeline plus a spare.
      while (globalCache.size > 20) globalCache.delete(globalCache.keys().next().value!);
    }
    return entry;
  }

  function clearGlobal(): void {
    if (globalLayer) viewer.imageryLayers.remove(globalLayer);
    globalLayer = undefined;
    lastGlobal = undefined;
  }

  async function renderGlobal(): Promise<void> {
    const ticket = ++globalTicket;
    const m = state.volumeMeta;
    let layer: string;
    let day: string;
    if (state.mode === "simple" && simple) {
      layer = simple.layer;
      day = simple.day;
    } else {
      const date = meta.times[state.timeIndex].slice(0, 10);
      // In Map 2D too: the section fills the box, the world's surface surrounds it.
      const wanted = el<HTMLInputElement>("global-sst").checked &&
        state.layer === "field" && state.variable === "temperature" && !!m &&
        globalDays.includes(date);
      if (!wanted) {
        clearGlobal();
        renderHud();
        return;
      }
      layer = "temperature";
      day = date;
    }
    const pending = !globalCache.has(`${layer}|${day}`);
    if (pending) status(`loading the global ${layer.replace("_", " ")} layer for ${day}…`, "busy");
    let data: GlobalData;
    try {
      data = await loadGlobal(layer, day);
    } catch (error) {
      if (ticket === globalTicket) {
        status(`global layer unavailable: ${(error as Error).message}`, "warn");
      }
      return;
    }
    if (ticket !== globalTicket) return;
    const g = data.meta;
    const simpleMode = state.mode === "simple";
    const canvas = simpleMode
      ? surfaceCanvas(data.values, g.dimensions[0], g.dimensions[1], g.lonRange, g.latRange, {
          paletteId: g.palette, reversed: false, range: g.valueRange, logScale: false,
          errorWeight: 0, blocky: false,
        }, { land: LAND })
      : surfaceCanvas(data.values, g.dimensions[0], g.dimensions[1], g.lonRange, g.latRange, {
          paletteId: state.paletteId, reversed: state.reversed, range: state.range,
          logScale: state.logScale, errorWeight: 0, blocky: false,
        // 5 degrees in 3D, where the surface gives way to a volume seen at an angle; 1 on
        // the map, which frames the box with only a few degrees to spare.
        }, { hole: { lon: m!.lonRange, lat: m!.latRange },
             featherDeg: state.view === "map" ? 1 : 5 });
    const provider = await SingleTileImageryProvider.fromUrl(canvas.toDataURL(), {
      rectangle: Rectangle.fromDegrees(g.lonRange[0], g.latRange[0], g.lonRange[1], g.latRange[1]),
    });
    if (ticket !== globalTicket) return;
    const previous = globalLayer;
    globalLayer = viewer.imageryLayers.addImageryProvider(provider);
    globalLayer.alpha = simpleMode ? 1 : 0.9;
    lastGlobal = g;
    if (previous) viewer.imageryLayers.remove(previous);
    if (simpleMode) simple?.legend(g);
    if (pending) status(`${g.title} · ${g.provenance.day} · ${g.provenance.source}`);
    renderHud();
    graphics.kick(800);
    // Warm the next date so playback does not wait on the network.
    const next = globalDays[(globalDays.indexOf(day) + 1) % globalDays.length];
    if (next) void loadGlobal(layer, next).catch(() => undefined);
  }

  async function renderSection(): Promise<void> {
    const ticket = ++sectionTicket;
    const m = state.volumeMeta;
    if (state.view !== "map" || !m || !state.values) {
      if (sectionLayer) viewer.imageryLayers.remove(sectionLayer);
      sectionLayer = undefined;
      return;
    }
    const canvas = sectionCanvas(state.values, state.errors ?? null, m.dimensions,
      state.depthIndex, {
        paletteId: state.paletteId, reversed: state.reversed, range: state.range,
        logScale: state.logScale, errorWeight: state.errorWeight,
        blocky: state.layer === "residual",
      });
    const provider = await SingleTileImageryProvider.fromUrl(canvas.toDataURL(), {
      rectangle: Rectangle.fromDegrees(m.lonRange[0], m.latRange[0], m.lonRange[1], m.latRange[1]),
    });
    if (ticket !== sectionTicket) return;
    const previous = sectionLayer;
    sectionLayer = viewer.imageryLayers.addImageryProvider(provider);
    sectionLayer.alpha = 0.92;
    if (previous) viewer.imageryLayers.remove(previous);
    graphics.kick(800);
  }
  const VIEW_TITLES: Record<ViewName, string> = {
    region: "Region 3D", map: "Map 2D · horizontal section", globe: "Globe", fly: "Fly",
  };

  /** The flight instruments: what a pilot needs, and nothing implying real aircraft. */
  function renderFlightHud(f: { lat: number; lon: number; heading: number; height: number;
                                speed: number; look: number }): void {
    const ns = f.lat >= 0 ? "N" : "S";
    const ew = f.lon >= 0 ? "E" : "W";
    el("flight-hud").innerHTML =
      `<div><span>ALT</span><b>${(f.height / 1000).toFixed(0)} km</b></div>` +
      `<div><span>GS</span><b>${(f.speed / 1000).toFixed(1)} km/s</b></div>` +
      `<div><span>HDG</span><b>${f.heading.toFixed(0).padStart(3, "0")}°</b></div>` +
      `<div><span>POS</span><b>${Math.abs(f.lat).toFixed(2)}°${ns} ${Math.abs(f.lon).toFixed(2)}°${ew}</b></div>` +
      `<p>W/S speed · A/D turn · R/F altitude (${FlightCamera.MIN_HEIGHT / 1000}–${FlightCamera.MAX_HEIGHT / 1000} km) · ↑/↓ look · drag to steer · P pause</p>`;
  }

  function renderHud(): void {
    if (!state.volumeMeta) return;
    // The residual pools casts around the demo date against the analysis steps either
    // side of it; label it with exactly those, not with the whole data window.
    const res = state.volumeMeta.provenance.residual;
    const when = state.layer === "residual" && res
      ? `${res.casts} casts near ${meta.demoDate} vs analysis ${res.analysis_steps.join(" & ")}`
      : meta.times[state.timeIndex].slice(0, 10);
    const g = state.mode === "advanced" && lastGlobal?.provenance;
    el("hud").innerHTML = [
      `<b>${VIEW_TITLES[state.view]}</b> · ${state.variable}` +
        (state.layer === "residual" ? " · residual, observed − analysis" : ""),
      `${when} · slice ${sliceDepth().toFixed(0)} m` +
        (state.view === "map" ? "" : ` · vertical ×${state.exaggeration}`),
      g ? `around the box: sea-surface temperature only, GLORYS12 1/4°, ${g.level_m} m, ` +
        `${g.day}, same colour scale, fading out before the volume` : "",
    ].filter(Boolean).join("<br>");
  }

  function waitForMorph(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        viewer.scene.morphComplete.removeEventListener(done);
        resolve();
      };
      viewer.scene.morphComplete.addEventListener(done);
      window.setTimeout(done, 1500);
    });
  }

  async function setView(view: ViewName): Promise<void> {
    state.view = view;
    for (const name of ALL_VIEWS) el(`view-${name}`).classList.toggle("on", name === view);
    el("flight-hud").classList.toggle("hidden", view !== "fly");
    // Hand the camera back to Cesium before anything else touches it.
    if (view !== "region") orbit.disable();
    if (view !== "fly") flight.disable();
    const scene = viewer.scene;
    if (view === "map" && scene.mode !== SceneMode.SCENE2D) {
      // Hidden before the morph, not after: the voxel primitive has no 2D path.
      if (primitive) primitive.show = false;
      const morphed = waitForMorph();
      scene.morphTo2D(0);
      await morphed;
    } else if (view !== "map" && scene.mode !== SceneMode.SCENE3D) {
      const morphed = waitForMorph();
      scene.morphTo3D(0);
      await morphed;
    }
    const advanced = state.mode === "advanced";
    if (primitive) primitive.show = view !== "map" && advanced;
    // A flat map has no underside to look through, so the surface goes opaque there; the
    // Simple globe has no volume under it to see.
    scene.globe.translucency.enabled =
      view !== "map" && advanced && scene.globe.translucency.frontFaceAlpha < 1;
    homeCamera(view);
    if (view === "region") orbit.enable();
    placeStreamlines();
    await renderSection();
    await renderGlobal();
    renderHud();
    graphics.kick(1500);
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
      ...(p.horizontal_block && p.horizontal_block > 1
        ? [`horizontal: ${p.horizontal_block}x${p.horizontal_block} block mean of the native grid, for display`]
        : []),
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
        // On the sea surface, where the cast was. They sat 20 km up to clear the volume,
        // which in Fly put every float at cruising altitude beside the plane. Depth
        // testing is off instead, so the translucent surface never hides them.
        position: Cartesian3.fromDegrees(obs.lon, obs.lat, 0),
        point: {
          pixelSize: obs.kind === "glider" ? 7 : 9,
          // Colour carries meaning, not decoration: gliders differ from floats, and a
          // cast whose QC was never run is visibly not the same as one that passed.
          color: obs.kind === "text"
            ? Color.fromCssColorString("#ff7bd5")
            : obs.kind === "glider"
              ? (unevaluated ? Color.fromCssColorString("#c9a227") : Color.fromCssColorString("#7ee787"))
              : Color.fromCssColorString("#4dd2ff"),
          outlineColor: Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { observation: obs, platform: obs.platform } as never,
      });
    }

    const argo = observations.filter((o) => o.kind === "argo").length;
    const glider = observations.filter((o) => o.kind === "glider").length;
    const text = observations.length - argo - glider;
    el("obs-count").textContent = `${argo} Argo · ${glider} glider casts` +
      (text ? ` · ${text} uploaded` : "");
    graphics.kick(1000);
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

  // Clicking a second float before the first profile arrived could draw the first one
  // under the second one's name. Same ticket as the volume.
  let profileTicket = 0;

  async function showProfile(platform: string): Promise<void> {
    const ticket = ++profileTicket;
    el("profile-panel").classList.remove("hidden");
    el("profile-empty").style.display = "none";
    setDock("right", true);
    el("profile-title").textContent = platform;
    el("profile-caption").textContent = "loading…";

    try {
      const profile = await api.getProfile(platform, state.meta.demoDate, state.variable);
      if (ticket !== profileTicket) return;
      drawProfile(
        el<HTMLCanvasElement>("profile-chart"),
        profile,
        state.volumeMeta?.provenance.units ?? "",
      );
      el("profile-caption").textContent = captionFor(profile);
    } catch (error) {
      if (ticket !== profileTicket) return;
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

  // Driven off PALETTES rather than a hardcoded list: adding "balance" for residuals
  // left it out of the dropdown, so the residual layer selected a palette that was not
  // an option and the control went blank.
  for (const palette of PALETTES) {
    const option = document.createElement("option");
    option.value = palette.id;
    option.textContent = palette.label;
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
    viewer.scene.globe.translucency.enabled = alpha < 1 && state.view !== "map";
    graphics.kick();
  });

  bind("global-sst", "change", () => void renderGlobal());

  bind("basemap", "input", (node) => {
    const brightness = Number(node.value) / 100;
    el("basemap-label").textContent = brightness.toFixed(2);
    if (basemap) basemap.brightness = brightness;
    graphics.kick();
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
    setPlaying(false);
    state.timeIndex = Number(timeSlider.value);
    el("time-label").textContent = meta.times[state.timeIndex].slice(0, 10);
    await loadVolume();
  });

  // ---- time animation --------------------------------------------------

  let timer: number | undefined;
  const FRAME_MS = 900;

  // Each frame is scheduled only after the previous load finished. A fixed interval
  // (the first version) fired regardless, so a slow step stacked requests and frames
  // could arrive out of order.
  async function step(): Promise<void> {
    state.timeIndex = (state.timeIndex + 1) % meta.times.length;
    timeSlider.value = String(state.timeIndex);
    el("time-label").textContent = meta.times[state.timeIndex].slice(0, 10);
    try {
      await loadVolume();
    } catch (error) {
      setPlaying(false);
      status((error as Error).message, "error");
      return;
    }
    if (state.playing) timer = window.setTimeout(() => { void step(); }, FRAME_MS);
  }

  function setPlaying(on: boolean): void {
    state.playing = on;
    el("play").textContent = on ? "❚❚ Pause" : "▶ Play";
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (on) timer = window.setTimeout(() => { void step(); }, FRAME_MS);
  }

  el("play").addEventListener("click", () => setPlaying(!state.playing));

  // ---- layers and presets ----------------------------------------------

  el("layer-field").addEventListener("click", () => void setLayer("field"));
  el("layer-residual").addEventListener("click", () => void setLayer("residual"));

  async function setLayer(layer: Layer): Promise<void> {
    state.layer = layer;
    state.paletteId = layer === "residual"
      ? DEFAULT_PALETTE_FOR.residual
      : DEFAULT_PALETTE_FOR[state.variable] ?? "thermal";
    paletteSelect.value = state.paletteId;
    el("layer-field").classList.toggle("on", layer === "field");
    el("layer-residual").classList.toggle("on", layer === "residual");

    // The residual pools every cast in a +/-5 day window against whichever analysis step
    // is nearest each one, so it has no single timestep. Leaving the slider live would
    // let someone move it, see nothing change, and reasonably conclude it was broken.
    const isResidual = layer === "residual";
    timeSlider.disabled = isResidual;
    el<HTMLButtonElement>("play").disabled = isResidual;
    if (isResidual) setPlaying(false);
    try {
      await loadVolume();
    } catch (error) {
      status((error as Error).message, "error");
    }
  }

  bind("currents", "change", (node) => {
    state.showCurrents = node.checked;
    void loadStreamlines();
  });

  // Streamlines are integrated on the server, so they refetch when the slider is let
  // go rather than on every pixel of the drag.
  bind("slice", "change", () => {
    if (state.showCurrents) void loadStreamlines();
  });

  bind("slice", "input", (node) => {
    state.depthIndex = Number(node.value);
    // Always through the grid, never the raw index: the axis is stretched (L2).
    el("slice-label").textContent = `${sliceDepth().toFixed(0)} m`;
    applySlice();
    scheduleSection();
  });

  /**
   * The 20 degC isotherm: the standard proxy for the heat available to a tropical
   * cyclone. The isosurface control could always do this; naming it is the difference
   * between a generic slider and the thing this theme is actually about.
   */
  el("preset-d20").addEventListener("click", () => {
    // The isotherm sits in the upper couple of hundred metres, and the depth slice clips
    // everything shallower than itself; left deep, the slice hid the very surface this
    // preset exists to show, and the button looked broken.
    state.depthIndex = 0;
    el<HTMLInputElement>("slice").value = "0";
    el("slice-label").textContent = `${sliceDepth().toFixed(0)} m`;
    applySlice();
    state.isoValue = 20;
    // 1.2 degC half-width: at 0.6 the shell was thinner than one 1-degree cell and read
    // as a faint line.
    state.isoBand = 1.2;
    el<HTMLInputElement>("iso").value = "20";
    el<HTMLInputElement>("iso-band").value = "12";
    el("iso-label").textContent = "20.0";
    el("iso-band-label").textContent = "1.2";
    applyUniforms();
    refreshStreamlinesIfStale();
    status("20 °C isotherm — the depth of this surface is tropical cyclone heat potential");
  });

  /**
   * N5, the teaching pair. Both lines are computed from the volume on screen: the first
   * version said "4 km deep and 2000 km wide", and neither number was what was drawn
   * (the volume is 5-2000 m; the box is about 2,400 km across).
   */
  function shapeLine(): string {
    const m = state.volumeMeta;
    if (!m) return "";
    const [lon0, lon1] = m.lonRange;
    const [lat0, lat1] = m.latRange;
    const midLat = CesiumMath.toRadians((lat0 + lat1) / 2);
    const widthKm = (lon1 - lon0) * 111.32 * Math.cos(midLat);
    const depthM = m.depthRange[1] - m.depthRange[0];
    const ratio = Math.round((widthKm * 1000) / depthM);
    return `${depthM.toFixed(0)} m of water under ${widthKm.toFixed(0)} km of sea: ` +
      `1 part in ${ratio.toLocaleString()}`;
  }

  async function setExaggeration(x: number): Promise<void> {
    state.exaggeration = x;
    el<HTMLInputElement>("exaggeration").value = String(x);
    el("exaggeration-label").textContent = `${x}x`;
    await loadVolume();
  }

  el("preset-truescale").addEventListener("click", async () => {
    await setExaggeration(1);
    status(`True scale. ${shapeLine()}. The warm water a cyclone draws on is a skin ` +
      "on top of that film.");
  });

  el("preset-readable").addEventListener("click", async () => {
    await setExaggeration(40);
    status(`Stretched 40 times vertically, so the layers can be read. The real shape: ` +
      `${shapeLine()}.`);
  });

  el("close-profile").addEventListener("click", () => {
    el("profile-panel").classList.add("hidden");
    el("profile-empty").style.display = "";
  });

  // ---- uploaded casts ----------------------------------------------------

  /**
   * A cast file from any instrument that writes a table: CTD, a ship's log, an ERDDAP
   * CSV export. Parsed on the server (textcast.py), drawn with every other observation,
   * co-located on click. Unevaluated by construction, and the marker colour says so.
   */
  async function addCasts(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      status(`reading ${file.name}…`);
      try {
        const result = await api.uploadCasts(file);
        await loadObservations();
        status(`${result.name}: ${result.casts} casts, ${result.levels} levels · ` +
          `unevaluated · ${result.notes.join("; ")}`);
      } catch (error) {
        status(`${file.name}: ${(error as Error).message}`, "error");
      }
    }
  }

  const castInput = el<HTMLInputElement>("cast-file");
  el("add-casts").addEventListener("click", () => castInput.click());
  castInput.addEventListener("change", () => {
    if (castInput.files?.length) void addCasts(castInput.files);
    castInput.value = "";
  });
  // Dropping a file anywhere on the page does the same thing.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files.length) void addCasts(event.dataTransfer.files);
  });

  // ---- graphics panel ---------------------------------------------------

  function syncGraphicsPanel(): void {
    const q = graphics.quality;
    el<HTMLSelectElement>("gfx-tier").value = graphics.auto ? "auto" : graphics.tier;
    el<HTMLSelectElement>("gfx-msaa").value = String(q.msaa);
    el<HTMLInputElement>("gfx-fxaa").checked = q.fxaa;
    el<HTMLInputElement>("gfx-resolution").value = String(Math.round(q.resolution * 100));
    el("gfx-resolution-label").textContent = `${Math.round(q.resolution * 100)}%`;
    el<HTMLInputElement>("gfx-sky").checked = q.sky;
    el<HTMLInputElement>("gfx-ondemand").checked = q.onDemand;
    el<HTMLInputElement>("gfx-fps").checked = q.showFps;
    if (!graphics.auto) {
      el("gfx-status").textContent = graphics.tier === "custom"
        ? "custom settings"
        : `${graphics.tier} (chosen manually)`;
    }
  }

  function bindGraphicsPanel(): void {

    el<HTMLSelectElement>("gfx-tier").addEventListener("change", async (event) => {
      const value = (event.target as HTMLSelectElement).value;
      if (value === "auto") {
        await graphics.autoTune((m) => { el("gfx-status").textContent = m; }, true);
      } else if ((TIER_ORDER as string[]).includes(value)) {
        graphics.setTier(value as TierName);
      }
      syncGraphicsPanel();
    });

    const custom = (patch: Parameters<Graphics["setCustom"]>[0]) => {
      graphics.setCustom(patch);
      syncGraphicsPanel();
    };
    bind("gfx-msaa", "change", (n) => custom({ msaa: Number(n.value) as 1 | 2 | 4 }));
    bind("gfx-fxaa", "change", (n) => custom({ fxaa: n.checked }));
    bind("gfx-resolution", "change", (n) => custom({ resolution: Number(n.value) / 100 }));
    bind("gfx-sky", "change", (n) => custom({ sky: n.checked }));
    bind("gfx-ondemand", "change", (n) => custom({ onDemand: n.checked }));
    bind("gfx-fps", "change", (n) => custom({ showFps: n.checked }));
    el("gfx-measure").addEventListener("click", async () => {
      el("gfx-status").textContent = "measuring…";
      const fps = await graphics.measure(2000);
      el("gfx-status").textContent = `${fps.toFixed(0)} fps rendering continuously`;
    });
    syncGraphicsPanel();
  }

  // ---- modes ---------------------------------------------------------------

  let simple: SimpleUI | undefined;

  /**
   * Simple is the whole ocean on a globe, one layer at a time, for a first look or an
   * exhibition screen. Advanced is the Bay's volume with every instrument. They share one
   * scene, so switching hides one set of primitives and shows the other; every loader keeps
   * its ticket, so a response for the mode just left cannot draw into this one.
   */
  async function setMode(mode: "simple" | "advanced"): Promise<void> {
    if (mode === "simple" && !simple) {
      status("the Simple view needs the global layers, which are unavailable", "warn");
      mode = "advanced";
    }
    state.mode = mode;
    app.classList.toggle("simple", mode === "simple");
    el("mode-simple").classList.toggle("on", mode === "simple");
    el("mode-advanced").classList.toggle("on", mode === "advanced");
    try {
      localStorage.setItem("vvater.mode", mode);
    } catch {
      // Storage unavailable: the mode still switches, it is just not remembered.
    }
    simple?.setPlaying(false);
    setPlaying(false);
    // Simple draws land from the data's own mask; the blurry basemap would sit under it.
    if (basemap) basemap.show = mode === "advanced";
    // The ground haze washes a surface field towards white; Simple is all surface field.
    graphics.apply();
    if (mode === "simple") viewer.scene.globe.showGroundAtmosphere = false;
    viewer.entities.show = mode === "advanced";
    clearGlobal();
    placeChat();
    await setView(mode === "simple" ? "globe" : "region");
    viewer.resize();
  }

  // ---- assistant ----------------------------------------------------------

  /** What the assistant is told the user is looking at, so "here" and "this" resolve. */
  const chatContext = () => {
    const c = viewer.camera.positionCartographic;
    return {
      mode: state.mode,
      view: state.view,
      variable: state.variable,
      layer: state.layer,
      source: state.source,
      analysis_step: meta.times[state.timeIndex].slice(0, 10),
      slice_depth_m: Math.round(sliceDepth()),
      open_profile: el("profile-panel").classList.contains("hidden")
        ? null : el("profile-title").textContent,
      simple_layer: simple?.layer,
      simple_day: simple?.day,
      camera: {
        lat: +CesiumMath.toDegrees(c.latitude).toFixed(2),
        lon: +CesiumMath.toDegrees(c.longitude).toFixed(2),
        height_km: Math.round(c.height / 1000),
      },
    };
  };

  const assistant = new ChatPanel({
    context: chatContext,
    apply: async (a) => {
      // Checked again here: the browser applies only what it recognises, clamped.
      const clamp = (v: number | undefined, lo: number, hi: number) =>
        Math.min(Math.max(Number(v), lo), hi);
      const advanced = async () => { if (state.mode === "simple") await setMode("advanced"); };
      if (a.action === "set_mode" && (a.mode === "simple" || a.mode === "advanced")) {
        await setMode(a.mode);
      } else if (a.action === "set_view" && ALL_VIEWS.includes(a.view as ViewName)) {
        await advanced();
        await setView(a.view as ViewName);
      } else if (a.action === "set_layer" && (a.layer === "field" || a.layer === "residual")) {
        await advanced();
        await setLayer(a.layer);
      } else if (a.action === "set_global_layer" && simple && a.layer) {
        if (state.mode === "advanced") await setMode("simple");
        document.querySelector<HTMLButtonElement>(
          `#s-layers button[data-layer="${CSS.escape(a.layer)}"]`)?.click();
      } else if (a.action === "set_depth") {
        await advanced();
        const depths = state.volumeMeta?.provenance.depth_grid.depths_m ?? [];
        const want = clamp(a.depth_m, 0, 2000);
        // The nearest level of the grid, never a raw index (hard rule 4).
        let best = 0;
        depths.forEach((d, i) => {
          if (Math.abs(d - want) < Math.abs(depths[best] - want)) best = i;
        });
        const slider = el<HTMLInputElement>("slice");
        slider.value = String(best);
        slider.dispatchEvent(new Event("input"));
        slider.dispatchEvent(new Event("change"));
      } else if (a.action === "fly_to") {
        const lat = clamp(a.lat, -80, 80);
        const lon = clamp(a.lon, -180, 180);
        if (state.mode === "simple") {
          viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, 9_000_000) });
        } else {
          if (state.view !== "region") await setView("region");
          orbit.lookAt(lon, lat, 900_000);
        }
      } else if (a.action === "open_profile" && a.platform) {
        await advanced();
        await showProfile(a.platform);
      } else if (a.action === "isotherm_20") {
        await advanced();
        el("preset-d20").click();
      }
    },
  });

  /** One panel, moved to wherever the current mode keeps it. */
  function placeChat(): void {
    el(state.mode === "simple" ? "s-chat" : "chat-dock").append(assistant.root);
  }
  el("s-ask").addEventListener("click", () => el("s-chat").classList.toggle("hidden"));

  el("mode-simple").addEventListener("click", () => void setMode("simple"));
  el("mode-advanced").addEventListener("click", () => void setMode("advanced"));
  el("s-dive").addEventListener("click", () => void setMode("advanced"));

  // ---- workspace: docks, views, keys, cursor ------------------------------


  const app = el("app");
  function setDock(side: "left" | "right", open?: boolean): void {
    const cls = `${side}-closed`;
    const closed = open === undefined ? !app.classList.contains(cls) : !open;
    app.classList.toggle(cls, closed);
    try {
      localStorage.setItem(`vvater.dock.${side}`, closed ? "closed" : "open");
    } catch {
      // Storage unavailable: the dock still toggles, it is just not remembered.
    }
  }
  for (const side of ["left", "right"] as const) {
    try {
      if (localStorage.getItem(`vvater.dock.${side}`) === "closed") setDock(side, false);
    } catch {
      // Storage unavailable: docks open.
    }
  }
  document.querySelectorAll<HTMLElement>("[data-dock]").forEach((node) => {
    node.addEventListener("click", () => setDock(node.dataset.dock as "left" | "right"));
  });
  // The canvas follows its grid cell. Render-on-demand would not redraw on a resize by
  // itself, so a retracted dock left the old frame stretched until the next input.
  new ResizeObserver(() => {
    viewer.resize();
    graphics.kick(300);
  }).observe(el("view"));

  for (const name of ALL_VIEWS) {
    el(`view-${name}`).addEventListener("click", () => void setView(name));
  }
  el("reset-view").addEventListener("click", () => {
    homeCamera(state.view);
    graphics.kick();
  });

  window.addEventListener("keydown", (event) => {
    // Any field that takes typing, including the assistant's text box: digits typed into
    // a question must not switch views, and WASD must not fly the plane.
    if (typingInto(event.target)) return;
    const views: Record<string, ViewName> = { "1": "region", "2": "map", "3": "globe", "4": "fly" };
    if (views[event.key]) void setView(views[event.key]);
    else if (event.key.toLowerCase() === "p" && state.view === "fly") flight.paused = !flight.paused;
    else if (event.key === "[") setDock("left");
    else if (event.key === "]") setDock("right");
    else if (event.key === "Home") {
      homeCamera(state.view);
      graphics.kick();
    }
  });

  // Longitude and latitude under the cursor, like any GIS or 3D package's status bar.
  handler.setInputAction((movement: { endPosition: unknown }) => {
    const point = viewer.camera.pickEllipsoid(movement.endPosition as never);
    if (!point) {
      el("cursor-pos").textContent = "";
      return;
    }
    const c = Cartographic.fromCartesian(point);
    const lat = CesiumMath.toDegrees(c.latitude);
    const lon = CesiumMath.toDegrees(c.longitude);
    el("cursor-pos").textContent = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}  ` +
      `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
  }, ScreenSpaceEventType.MOUSE_MOVE);

  // Dev-only handle. Voxel rendering fails silently far more often than it throws, so
  // being able to poke at the primitive from the console is worth one line.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).vvater = {
      viewer, state, graphics, getPrimitive: () => primitive, getShader: () => shader,
      setView, setDock, showProfile, setLayer, homeCamera, setMode, getSimple: () => simple,
      orbit, flight,
    };
  }

  try {
    await loadVolume();
    // loadVolume already fetched the streamlines for the opening slice.
    el<HTMLInputElement>("currents").checked = state.showCurrents;
    await loadObservations();
    bindGraphicsPanel();
    try {
      const catalogue = await api.getGlobalLayers();
      globalDays = catalogue.days;
      simple = new SimpleUI(catalogue.layers, catalogue.days, meta.demoDate, () => renderGlobal());
    } catch (error) {
      status(`global layers unavailable: ${(error as Error).message}`, "warn");
    }
    // A first visit opens on the Simple globe; a returning visitor gets the mode they left
    // in. ?mode=advanced in the address overrides both.
    let startMode: string | null = new URLSearchParams(location.search).get("mode");
    try {
      startMode ??= localStorage.getItem("vvater.mode");
    } catch {
      // Storage unavailable: first-visit behaviour.
    }
    await setMode(startMode === "advanced" ? "advanced" : "simple");
    // Tuned against the real scene, after the volume is on screen. A saved manual
    // choice is respected; "auto" re-measures every start, because the same browser
    // profile can be on a laptop's integrated GPU today and a monitor tomorrow.
    if (graphics.auto) {
      await graphics.autoTune((m) => { el("gfx-status").textContent = m; });
      syncGraphicsPanel();
    }
  } catch (error) {
    status((error as Error).message, "error");
    throw error;
  }
}

main().catch((error) => {
  status(`${error}`, "error");
  console.error(error);
});
