/** Thin wrapper over the FastAPI backend. No state, no caching — that lives in main.ts. */

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8011";

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

/** Global surface temperature for the Globe view (server/ocean/globalsurface.py). */
export interface GlobalSurfaceMeta {
  dimensions: [number, number];
  lonRange: [number, number];
  latRange: [number, number];
  valueRange: [number, number];
  provenance: { source: string; variable: string; level_m: number; day: string;
    horizontal_block: number; note: string };
}

export async function getGlobalSurface(): Promise<{ meta: GlobalSurfaceMeta; values: Float32Array }> {
  const meta = await json<GlobalSurfaceMeta>("/api/global/meta");
  const response = await fetch(`${BASE}/api/global/data`);
  if (!response.ok) throw new Error(`${response.status} fetching the global surface`);
  const values = new Float32Array(await response.arrayBuffer());
  const [nx, ny] = meta.dimensions;
  if (values.length !== nx * ny) {
    throw new Error(`global surface is ${values.length} floats, expected ${nx * ny}`);
  }
  return { meta, values };
}
