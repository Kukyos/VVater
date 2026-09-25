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
  IonImageryProvider,
  Math as CesiumMath,
  Color as CesiumColor,
  Rectangle,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  CesiumTerrainProvider,
  DirectionalLight,
  EllipsoidTerrainProvider,
  Matrix4,
  SingleTileImageryProvider,
  SunLight,
  Transforms,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
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
import { ChatPanel } from "./chat";
import { CubeController, formatValue, shiftDay } from "./cube/controller";
import { demo as cubeDataDemo } from "./cube/data";
import { drawColumn } from "./cube/column";
import { OceanLayer } from "./ocean";
import { demo as flowDemo } from "./flow";
import { FishingLayer, PfzMarkers, demo as fishingDemo, describePfz } from "./fishing";
import { Immersive, demo as immersiveDemo } from "./immersive";
import {
  EMPTY_SENTINEL, OPACITY_REFERENCE_DEPTH_M, OceanVoxelProvider, addVolume, applyRamp,
  makeOceanShader,
} from "./voxels";

// Cesium ion is optional. With no VITE_CESIUM_ION_TOKEN at build time nothing touches it
// and the globe is the smooth ellipsoid, as it always was. With one, Fly and immersive get
// Cesium World Terrain: real mountains and coasts. The token ships in the public bundle
// (that is how ion tokens work); it is restricted to this site's URLs in the ion
// dashboard, and visitors need no account.
const ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined)?.trim() ?? "";
Ion.defaultAccessToken = ION_TOKEN;

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
    cubeDataDemo();
    flowDemo();
    fishingDemo();
    immersiveDemo();
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
  // Off until the INCOIS Bay volume is turned on (setView enables it then). On from the
  // start, any failure before the first setView left a dark see-through square over the
  // Bay on a globe that was about the cube.
  viewer.scene.globe.translucency.enabled = false;
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

  // ---- land: sharp relief over the offline base ------------------------------------
  //
  // Natural Earth II is 2,048 pixels round the whole Earth, about 20 km a pixel: from a
  // flight at 50 km the land was a smear. NASA's Blue Marble shaded relief and bathymetry
  // through GIBS goes to about 600 m a pixel, is public domain, needs no key and allows
  // any origin. It is an enhancement, not a dependency: it sits over Natural Earth, and if
  // GIBS cannot be reached the layer removes itself and the offline base is what shows.
  //   grey    -- relief without colour, so the ocean data carries all the colour on screen
  //   colour  -- Blue Marble as it is (immersive always uses this)
  //   offline -- Natural Earth only, no network
  type Land = "grey" | "colour" | "offline";
  let relief: ImageryLayer | undefined;
  let landStyle: Land = "grey";
  let landBrightness = 0.55;
  const reliefProvider = () => new UrlTemplateImageryProvider({
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/" +
      "default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: 8,
    credit: "NASA Blue Marble shaded relief and bathymetry, via NASA GIBS",
  });
  /** Apply a land style, or the immersive override (colour, full brightness). */
  function setLand(style: Land, brightness = landBrightness, keep = true): void {
    if (keep) {
      landStyle = style;
      landBrightness = brightness;
    }
    if (style === "offline") {
      if (relief) viewer.imageryLayers.remove(relief);
      relief = undefined;
    } else if (!relief) {
      const provider = reliefProvider();
      let failures = 0;
      provider.errorEvent.addEventListener(() => {
        failures += 1;
        if (failures === 12 && relief) {
          viewer.imageryLayers.remove(relief);
          relief = undefined;
          status("NASA relief tiles unreachable; showing the offline basemap", "warn");
        }
      });
      relief = new ImageryLayer(provider);
      // Right above the offline base, below every data layer.
      viewer.imageryLayers.add(relief, basemap ? viewer.imageryLayers.indexOf(basemap) + 1 : 0);
    }
    if (relief) {
      relief.saturation = style === "grey" ? 0 : 1;
      relief.contrast = style === "grey" ? 1.15 : 1;
      // The Basemap slider's 0.55 was tuned for Natural Earth's pale shelf seas; the relief
      // is darker, and at the same number it read as mud. Lifted to match.
      relief.brightness = Math.min(brightness * 1.6, 1.2);
    }
    if (basemap) basemap.brightness = brightness;
    graphics.kick(800);
  }

  // ---- terrain: only where the camera is low and the data is not standing on the sea --
  //
  // The cube and the Bay volume sit at sea level on an exact ellipsoid; raised terrain
  // would push through their coastal edges. So the workspace views stay flat and only
  // Fly and immersive, which are about the planet, get the mountains.
  let worldTerrain: Promise<CesiumTerrainProvider> | undefined;
  const flatTerrain = new EllipsoidTerrainProvider();
  let terrainWanted = false;
  let flyImagery: ImageryLayer | undefined;
  async function setTerrain(on: boolean): Promise<void> {
    if (!ION_TOKEN) return;
    terrainWanted = on;
    if (!on) {
      viewer.scene.terrainProvider = flatTerrain;
      if (flyImagery) viewer.imageryLayers.remove(flyImagery, false);
      return;
    }
    worldTerrain ??= CesiumTerrainProvider.fromIonAssetId(1, { requestVertexNormals: true });
    try {
      const provider = await worldTerrain;
      // Left Fly before ion answered: the workspace views stay flat.
      if (!terrainWanted) return;
      viewer.scene.terrainProvider = provider;
      graphics.kick(1500);
      // Aerial imagery with it: the NASA relief stops at ~600 m a pixel, a blur from 20 km.
      // Straight above the base maps, so the ocean colour and every data layer stay on top.
      flyImagery ??= ImageryLayer.fromProviderAsync(IonImageryProvider.fromAssetId(2));
      if (!viewer.imageryLayers.contains(flyImagery)) {
        const under = relief ?? basemap;
        viewer.imageryLayers.add(flyImagery, under ? viewer.imageryLayers.indexOf(under) + 1 : 0);
      }
    } catch (error) {
      worldTerrain = undefined;
      status(`Cesium World Terrain unavailable (${(error as Error).message}); the globe stays smooth`, "warn");
    }
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

  // Fly's sun: azimuth 250 degrees, 30 degrees up, over the Bay's centre. Low enough that
  // slopes facing away fall into shade, high enough that the flat sea stays bright.
  const flightSun = (() => {
    const az = 250 * (Math.PI / 180);
    const el = 30 * (Math.PI / 180);
    const toSun = new Cartesian3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(centreLon, centreLat));
    const direction = Matrix4.multiplyByPointAsVector(enu, Cartesian3.negate(toSun, toSun), new Cartesian3());
    return new DirectionalLight({ direction: Cartesian3.normalize(direction, direction), intensity: 2.2 });
  })();

  // Region and Fly are driven by our own cameras (camera.ts); Globe and Map keep Cesium's.
  const bayBounds = { lon: [lon0, lon1] as [number, number], lat: [lat0, lat1] as [number, number] };
  const bayHome = {
    lon: centreLon, lat: centreLat, heading: 0,
    pitch: CesiumMath.toRadians(PITCH), range: HEIGHT / Math.sin(CesiumMath.toRadians(-PITCH)),
  };
  const orbit = new OrbitCamera(viewer, bayBounds, bayHome, () => graphics.kick(250));
  const flight = new FlightCamera(viewer, {
    // Off Sri Lanka's south coast, low, heading north over its highlands into the Bay: the
    // horizon, the relief and the sea's colour in one frame. From the old 90 km looking
    // 40 degrees down the screen was one flat sheet of ocean colour.
    lat: 5.6, lon: 80.4, heading: 15, height: 18_000, speed: 6_000, look: -16,
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
      controller.maximumZoomDistance = 20_000_000;
      const d = cubeActive() ? cube.data! : undefined;
      const wrapLon = (v: number) => (v > 180 ? v - 360 : v);
      viewer.camera.setView({
        destination: d
          ? Rectangle.fromDegrees(wrapLon(d.west - 3), d.south - 2, wrapLon(d.east + 3), d.north + 2)
          : Rectangle.fromDegrees(lon0 - 3, lat0 - 2, lon1 + 3, lat1 + 2),
      });
    } else {
      // Straight down from far enough that the whole disk fits the viewport.
      controller.maximumZoomDistance = 40_000_000;
      const d = cubeActive() ? cube.data! : undefined;
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(d ? (d.west + d.east) / 2 : centreLon,
          d ? (d.south + d.north) / 2 : centreLat, 12_500_000),
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
  };

  let primitive: ReturnType<typeof addVolume> | undefined;
  let shader: ReturnType<typeof makeOceanShader> | undefined;
  const streamlineLayer = new StreamlineLayer(viewer.scene);
  /**
   * The INCOIS analysis volume, drawn in place under the sea surface, is the v1 view and
   * stays available for the Bay (its residual and co-location are the measured results).
   * It is off by default: the Ocean Cube is the main view, and the two are never shown
   * together, so the colour controls always describe exactly one thing on screen.
   */
  let showBay = false;

  // Render-on-demand plus a quality tier (settings.ts). Any control the user touches
  // asks for a frame; camera movement already does on its own.
  const graphics = new Graphics(viewer);
  graphics.apply();
  // ?land=offline|colour|grey, for links and for checks with no network.
  {
    const q = new URLSearchParams(location.search).get("land");
    const start: Land = q === "offline" || q === "colour" ? q : "grey";
    el<HTMLSelectElement>("land").value = start;
    setLand(start);
  }
  el<HTMLSelectElement>("land").addEventListener("change", (e) =>
    setLand((e.target as HTMLSelectElement).value as Land));
  orbit.enable();
  for (const type of ["input", "change", "click"]) {
    document.addEventListener(type, () => graphics.kick(), true);
  }

  // ---- the Ocean Cube: any water, any day, anywhere (cube/*.ts) -----------------

  const ocean = new OceanLayer(viewer, status, (ms) => graphics.kick(ms));
  ocean.onAirNote = () => {
    el("air-note").textContent = ocean.airOn ? ocean.airNote : "";
  };
  // ?surface=0, ?wind=0, ?cubewind=0 open with a layer off, for links and headless checks.
  {
    const q = new URLSearchParams(location.search);
    const off = (name: string, id: string, set: () => void) => {
      if (q.get(name) === "0") {
        set();
        el<HTMLInputElement>(id).checked = false;
      }
    };
    off("surface", "ocean-surface", () => { ocean.surfaceOn = false; });
    off("wind", "ocean-wind", () => { ocean.windOn = false; });
    off("cubewind", "cube-wind", () => { ocean.cubeWindOn = false; });
    // ?air=1 opens with the winds on (they are off by default).
    if (q.get("air") === "1") {
      ocean.airOn = true;
      el<HTMLInputElement>("ocean-air").checked = true;
    }
  }

  /** The whole ocean follows the cube: its variable, its day, its top face's depth. */
  function refreshOcean(): void {
    if (!cubeActive() || !cube.request || !cube.variable) return;
    // Immersive has its own surface layers and no cube; a cube that finishes loading
    // meanwhile waits for the workspace, which calls this again on exit.
    if (immersive.active) {
      cube.setVisible(false);
      return;
    }
    const top = cube.currentCut()!.top;
    void ocean.showSurface(cube.variable.key, cube.request.day, top, cube.style());
    const d = cube.data!;
    void ocean.showCurrents(cube.request.day, top,
      { west: d.west, east: d.east, south: d.south, north: d.north });
    // Fly hides the cube, and its currents drawn on nothing halved the frame rate.
    if (state.view !== "fly") void ocean.showCubeCurrents(cube.request, top, cube.scene.heightOf(top) + 400);
    void ocean.showAir(cube.request.day).then(() => {
      el("air-note").textContent = ocean.airOn ? ocean.airNote : "";
    });
    void refreshFishing();
  }

  // ---- for fishermen (fishing.ts, server/ocean/fishing.py) -----------------

  const fishing = new FishingLayer(viewer, (ms) => graphics.kick(ms));
  async function refreshFishing(): Promise<void> {
    const on = el<HTMLInputElement>("fish-on").checked;
    const summary = el("fish-summary");
    const list = el("fish-spots");
    if (!on || !cube.request) {
      fishing.clear();
      summary.textContent = "";
      list.replaceChildren();
      el("fish-advisory").textContent = "";
      return;
    }
    summary.textContent = "reading temperature fronts, chlorophyll, waves and wind…";
    let got: api.Fishing | undefined;
    try {
      got = await fishing.show(cube.request, cube.request.day);
    } catch (error) {
      summary.textContent = (error as Error).message;
      return;
    }
    if (!got) return;
    const c = got.counts;
    const pct = (n: number) => `${Math.round(100 * n / Math.max(c.ocean_cells, 1))}%`;
    summary.textContent = `${got.provenance.day}: ${c.zone_cells} likely-zone cells of ` +
      `${c.ocean_cells} (1/4°). Sea state: ${pct(c.stay_in_cells)} stay in, ` +
      `${pct(c.caution_cells)} caution.` +
      (got.provenance.missing.length ? ` Missing: ${got.provenance.missing.join("; ")}.` : "");
    list.replaceChildren(...got.spots.map((spot, i) => {
      const row = document.createElement("div");
      row.className = "spot";
      const ns = spot.lat >= 0 ? "N" : "S";
      const ew = spot.lon >= 0 ? "E" : "W";
      row.innerHTML = `<span><b>${i + 1}. ${Math.abs(spot.lat).toFixed(2)}°${ns} ` +
        `${Math.abs(spot.lon).toFixed(2)}°${ew}</b></span>` +
        `<span class="state ${spot.sea_state.replace(" ", "-")}">${spot.sea_state}</span>` +
        `<span class="hint">front ${spot.front_c_per_100km} °C/100 km · chlorophyll ` +
        `${spot.chlorophyll_mg_m3} mg/m³</span>`;
      const go = document.createElement("button");
      go.className = "btn";
      go.textContent = "Go";
      go.addEventListener("click", () => void flyTo(spot.lon, spot.lat, 350_000));
      row.append(go);
      return row;
    }));
    if (!got.spots.length) list.textContent = "no zone found in this box";
    el("fish-advisory").textContent = got.provenance.not_an_advisory;
  }

  const cube = new CubeController({
    viewer,
    status,
    kick: (ms) => graphics.kick(ms),
    onLoaded: () => {
      syncColourControls();
      renderCubeProvenance();
      syncCubeTimeline();
      renderHud();
      void renderSection();
      refreshOcean();
    },
    aim: () => { if (!immersive.active) void aimAtCube(); },
    // Drawing a box needs the drag for itself. Turning the orbit camera off used to hand
    // the mouse back to Cesium's own controller, so the drag drew and moved the globe.
    navigation: (enabled) => {
      if (state.view === "fly") return false;
      const controller = viewer.scene.screenSpaceCameraController;
      if (enabled) {
        if (state.view === "region") orbit.enable(); else controller.enableInputs = true;
      } else {
        if (state.view === "region") orbit.disable();
        controller.enableInputs = false;
      }
      return true;
    },
  });
  cube.onRepaint = () => {
    renderHud();
    placeMarkers();
    if (state.view === "map") void renderSection();
  };

  /** Orbit the cube's middle, from the south-west, far enough to see all of it. */
  async function aimAtCube(): Promise<void> {
    if (!cube.data) return;
    if (state.view !== "region") await setView("region");
    const e = cube.scene.extent();
    const d = cube.data;
    const span = Math.max(e.widthM, e.heightM);
    orbit.retarget(
      { lon: [d.west, d.east], lat: [d.south, d.north] },
      { lon: e.lon, lat: e.lat, heading: CesiumMath.toRadians(28),
        pitch: CesiumMath.toRadians(-22), range: span * 1.6 },
      { minRange: span * 0.15, maxRange: span * 6, targetHeight: e.mid },
    );
    graphics.kick(1500);
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
    if (!state.showCurrents || !streamData || !showBay) {
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
    if (!showBay) return;
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
    // The INCOIS Bay volume is opt-in ("INCOIS Bay volume"); nothing of it loads before.
    if (!showBay) return;
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
    primitive.show = state.view !== "map" && showBay;
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
    // The colour controls describe the cube while it is on screen; a Bay reload in the
    // background must not overwrite them.
    if (!cubeActive()) {
      el<HTMLInputElement>("range-min").value = lo.toFixed(1);
      el<HTMLInputElement>("range-max").value = hi.toFixed(1);
    }
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
   * Whole-Earth surface temperature (server/ocean/globalsurface.py) around the Bay, on the
   * field's own colour scale, for the date the time slider is on, fading out before the box
   * so the surface gives way to the volume instead of meeting it at a hard line.
   */
  type GlobalData = Awaited<ReturnType<typeof api.getGlobalSurface>>;
  let globalLayer: ImageryLayer | undefined;
  let lastGlobal: GlobalData["meta"] | undefined;
  let globalTicket = 0;
  let globalDays: string[] = [];
  const globalCache = new Map<string, Promise<GlobalData>>();

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
    const layer = "temperature";
    const day = meta.times[state.timeIndex].slice(0, 10);
    // In Map 2D too: the section fills the box, the world's surface surrounds it.
    const wanted = showBay && el<HTMLInputElement>("global-sst").checked &&
      state.layer === "field" && state.variable === "temperature" && !!m &&
      globalDays.includes(day);
    if (!wanted) {
      clearGlobal();
      renderHud();
      return;
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
    const canvas = surfaceCanvas(data.values, g.dimensions[0], g.dimensions[1], g.lonRange,
      g.latRange, {
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
    globalLayer.alpha = 0.9;
    lastGlobal = g;
    if (previous) viewer.imageryLayers.remove(previous);
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
    if (state.view === "map" && cubeActive()) {
      // The cube's top face, flat: the map is the section at the cut's top depth.
      const section = cube.mapSection()!;
      const provider = await SingleTileImageryProvider.fromUrl(section.canvas.toDataURL(), {
        rectangle: Rectangle.fromDegrees(section.west, section.south, section.east, section.north),
      });
      if (ticket !== sectionTicket) return;
      const previous = sectionLayer;
      sectionLayer = viewer.imageryLayers.addImageryProvider(provider);
      if (previous) viewer.imageryLayers.remove(previous);
      graphics.kick(800);
      return;
    }
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
    if (cubeActive() && state.view === "fly") {
      // Fly hides the cube: what is on screen is the whole-ocean layer at the cube's top
      // depth, so that is what is labelled, from that layer's own provenance.
      const s = ocean.surfaceOn ? ocean.surface?.meta : undefined;
      const p = s?.provenance;
      el("hud").innerHTML = p ? [
        `<b>${VIEW_TITLES.fly}</b> · ${p.title}, the colour on the sea` +
          (p.forecast ? ' · <span style="color:var(--warn)">FORECAST</span>' : ""),
        `${p.day} · ${s!.levelM === null ? "surface" : `${Math.round(s!.levelM)} m`} · no vertical stretch`,
        `${p.sources.map((x) => `${x.source}, ${x.era}`).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}` +
          (p.horizontal.block > 1 ? ` · ${p.horizontal.block}:1 block mean for display` : ""),
      ].join("<br>") : `<b>${VIEW_TITLES.fly}</b> · the cube is hidden in Fly; no ocean colour layer is on`;
      return;
    }
    if (cubeActive()) {
      const p = cube.data!.meta.provenance;
      const cut = cube.currentCut()!;
      el("hud").innerHTML = [
        `<b>${VIEW_TITLES[state.view]}</b> · ${p.title}` +
          (p.forecast ? ' · <span style="color:var(--warn)">FORECAST</span>' : ""),
        `${p.day} · ${Math.round(cut.top)}–${Math.round(cut.bottom)} m · ` +
          `${cube.stretched ? "stretched depth" : "linear depth"}` +
          (state.view === "map" ? ` · section at ${Math.round(cut.top)} m`
            : ` · vertical ×${Math.round(cube.scene.exaggeration)}`),
        `${p.sources.map((s) => `${s.source}, ${s.era}`).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}` +
          (p.horizontal.block > 1 ? ` · ${p.horizontal.block}:1 block mean for display` : ""),
      ].join("<br>");
      return;
    }
    if (!state.volumeMeta) return;
    // The residual pools casts around the demo date against the analysis steps either
    // side of it; label it with exactly those, not with the whole data window.
    const res = state.volumeMeta.provenance.residual;
    const when = state.layer === "residual" && res
      ? `${res.casts} casts near ${meta.demoDate} vs analysis ${res.analysis_steps.join(" & ")}`
      : meta.times[state.timeIndex].slice(0, 10);
    const g = lastGlobal?.provenance;
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
    const wasFly = state.view === "fly";
    state.view = view;
    for (const name of ALL_VIEWS) el(`view-${name}`).classList.toggle("on", name === view);
    el("flight-hud").classList.toggle("hidden", view !== "fly");
    // Hand the camera back to Cesium before anything else touches it.
    if (view !== "region") orbit.disable();
    if (view !== "fly") flight.disable();
    // Fly always has a sky, whatever the graphics tier. Leaving Fly puts the tier's own
    // choice back. Immersive turns terrain on itself once it has switched to the globe.
    const fly = view === "fly";
    void setTerrain(fly);
    graphics.forceSky = fly;
    graphics.apply();
    // Fly is about the planet: the relief in colour, as immersive shows it. The workspace's
    // own land style is kept and comes back on the way out.
    if (!immersive.active) setLand(fly && landStyle !== "offline" ? "colour" : landStyle, landBrightness, false);
    // Relief is only visible lit: unlit, terrain is the same flat imagery on a bent sheet.
    // A fixed low afternoon sun from the west-south-west rather than the clock's, which
    // would put the Bay in darkness for half the day.
    viewer.scene.globe.enableLighting = fly;
    viewer.scene.light = fly ? flightSun : new SunLight();
    // In Fly the camera never rests, so pausing the currents on movement would hide them
    // for the whole flight. Drawn from the render instead, as in the cinematic.
    ocean.flow.follow(fly);
    ocean.flow.setShare(fly ? 1 / 3 : 1);
    streamlineLayer.pauseOnMove = graphics.quality.pauseOnMove && !fly;
    graphics.restSharpen = !fly;
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
    if (primitive) primitive.show = view !== "map" && showBay;
    // A flat map has no underside to look through, so the surface goes opaque there. The
    // cube stands on the surface, so only the in-place Bay volume needs a see-through sea.
    scene.globe.translucency.enabled =
      view !== "map" && showBay && scene.globe.translucency.frontFaceAlpha < 1;
    // Fly is the planet with its ocean surface, as immersive is: the cube stands up to
    // 600 km tall at its stretched depth, and a flight capped at 250 km was spent inside it.
    cube.setVisible(!showBay && view !== "map" && !fly);
    ocean.setVisible(!showBay);
    if (!immersive.active) ocean.flow.ignoreHoles = fly;
    if (fly) ocean.dropCubeWind();
    else if (wasFly && !immersive.active) refreshOcean();
    homeCamera(view);
    if (view === "region") orbit.enable();
    placeStreamlines();
    await renderSection();
    await renderGlobal();
    renderHud();
    graphics.kick(1500);
  }

  function renderLegendStrip(): void {
    const c = activeColour();
    const host = el("legend-strip");
    host.replaceChildren(renderLegend(byId(c.paletteId), c.reversed, 240, 12));
    el("legend-min").textContent = formatValue(c.range[0]);
    el("legend-max").textContent = formatValue(c.range[1]);
    el("legend-units").textContent = cubeActive()
      ? `${cube.variable!.units}${c.log ? " · log" : ""}`
      : state.volumeMeta?.provenance.units ?? "";
    el("palette-note").textContent = byId(c.paletteId).note ?? "";
  }

  /** The colour-map controls edit whichever layer is on screen: the cube, or the Bay. */
  const cubeActive = () => !showBay && !!cube.data;
  function activeColour(): { paletteId: string; reversed: boolean; log: boolean;
                             range: [number, number] } {
    return cubeActive() ? cube.colour
      : { paletteId: state.paletteId, reversed: state.reversed, log: state.logScale,
          range: state.range };
  }

  /** Put the active layer's colour state into the controls. */
  function syncColourControls(): void {
    const c = activeColour();
    paletteSelect.value = c.paletteId;
    el<HTMLInputElement>("reverse").checked = c.reversed;
    el<HTMLInputElement>("log").checked = c.log;
    el<HTMLInputElement>("range-min").value = formatValue(c.range[0]);
    el<HTMLInputElement>("range-max").value = formatValue(c.range[1]);
    renderLegendStrip();
  }

  function renderCubeProvenance(): void {
    const p = cube.data!.meta.provenance;
    const lines = [
      ...p.sources.map((s) => `source: ${s.source} (${s.era}${s.forecast ? ", FORECAST" : ""})\n` +
        `  dataset ${s.dataset}, variable ${s.variable} (${s.standard_name}), ${s.units}`),
      p.derived ? `derived from ${p.derived.from.join(" and ")}: ${p.derived.formula}` : "",
      `day: ${p.day}`,
      `depth: ${p.native_levels} native levels; ${p.depth_note}`,
      `faces: ${cube.native ? "native levels, nearest cell" : "interpolated between native levels and cells, for display"}; ` +
        `${cube.stretched ? "depth axis stretched as sqrt(depth)" : "depth axis linear"}`,
      `horizontal: ${p.horizontal.note} (native ${p.horizontal.native_step_deg}°, shown ${p.horizontal.display_step_deg}°)`,
      ...Object.entries(p.range_test).map(([name, t]) => t.checked
        ? `range test (${name}): ${t.failed} of ${t.checked_cells} cells fail ${t.test}` +
          (t.masked_cells ? `; ${t.masked_cells} masked` : "")
        : `range test (${name}): not applicable (${t.reason})`),
      `sea floor: ${p.seafloor}`,
      ...p.cf_assumptions.map((a) => `assumed: ${a}`),
      p.note ? `note: ${p.note}` : "",
    ].filter(Boolean);
    el("provenance").textContent = lines.join("\n");
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
    if (!showBay) return;
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
    placeMarkers();
    graphics.kick(1000);
  }

  /**
   * Where the observation markers go. With the Bay volume: on the sea surface, seen
   * through everything. With the cube: only those inside its footprint, sitting on its
   * top face (the cube's top is the sea surface, lifted), and hidden behind its walls
   * like anything else in the scene. The observations are the Bay's until global Argo
   * is wired (docs/11-deferred.md D-34), so outside the Bay a cube shows none.
   */
  function placeMarkers(): void {
    const onCube = cubeActive();
    const top = onCube ? cube.scene.heightOf(cube.currentCut()!.top) + 1_500 : 0;
    for (const entity of viewer.entities.values) {
      const obs = entity.properties?.observation?.getValue?.() as api.Observation | undefined;
      if (!obs || !entity.point) continue;
      // With the cube, floats come from global Argo as sticks (cube/casts.ts); the Bay's
      // own markers would draw the same floats twice. The Bay glider is not in global
      // Argo, so its casts stay as markers inside the cube's footprint.
      entity.show = !onCube || (obs.kind !== "argo" && cube.contains(obs.lon, obs.lat));
      entity.position = Cartesian3.fromDegrees(obs.lon, obs.lat, top) as never;
      entity.point.disableDepthTestDistance = (onCube ? 0 : Number.POSITIVE_INFINITY) as never;
    }
    graphics.kick(300);
  }

  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction(async (movement: { position: unknown }) => {
    const picked = viewer.scene.pick(movement.position as never);
    const entity = picked?.id;
    const advisory = pfz.pointOf(picked);
    if (advisory) {
      status(describePfz(advisory.pfz, advisory.sector));
      return;
    }
    const cast = cubeActive() ? cube.castLayer.castOf(picked) : undefined;
    if (cast) {
      await showCubeProfile(cast);
      return;
    }
    if (!entity?.id) {
      // Not a float: if it is the cube, pin that place's whole column.
      const hit = cubeActive() ? cube.columnAt(movement.position as never) : undefined;
      if (hit) showColumn(hit);
      return;
    }
    // Entity ids are made unique for repeat casts; the API wants the platform.
    const platform = entity.properties?.platform?.getValue?.() ?? String(entity.id).split("@")[0];
    await showProfile(String(platform));
  }, ScreenSpaceEventType.LEFT_CLICK);

  /** The cube's column at a clicked place, native levels, in the Probe panel. */
  function showColumn(hit: { lon: number; lat: number; column: { depth: number; value: number }[] }): void {
    const chart = el<HTMLCanvasElement>("probe-chart");
    chart.classList.remove("hidden");
    setDock("right", true);
    const v = cube.variable!;
    drawColumn(chart, hit.column, {
      units: v.units, title: `${v.title} at ${Math.abs(hit.lat).toFixed(2)}°${hit.lat >= 0 ? "N" : "S"} ` +
        `${Math.abs(hit.lon > 180 ? hit.lon - 360 : hit.lon).toFixed(2)}°${(hit.lon > 180 ? hit.lon - 360 : hit.lon) >= 0 ? "E" : "W"}`,
      axis: cube.stretched ? "stretched" : "linear",
      bottom: cube.data!.maxDepth, range: cube.colour.range,
      paletteId: cube.colour.paletteId, reversed: cube.colour.reversed,
    });
  }

  /**
   * A float in the cube against the cube's own model, on the float's own day. Same chart
   * and caption as the Bay's profiles; the caption names the model it compared with,
   * because in the Bay the old panel compared with INCOIS and this one with Copernicus.
   */
  async function showCubeProfile(cast: api.CubeCast): Promise<void> {
    const ticket = ++profileTicket;
    el("profile-panel").classList.remove("hidden");
    el("profile-empty").style.display = "none";
    setDock("right", true);
    el("profile-title").textContent = `Argo ${cast.platform} · cycle ${cast.cycle}`;
    el("profile-caption").textContent = "co-locating with the model…";
    try {
      const profile = await api.getCubeProfile(cube.request!, cast.platform, cast.cycle);
      if (ticket !== profileTicket) return;
      drawProfile(el<HTMLCanvasElement>("profile-chart"), profile, cube.variable!.units);
      el("profile-caption").textContent =
        `${captionFor(profile)}\ncompared with: ${profile.modelTitle}, ` +
        `${profile.summary.model ? (profile.summary.model as { era: string }).era : ""}, ` +
        `on the float's own day` +
        (profile.assumptions?.length ? `\n${profile.assumptions.join("\n")}` : "");
    } catch (error) {
      if (ticket !== profileTicket) return;
      el("profile-caption").textContent = `could not compare: ${(error as Error).message}`;
    }
  }

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

  /** A colour change on the cube: repaint it, the whole ocean around it, and the legend. */
  const recolourCube = () => {
    cube.repaint();
    void ocean.recolour(cube.style());
    renderLegendStrip();
  };

  // The ocean layers refetch when a drag is let go, not on every pixel of it: a new top
  // depth is a new level, and a new height moves the cube-top particles.
  el("cut-top").addEventListener("change", () => refreshOcean());
  el("cube-height").addEventListener("change", () => {
    if (cube.request) {
      const top = cube.currentCut()!.top;
      void ocean.showCubeCurrents(cube.request, top, cube.scene.heightOf(top) + 400);
    }
  });
  bind("ocean-surface", "change", (node) => {
    ocean.surfaceOn = node.checked;
    if (node.checked) refreshOcean(); else ocean.clearSurface();
  });
  bind("ocean-wind", "change", (node) => {
    ocean.windOn = node.checked;
    if (node.checked) refreshOcean(); else ocean.dropWind();
  });
  bind("cube-wind", "change", (node) => {
    ocean.cubeWindOn = node.checked;
    if (node.checked) refreshOcean(); else ocean.dropCubeWind();
  });
  bind("ocean-air", "change", (node) => {
    ocean.airOn = node.checked;
    void ocean.showAir(cube.request?.day ?? today()).then(() => {
      el("air-note").textContent = ocean.airOn ? ocean.airNote : "";
    });
  });
  // One switch for the two whole-ocean layers, so the cube can be looked at on its own.
  bind("cube-only", "change", (node) => {
    for (const id of ["ocean-surface", "ocean-wind", "ocean-air"]) {
      if (id === "ocean-air" && !node.checked) continue;  // winds are opt-in: never turned on here
      const box = el<HTMLInputElement>(id);
      if (box.checked === node.checked) {
        box.checked = !node.checked;
        box.dispatchEvent(new Event("change"));
      }
    }
  });
  // The zones are painted on the sea surface, which the standing cube covers: they are
  // read on the flat map, where the cube is its own top face.
  // INCOIS's own advisories: every sector, with its status (most days some are under cloud).
  const pfz = new PfzMarkers(viewer, (ms) => graphics.kick(ms));
  bind("pfz-on", "change", async (node) => {
    const list = el("pfz-list");
    if (!node.checked) {
      pfz.hide();
      list.replaceChildren();
      return;
    }
    list.textContent = "reading INCOIS's advisories…";
    let got: Awaited<ReturnType<typeof pfz.show>>;
    try {
      got = await pfz.show();
    } catch (error) {
      list.textContent = (error as Error).message;
      return;
    }
    list.replaceChildren(...got.sectors.map((s) => {
      const row = document.createElement("div");
      row.className = "pfz-row";
      const head = document.createElement("span");
      head.innerHTML = `<b>${s.name}</b> · ${s.status === "ok" ? `${s.points.length} points` : s.status}`;
      const note = document.createElement("span");
      note.className = "hint";
      note.textContent = s.status === "ok" ? `valid till ${s.valid_till ?? "?"}` : (s.note ?? "");
      row.append(head, note);
      if (s.points.length) {
        const go = document.createElement("button");
        go.className = "btn";
        go.textContent = "Go";
        const mid = (k: "lat" | "lon") => s.points.reduce((a, p) => a + p[k], 0) / s.points.length;
        go.addEventListener("click", () => void flyTo(mid("lon"), mid("lat"), 400_000));
        row.append(go);
      }
      return row;
    }));
    status(`INCOIS PFZ advisories: ${got.points} points, fetched ${got.fetched_utc}`);
  });
  bind("fish-on", "change", async (node) => {
    if (node.checked && state.view !== "map" && !immersive.active) await setView("map");
    void refreshFishing();
  });
  el<HTMLSelectElement>("ocean-density").addEventListener("change", (e) => {
    ocean.density = Number((e.target as HTMLSelectElement).value);
    ocean.dropWind();
    refreshOcean();
  });

  paletteSelect.addEventListener("change", () => {
    if (cubeActive()) {
      cube.colour.paletteId = paletteSelect.value;
      recolourCube();
      return;
    }
    state.paletteId = paletteSelect.value;
    setPalette();
  });

  bind("reverse", "change", (node) => {
    if (cubeActive()) {
      cube.colour.reversed = node.checked;
      recolourCube();
      return;
    }
    state.reversed = node.checked;
    setPalette();
  });

  bind("log", "change", (node) => {
    const allowed = logScaleAllowed(activeColour().range[0]);
    if (node.checked && !allowed.ok) {
      node.checked = false;
      status(allowed.reason ?? "log scale unavailable", "warn");
      return;
    }
    if (cubeActive()) {
      cube.colour.log = node.checked;
      recolourCube();
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
    setLand(landStyle, brightness);
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
    if (cubeActive()) {
      cube.colour.range = [Number(node.value), cube.colour.range[1]];
      recolourCube();
      return;
    }
    state.range = [Number(node.value), state.range[1]];
    applyUniforms();
    renderLegendStrip();
  });

  bind("range-max", "change", (node) => {
    if (cubeActive()) {
      cube.colour.range = [cube.colour.range[0], Number(node.value)];
      recolourCube();
      return;
    }
    state.range = [state.range[0], Number(node.value)];
    applyUniforms();
    renderLegendStrip();
  });

  // The INCOIS volume and the cube are never on screen together (see showBay).
  bind("bay-volume", "change", async (node) => {
    showBay = node.checked;
    el("app").classList.toggle("bay", showBay);
    if (!showBay && state.layer === "residual") await setLayer("field");
    if (showBay) {
      if (!globalDays.length) {
        try {
          globalDays = (await api.getGlobalLayers()).days;
        } catch (error) {
          status(`global layers unavailable: ${(error as Error).message}`, "warn");
        }
      }
      await loadObservations();
    } else {
      viewer.entities.removeAll();  // the Bay's floats and gliders go with it
    }
    if (showBay) {
      state.depthIndex = Math.min(state.depthIndex, 23);
      await setView("region");
      orbit.retarget(bayBounds, bayHome);
      await loadVolume();
      await loadStreamlines();
    } else {
      await setView("region");
      await aimAtCube();
    }
    syncColourControls();
    if (showBay && state.volumeMeta) renderProvenance(state.volumeMeta);
    else if (cube.data) renderCubeProvenance();
    syncCubeTimeline();
    placeMarkers();
    renderHud();
  });

  // Vertical exaggeration changes the voxel bounds, so it rebuilds the provider rather
  // than setting a uniform. Cheap, because the data is already in memory.
  bind("exaggeration", "change", async (node) => {
    state.exaggeration = Number(node.value);
    el("exaggeration-label").textContent = `${state.exaggeration}x`;
    await loadVolume();
  });

  /**
   * One timeline for whichever layer is on screen. For the cube it spans every day the
   * variable has, reanalysis through forecast, one step per day; for the Bay volume, the
   * INCOIS analysis steps.
   */
  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  function syncCubeTimeline(): void {
    if (cubeActive() && cube.request) {
      const day = el<HTMLInputElement>("cube-day");
      timeSlider.max = String(daysBetween(day.min, day.max));
      timeSlider.value = String(daysBetween(day.min, cube.request.day));
      el("time-label").textContent = cube.request.day;
    } else {
      timeSlider.max = String(meta.times.length - 1);
      timeSlider.value = String(state.timeIndex);
      el("time-label").textContent = meta.times[state.timeIndex].slice(0, 10);
    }
  }
  const sliderDay = () => shiftDay(el<HTMLInputElement>("cube-day").min, Number(timeSlider.value));

  timeSlider.addEventListener("input", () => {
    if (cubeActive()) el("time-label").textContent = sliderDay();
  });

  timeSlider.addEventListener("change", async () => {
    setPlaying(false);
    if (cubeActive()) {
      await cube.setDay(sliderDay());
      return;
    }
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
    if (cubeActive() && cube.request) {
      const max = el<HTMLInputElement>("cube-day").max;
      const next = cube.request.day >= max ? el<HTMLInputElement>("cube-day").min
        : shiftDay(cube.request.day, 1);
      await cube.setDay(next);
      if (state.playing) timer = window.setTimeout(() => { void step(); }, FRAME_MS);
      return;
    }
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
    el<HTMLInputElement>("gfx-pause").checked = q.pauseOnMove;
    ocean.flow.pauseOnMove = q.pauseOnMove;
    streamlineLayer.pauseOnMove = q.pauseOnMove && state.view !== "fly";
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
    bind("gfx-pause", "change", (n) => custom({ pauseOnMove: n.checked }));
    el("gfx-measure").addEventListener("click", async () => {
      el("gfx-status").textContent = "measuring…";
      const fps = await graphics.measure(2000);
      el("gfx-status").textContent = `${fps.toFixed(0)} fps rendering continuously`;
    });
    syncGraphicsPanel();
  }

  // ---- anywhere, and immersive (immersive.ts) ------------------------------

  const today = () => new Date().toISOString().slice(0, 10);

  /** Look at a place: orbiting if it is by the cube, from the globe view if not. */
  async function flyTo(lon: number, lat: number, range: number): Promise<void> {
    const d = cube.data;
    const near = (lo: number, hi: number, v: number) => v >= lo - 6 && v <= hi + 6;
    const byCube = cubeActive() && !!d && near(d.south, d.north, lat) &&
      (near(d.west, d.east, lon) || near(d.west, d.east, lon + 360));
    if (byCube || (showBay && near(lon0, lon1, lon) && near(lat0, lat1, lat))) {
      if (state.view !== "region") await setView("region");
      orbit.lookAt(lon, lat, range);
    } else {
      // The orbit camera is held to its box; anywhere else is seen from the globe view.
      if (state.view !== "globe") await setView("globe");
      viewer.camera.flyTo({ destination: Cartesian3.fromDegrees(lon, lat, range * 2.5), duration: 2.5 });
    }
    graphics.kick(3000);
  }

  let viewBeforeImmersive: ViewName = "region";
  const immersive = new Immersive(viewer, {
    enter: async () => {
      viewBeforeImmersive = state.view;
      await setView("globe");
      cube.setVisible(false);
      if (primitive) primitive.show = false;
      viewer.entities.show = false;  // the Bay's float and glider markers
      fishing.setVisible(false);
      ocean.setVisible(true);
      ocean.flow.ignoreHoles = true;
      ocean.dropCubeWind();
      await setTerrain(true);
    },
    exit: async () => {
      ocean.flow.ignoreHoles = false;
      // The workspace's own switches decide again what the whole ocean shows.
      ocean.surfaceOn = el<HTMLInputElement>("ocean-surface").checked;
      ocean.windOn = el<HTMLInputElement>("ocean-wind").checked;
      ocean.airOn = el<HTMLInputElement>("ocean-air").checked;
      if (!ocean.surfaceOn) ocean.clearSurface();
      if (!ocean.windOn) ocean.dropWind();
      if (!ocean.airOn) void ocean.showAir("");
      fishing.setVisible(true);
      viewer.entities.show = true;
      await setView(viewBeforeImmersive);
      if (cubeActive() && viewBeforeImmersive === "region") await aimAtCube();
      refreshOcean();
    },
    layer: (name, on) => {
      // With the cube gone the particles and colour are at the surface; the key says so.
      const day = cube.request?.day ?? today();
      if (name === "currents") {
        ocean.windOn = on;
        if (on) void ocean.showCurrents(day, 0); else ocean.dropWind();
      } else if (name === "air") {
        ocean.airOn = on;
        void ocean.showAir(day).then(() => immersive.renderKey());
      } else {
        ocean.surfaceOn = on;
        if (on && cube.variable) void ocean.showSurface(cube.variable.key, day, 0, cube.style());
        else ocean.clearSurface();
      }
    },
    describe: () => {
      const day = cube.request?.day ?? today();
      const parts: string[] = [];
      if (ocean.windOn) parts.push(`white: ocean currents at the surface on ${day}`);
      if (ocean.airOn && ocean.airNote) parts.push(`amber: ${ocean.airNote}`);
      if (ocean.surfaceOn && cube.variable) {
        parts.push(`colour: ${cube.variable.title.toLowerCase()} at the surface on ${day}`);
      }
      return parts.join("  ·  ");
    },
    // Immersive shows the planet in colour at full brightness; the workspace's own land
    // style comes back on exit (the value returned here is handed back then).
    setBasemapBrightness: (b) => {
      const was = landBrightness;
      if (immersive.active) setLand(landStyle === "offline" ? "offline" : "colour", b, false);
      else setLand(landStyle, b);
      return was;
    },
    kick: (ms) => graphics.kick(ms),
    cinema: (on) => {
      // The camera never rests in the film: render every frame, draw the particles from
      // the render itself, and never swap to the rest resolution (a framebuffer resize at
      // every cut). On the way out the panel's own settings decide again.
      ocean.flow.follow(on);
      graphics.restSharpen = !on;
      viewer.scene.requestRenderMode = on ? false : graphics.quality.onDemand;
    },
  });
  el("immersive").addEventListener("click", () => void immersive.enter());


  // ---- assistant ----------------------------------------------------------

  /** What the assistant is told the user is looking at, so "here" and "this" resolve.
   * Kept short: the server cuts the context at a fixed length. */
  const chatContext = () => {
    const c = viewer.camera.positionCartographic;
    const r = cube.request;
    return {
      view: immersive.active ? "immersive" : state.view,
      camera: [+CesiumMath.toDegrees(c.latitude).toFixed(1),
               +CesiumMath.toDegrees(c.longitude).toFixed(1), Math.round(c.height / 1000)],
      cube: r && !showBay ? { box: [r.lon0, r.lon1, r.lat0, r.lat1], variable: r.variable,
                              day: r.day, depth_max: r.depthMax } : null,
      bay_volume: showBay ? { layer: state.layer, depth_m: Math.round(sliceDepth()) } : null,
      open_profile: el("profile-panel").classList.contains("hidden")
        ? null : el("profile-title").textContent,
      on: ["ocean-surface", "ocean-wind", "cube-wind", "ocean-air", "fish-on", "pfz-on"]
        .filter((id) => el<HTMLInputElement>(id).checked),
    };
  };

  /** Orange ring round a control for five seconds, opening whatever hides it. */
  let highlightTimer = 0;
  let highlighted: HTMLElement | undefined;
  function highlight(node: HTMLElement): void {
    // A checkbox is a dot; ring its whole label.
    const target = (node.closest("label.check") as HTMLElement | null) ?? node;
    const dock = target.closest(".dock");
    if (dock) setDock(dock.id as "left" | "right", true);
    for (let d = target.parentElement?.closest("details"); d; d = d.parentElement?.closest("details")) {
      d.open = true;
    }
    if (target instanceof HTMLDetailsElement) target.open = true;
    window.clearTimeout(highlightTimer);
    highlighted?.classList.remove("hl");
    void target.offsetWidth;  // restarts the pulse when the same control is pointed at twice
    target.classList.add("hl");
    highlighted = target;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    highlightTimer = window.setTimeout(() => target.classList.remove("hl"), 5000);
  }

  /** A control the assistant may touch: a named element of this page, and nothing else. */
  function control(id: unknown): HTMLElement {
    const node = typeof id === "string" ? document.getElementById(id) : null;
    if (!node || !el("app").contains(node)) throw new Error(`no control ${String(id)}`);
    return node;
  }

  const assistant = new ChatPanel({
    context: chatContext,
    apply: async (a) => {
      // Checked again here: the browser applies only what it recognises, clamped.
      const clamp = (v: number | undefined, lo: number, hi: number) =>
        Math.min(Math.max(Number(v), lo), hi);
      if (a.action === "set_view" && ALL_VIEWS.includes(a.view as ViewName)) {
        if (immersive.active) await immersive.leave();
        await setView(a.view as ViewName);
      } else if (a.action === "set_layer" && (a.layer === "field" || a.layer === "residual")) {
        if (a.layer === "residual" && !showBay) control("bay-volume").click();
        await setLayer(a.layer);
      } else if (a.action === "set_depth") {
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
        await flyTo(clamp(a.lon, -180, 180), clamp(a.lat, -80, 80), 900_000);
      } else if (a.action === "open_profile" && a.platform) {
        await showProfile(a.platform);
      } else if (a.action === "isotherm_20") {
        el("preset-d20").click();
      } else if (a.action === "make_cube") {
        if (immersive.active) await immersive.leave();
        if (showBay) control("bay-volume").click();
        const set = (id: string, v: unknown) => {
          if (v !== undefined && v !== null && v !== "") el<HTMLInputElement>(id).value = String(v);
        };
        const has = (id: string, v: unknown) =>
          [...el<HTMLSelectElement>(id).options].some((o) => o.value === String(v));
        set("cube-w", clamp(a.west, -180, 180));
        set("cube-e", clamp(a.east, -180, 180));
        set("cube-s", clamp(a.south, -80, 90));
        set("cube-n", clamp(a.north, -80, 90));
        if (a.variable && has("cube-variable", a.variable)) set("cube-variable", a.variable);
        if (a.day && /^\d{4}-\d{2}-\d{2}$/.test(a.day)) set("cube-day", a.day);
        if (a.depth_max && has("cube-depth", a.depth_max)) set("cube-depth", a.depth_max);
        el("cube-load").click();
      } else if (a.action === "set_control") {
        const node = control(a.target);
        if (node instanceof HTMLInputElement && node.type === "checkbox") {
          node.checked = a.value === true || a.value === "true" || a.value === 1;
        } else if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) {
          node.value = String(a.value);
        } else {
          throw new Error("not a control with a value");
        }
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        highlight(node);
      } else if (a.action === "click") {
        const node = control(a.target);
        if (!(node instanceof HTMLButtonElement)) throw new Error("only buttons are clicked");
        node.click();
      } else if (a.action === "highlight") {
        highlight(control(a.target));
      } else if (a.action === "immersive") {
        if (a.on === false) await immersive.leave(); else await immersive.enter();
      } else if (a.action === "cinematic") {
        await immersive.enter();
        immersive.startCinema();
      }
    },
  });
  el("chat-dock").append(assistant.root);

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
    else if (event.key.toLowerCase() === "i") void immersive.toggle();
    else if (event.key === "Escape" && immersive.active) void immersive.leave();
    else if (event.key.toLowerCase() === "c" && immersive.active) immersive.startCinema();
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
      setView, setDock, showProfile, setLayer, homeCamera, orbit, flight, cube, ocean,
      immersive, fishing, highlight,
    };
  }

  try {
    el<HTMLInputElement>("currents").checked = state.showCurrents;
    bindGraphicsPanel();
    await setView("region");
    // The cube is the viewer. The INCOIS Bay volume, its floats, streamlines and residual
    // load only when "INCOIS Bay volume" is ticked.
    try {
      await cube.init(await api.getCatalog());
    } catch (error) {
      status(`the ocean cube is unavailable: ${(error as Error).message}`, "error");
    }
    // ?view=map|globe|fly opens a view directly, for links and for headless checks.
    const startView = new URLSearchParams(location.search).get("view") as ViewName | null;
    if (startView && ALL_VIEWS.includes(startView) && startView !== "region") await setView(startView);
    // ?immersive=1 opens straight into the immersive view.
    if (new URLSearchParams(location.search).get("immersive") === "1") await immersive.enter();
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
