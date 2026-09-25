/** Thin wrapper over the FastAPI backend. No state, no caching — that lives in main.ts. */

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8011";

// An ngrok free domain answers browsers with an HTML warning page unless this header is
// sent (docs/18-deploy.md, laptop backend). Only then: it makes every GET preflighted.
const fetch: typeof globalThis.fetch = BASE.includes("ngrok")
  ? (url, init = {}) => globalThis.fetch(url, {
      ...init, headers: { ...(init.headers as Record<string, string>), "ngrok-skip-browser-warning": "1" },
    })
  : globalThis.fetch.bind(globalThis);

export interface Meta {
  region: { name: string; lon: [number, number]; lat: [number, number] };
  depthRange: [number, number];
  demoDate: string;
  sources: {
    key: string;
    title: string;
    variables: string[];
    hasError: boolean;
    nativeLevels: number;
    needsCredentials: boolean;
  }[];
  defaultSource: string;
  times: string[];
  window: [string, string];
}

export interface VolumeMeta {
  dimensions: [number, number, number];
  lonRange: [number, number];
  latRange: [number, number];
  depthRange: [number, number];
  valueRange: [number, number];
  hasError: boolean;
  provenance: {
    residual?: {
      casts: number; analysis_steps: string[]; levels_binned: number;
      cells_filled: number; cells_total: number; coverage_percent: number;
      bias: number; rmse: number;
    };
    analysis_steps?: string[];
    source: string;
    variable: string;
    standard_name: string;
    units: string;
    time: string;
    depth_grid: { stretch: string; levels: number; z_min_m: number; z_max_m: number; depths_m: number[] };
    range_test: { checked: boolean; test?: string; failed?: number; checked_cells?: number; failed_range?: [number, number] };
    masked_cells: number;
    /** k when the server sent a k x k block mean of a finer grid; 1 or absent otherwise. */
    horizontal_block?: number;
    cf_assumptions: string[];
  };
}

export interface Observation {
  kind: "argo" | "glider" | "text";
  platform: string;
  lat: number;
  lon: number;
  time: string;
  levels: number;
  levelsRejected: number;
  dataMode: string;
  maxDepth: number;
}

export interface ProfileComparison {
  platform: string;
  lat: number;
  lon: number;
  time: string;
  depth: (number | null)[];
  observed: (number | null)[];
  modelled: (number | null)[];
  accepted: boolean[];
  qc: string[];
  error: (number | null)[] | null;
  summary: Record<string, unknown>;
  /** Cyclone heat potential, observed vs analysis on shared levels (server/ocean/heat.py). */
  tchp: {
    observed_kj_cm2: number | null; analysis_kj_cm2: number | null;
    difference_kj_cm2: number | null; observed_d26_m: number | null;
    analysis_d26_m: number | null; levels: number; notes: string[];
  } | null;
  /** What the text parser assumed for an uploaded cast; empty for Argo and gliders. */
  assumptions?: string[];
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}`);
  }
  return (await response.json()) as T;
}

export interface Streamlines {
  depth_m: number;
  time: string;
  count: number;
  speedRange: [number, number];
  units: string;
  method: string;
  note: string;
  streamlines: { points: [number, number][]; speeds: number[] }[];
}

export const getMeta = () => json<Meta>("/api/meta");

/** Casts from a delimited-text file (server/ocean/textcast.py). */
export async function uploadCasts(file: File): Promise<{
  name: string; casts: number; levels: number; notes: string[];
}> {
  const response = await fetch(
    `${BASE}/api/casts?name=${encodeURIComponent(file.name)}`,
    { method: "POST", body: await file.text(), headers: { "Content-Type": "text/plain" } },
  );
  if (!response.ok) {
    // The parser's refusal says exactly which column it could not find; show that.
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(String(detail.detail));
  }
  return response.json();
}

export const getStreamlines = (source: string, timeIndex: number, depthM: number) =>
  json<Streamlines>(
    `/api/streamlines?source=${source}&time_index=${timeIndex}&depth_m=${depthM}`,
  );

/** No timestep: the residual is a window aggregate (server/ocean/residual.py). */
export const getResidualMeta = (variable: string, source: string, on: string) =>
  json<VolumeMeta>(`/api/residual/meta?variable=${variable}&source=${source}&on=${on}`);

export const getVolumeMeta = (variable: string, source: string, timeIndex: number) =>
  json<VolumeMeta>(`/api/volume/meta?variable=${variable}&source=${source}&time_index=${timeIndex}`);

export const getObservations = (on: string, variable: string) =>
  json<{ observations: Observation[] }>(`/api/observations?on=${on}&variable=${variable}`);

export const getProfile = (platform: string, on: string, variable: string) =>
  json<ProfileComparison>(
    `/api/profile?platform=${encodeURIComponent(platform)}&on=${on}&variable=${variable}`,
  );

/** Residual volume: one channel, no uncertainty. Same binary contract as a field. */
export async function getResidualData(
  variable: string, source: string, on: string, voxelCount: number,
): Promise<{ values: Float32Array; errors: null }> {
  const response = await fetch(
    // n is ignored by the server. It keys the HTTP cache on the shape the metadata just
    // promised, so a cached payload of a different shape can never be served against it.
    `${BASE}/api/residual/data?variable=${variable}&source=${source}&on=${on}&n=${voxelCount}`,
  );
  if (!response.ok) throw new Error(`${response.status} fetching residual data`);
  const all = new Float32Array(await response.arrayBuffer());
  if (all.length !== voxelCount) {
    throw new Error(`residual payload is ${all.length} floats, expected ${voxelCount}`);
  }
  return { values: all, errors: null };
}

/**
 * Volume payload as raw float32: the value channel, then the uncertainty channel when
 * the source has one. Arrives as bytes and goes straight into a Float32Array — there is
 * no JSON parse on this path, which is the whole reason it is a separate endpoint.
 */
export async function getVolumeData(
  variable: string,
  source: string,
  timeIndex: number,
  voxelCount: number,
  hasError: boolean,
): Promise<{ values: Float32Array; errors: Float32Array | null }> {
  const response = await fetch(
    // n: see getResidualData. The shape once changed server-side (GLORYS block mean) and
    // the browser kept serving the old 2 M-float body against the new 228 k metadata.
    `${BASE}/api/volume/data?variable=${variable}&source=${source}&time_index=${timeIndex}&n=${voxelCount}`,
  );
  if (!response.ok) {
    throw new Error(`${response.status} fetching volume data`);
  }
  const buffer = await response.arrayBuffer();
  const all = new Float32Array(buffer);

  const expected = hasError ? voxelCount * 2 : voxelCount;
  if (all.length !== expected) {
    throw new Error(`volume payload is ${all.length} floats, expected ${expected}`);
  }

  return {
    values: all.subarray(0, voxelCount),
    errors: hasError ? all.subarray(voxelCount, voxelCount * 2) : null,
  };
}

/** Whole-Earth surface layers (server/ocean/globalsurface.py). Surface only. */
export interface GlobalLayer { key: string; title: string; units: string; palette: string; note: string }

export interface GlobalSurfaceMeta {
  layer: string;
  title: string;
  units: string;
  palette: string;
  dimensions: [number, number];
  lonRange: [number, number];
  latRange: [number, number];
  valueRange: [number, number];
  provenance: { source: string; variable: string; level_m: number | null; day: string;
    display_range: string; note: string };
}

export const getGlobalLayers = () =>
  json<{ days: string[]; layers: GlobalLayer[]; cached: string[] }>("/api/global/layers");

export async function getGlobalSurface(layer: string, day: string):
    Promise<{ meta: GlobalSurfaceMeta; values: Float32Array }> {
  const meta = await json<GlobalSurfaceMeta>(`/api/global/meta?layer=${layer}&day=${day}`);
  const response = await fetch(`${BASE}/api/global/data?layer=${layer}&day=${day}`);
  if (!response.ok) throw new Error(`${response.status} fetching the global ${layer} layer`);
  const values = new Float32Array(await response.arrayBuffer());
  const [nx, ny] = meta.dimensions;
  if (values.length !== nx * ny) {
    throw new Error(`global ${layer} is ${values.length} floats, expected ${nx * ny}`);
  }
  return { meta, values };
}

// ---- the global cube (server/ocean/catalog.py, cube.py) ------------------------

export interface CatalogEra { name: string; dataset: string; source: string; from: string; to: string }

export interface CatalogVariable {
  key: string; title: string; units: string; palette: string;
  group: "physics" | "biogeochemistry" | "surface";
  depth: boolean; signed: boolean; log: boolean;
  derived: string[]; formula: string; note: string;
  eras: CatalogEra[];
}

export interface Scenario {
  key: string; title: string; box: [number, number, number, number]; day: string;
  variable: string; depthMax: number; why: string;
}

export interface Catalog { variables: CatalogVariable[]; today: string; scenarios: Scenario[] }

export const getCatalog = () => json<Catalog>("/api/catalog");

export interface CubeProvenance {
  variable: string; title: string; units: string; day: string; forecast: boolean;
  sources: { dataset: string; source: string; era: string; variable: string; day: string;
             forecast: boolean; standard_name: string; units: string }[];
  derived: { from: string[]; formula: string } | null;
  native_levels: number | null;
  depth_note: string;
  horizontal: { native_step_deg: number; block: number; display_step_deg: number; note: string };
  range_test: Record<string, { checked: boolean; test?: string; failed?: number;
                               checked_cells?: number; failed_range?: [number, number];
                               masked_cells: number; reason?: string }>;
  cf_assumptions: string[];
  note: string;
  seafloor: string;
}

export interface CubeMeta {
  shape: number[];
  /** [nx, ny, nz]; nz is 1 for a 2D field. */
  dimensions: [number, number, number];
  /** Cell centres. Longitudes may run past 180 for a box across the antimeridian. */
  lons: number[];
  lats: number[];
  /** Native levels, metres, shallow first. null for a 2D field. */
  depths: number[] | null;
  valueRange: [number, number];
  provenance: CubeProvenance;
}

export interface CubeRequest {
  variable: string; lon0: number; lon1: number; lat0: number; lat1: number;
  day: string; depthMax: number;
}

const cubeQuery = (q: CubeRequest) =>
  `variable=${q.variable}&lon0=${q.lon0}&lon1=${q.lon1}&lat0=${q.lat0}&lat1=${q.lat1}` +
  `&day=${q.day}&depth_max=${q.depthMax}`;

/** An error body from the API says why (no data that day, box too big); keep it. */
async function failure(response: Response, what: string): Promise<Error> {
  const detail = await response.json().catch(() => ({ detail: response.statusText }));
  return new Error(`${what}: ${detail.detail ?? response.status}`);
}

/**
 * One cube: metadata, then float32 values (depth, lat, lon; shallow and south first,
 * x fastest) followed by float32 sea-floor depth (lat, lon).
 */
export async function getCube(q: CubeRequest): Promise<{
  meta: CubeMeta; values: Float32Array; seafloor: Float32Array;
}> {
  const metaResponse = await fetch(`${BASE}/api/cube/meta?${cubeQuery(q)}`);
  if (!metaResponse.ok) throw await failure(metaResponse, "cube unavailable");
  const meta = (await metaResponse.json()) as CubeMeta;
  const [nx, ny, nz] = meta.dimensions;
  // n keys the HTTP cache on the shape just promised (see getVolumeData).
  const response = await fetch(`${BASE}/api/cube/data?${cubeQuery(q)}&n=${nx * ny * nz}`);
  if (!response.ok) throw await failure(response, "cube data unavailable");
  const all = new Float32Array(await response.arrayBuffer());
  if (all.length !== nx * ny * nz + nx * ny) {
    throw new Error(`cube payload is ${all.length} floats, expected ${nx * ny * nz + nx * ny}`);
  }
  return { meta, values: all.subarray(0, nx * ny * nz), seafloor: all.subarray(nx * ny * nz) };
}

/** One Argo cast inside a cube, thinned for drawing (rejected levels always kept). */
export interface CubeCast {
  platform: string; cycle: number; lat: number; lon: number; time: string;
  dataMode: string; sourceFile: string; fieldUsed: string;
  levels: number; levelsRejected: number; notes: string[];
  depth: (number | null)[]; value: (number | null)[]; accepted: boolean[]; qc: string;
}

export interface CubeCasts {
  variable: string; available: boolean; note?: string; casts: CubeCast[];
  dataset?: string; window_days?: number; from?: string; to?: string;
  found?: number; shown?: number; thinned?: boolean; units_as_drawn?: string;
  pairing?: string; qcAccepted?: string[];
}

export async function getCubeCasts(q: CubeRequest): Promise<CubeCasts> {
  const response = await fetch(`${BASE}/api/cube/casts?${cubeQuery(q)}`);
  if (!response.ok) throw await failure(response, "floats unavailable");
  return response.json();
}

/** One cast against the cube's model, on the cast's own day (server/ocean/cubecasts.py). */
export async function getCubeProfile(q: CubeRequest, platform: string, cycle: number):
    Promise<ProfileComparison & { modelTitle: string }> {
  const response = await fetch(`${BASE}/api/cube/profile?${cubeQuery(q)}` +
    `&platform=${encodeURIComponent(platform)}&cycle=${cycle}`);
  if (!response.ok) throw await failure(response, "co-location unavailable");
  return response.json();
}

// ---- the whole ocean at one level (server/ocean/surface.py) ----------------------

export interface SurfaceMeta {
  dimensions: [number, number];
  lonRange: [number, number];
  latRange: [number, number];
  levelM: number | null;
  valueRange: [number, number];
  provenance: { title: string; units: string; day: string; forecast: boolean;
                sources: { source: string; era: string; dataset: string }[];
                level_m: number | null; level_note: string; note: string;
                horizontal: { block: number; display_step_deg: number } } & Record<string, unknown>;
}

async function binary(path: string, what: string, floats: number): Promise<Float32Array> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw await failure(response, what);
  const all = new Float32Array(await response.arrayBuffer());
  if (all.length !== floats) throw new Error(`${what}: ${all.length} floats, expected ${floats}`);
  return all;
}

/** One level of a variable over the whole ocean, south row first, NaN on land. */
export async function getSurface(variable: string, day: string, depth: number):
    Promise<{ meta: SurfaceMeta; values: Float32Array }> {
  const q = `variable=${variable}&day=${day}&depth=${depth}`;
  const metaResponse = await fetch(`${BASE}/api/surface/meta?${q}`);
  if (!metaResponse.ok) throw await failure(metaResponse, "global layer unavailable");
  const meta = (await metaResponse.json()) as SurfaceMeta;
  const [nx, ny] = meta.dimensions;
  return { meta, values: await binary(`/api/surface/data?${q}&n=${nx * ny}`, "global layer", nx * ny) };
}

export interface CurrentsMeta {
  dimensions: [number, number]; lonRange: [number, number]; latRange: [number, number];
  levelM: number; note?: string; provenance?: { note: string };
}

/** u and v at one level, worldwide or over a cube's box; 0 on land. */
export async function getCurrents(day: string, depth: number, box?: CubeRequest):
    Promise<{ meta: CurrentsMeta; u: Float32Array; v: Float32Array }> {
  const where = box
    ? `/api/cube/currents/%s?lon0=${box.lon0}&lon1=${box.lon1}&lat0=${box.lat0}&lat1=${box.lat1}&`
    : `/api/surface/currents/%s?`;
  const q = `day=${day}&depth=${depth}`;
  const metaResponse = await fetch(`${BASE}${where.replace("%s", "meta")}${q}`);
  if (!metaResponse.ok) throw await failure(metaResponse, "currents unavailable");
  const meta = (await metaResponse.json()) as CurrentsMeta;
  const [nx, ny] = meta.dimensions;
  const all = await binary(`${where.replace("%s", "data")}${q}&n=${nx * ny}`, "currents", 2 * nx * ny);
  return { meta, u: all.subarray(0, nx * ny), v: all.subarray(nx * ny) };
}

/** 10 m wind worldwide at 12:00 UTC on a day (server/ocean/marine.py); ends yesterday. */
export async function getWind(day: string):
    Promise<{ meta: CurrentsMeta & { provenance: Record<string, unknown> }; u: Float32Array; v: Float32Array }> {
  const metaResponse = await fetch(`${BASE}/api/wind/meta?day=${day}`);
  if (!metaResponse.ok) throw await failure(metaResponse, "wind unavailable");
  const meta = await metaResponse.json();
  const [nx, ny] = meta.dimensions;
  const all = await binary(`/api/wind/data?day=${day}&n=${nx * ny}`, "wind", 2 * nx * ny);
  return { meta, u: all.subarray(0, nx * ny), v: all.subarray(nx * ny) };
}

export interface FishingSpot {
  lat: number; lon: number; front_c_per_100km: number; chlorophyll_mg_m3: number;
  sea_state: "fit" | "caution" | "stay in" | "unknown";
}

export interface Fishing {
  dimensions: [number, number]; lonRange: [number, number]; latRange: [number, number];
  /** base64, one byte per cell south row first: bit 0 zone, bits 1-2 sea state, 255 land. */
  cells: string;
  spots: FishingSpot[];
  counts: { ocean_cells: number; zone_cells: number; stay_in_cells: number; caution_cells: number };
  provenance: { day: string; missing: string[]; not_an_advisory: string } & Record<string, unknown>;
}

/** Indicative fishing zones and sea state over a box (server/ocean/fishing.py). */
export async function getFishing(q: { lon0: number; lon1: number; lat0: number; lat1: number },
                                 day: string): Promise<Fishing> {
  const response = await fetch(`${BASE}/api/fishing?lon0=${q.lon0}&lon1=${q.lon1}` +
    `&lat0=${q.lat0}&lat1=${q.lat1}&day=${day}`);
  if (!response.ok) throw await failure(response, "fishing zones unavailable");
  return response.json();
}

export interface PfzPoint {
  coast: string; direction: string; bearing_deg: number; distance_km: [number, number];
  depth_m: [number, number]; lat: number; lon: number;
}

export interface PfzSector {
  sector: string; name: string; status: "ok" | "none" | "error"; note?: string;
  valid_till: string | null; source: string; points: PfzPoint[];
}

/** INCOIS's own Potential Fishing Zone advisories, as published (server/ocean/pfz.py). */
export async function getPfz(): Promise<{ fetched_utc: string; points: number; sectors: PfzSector[] }> {
  const response = await fetch(`${BASE}/api/pfz`);
  if (!response.ok) throw await failure(response, "INCOIS advisories unavailable");
  return response.json();
}

/** The assistant (server/ocean/assistant.py). Actions are whitelisted server-side. */
export interface ChatAction {
  action: string; view?: string; layer?: string; depth_m?: number;
  lat?: number; lon?: number; platform?: string;
  /** make_cube */
  west?: number; east?: number; south?: number; north?: number; variable?: string;
  day?: string; depth_max?: number;
  /** set_control, click, highlight: an element id from the server's CONTROLS list */
  target?: string; value?: string | number | boolean;
  on?: boolean;
}

export async function chat(messages: { role: string; content: string }[],
                           context: Record<string, unknown>): Promise<{
  reply: string; actions: ChatAction[]; tools_used: string[]; unverified: string[];
}> {
  const response = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, context }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(`assistant unavailable: ${detail.detail}`);
  }
  return response.json();
}

/** Waves and wind at the sea nearest a place (server/ocean/marine.py sea_state_near). */
export interface SeaState {
  sea_point: [number, number];
  distance_km: number;
  wave_height_m: number;
  wind_ms: number | null;
  wave_provenance: { dataset: string; time_utc: string };
}

export async function getSeaState(lat: number, lon: number, day: string): Promise<SeaState> {
  const response = await fetch(`${BASE}/api/seastate?lat=${lat}&lon=${lon}&day=${day}`);
  if (!response.ok) throw await failure(response, "sea state unavailable");
  return response.json();
}

/**
 * A town or city name to a place, through Open-Meteo's free geocoder (no key). Called
 * from the browser, so only the typed name leaves it, and never through our server.
 */
export async function geocode(name: string): Promise<{ name: string; lat: number; lon: number } | undefined> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json` +
    `&name=${encodeURIComponent(name.trim().slice(0, 80))}`;
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`place search unavailable (${response.status})`);
  const hit = (await response.json()).results?.[0];
  return hit ? { name: [hit.name, hit.country].filter(Boolean).join(", "),
                 lat: hit.latitude, lon: hit.longitude } : undefined;
}
