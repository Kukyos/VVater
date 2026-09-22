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
    source: string;
    variable: string;
    standard_name: string;
    units: string;
    time: string;
    depth_grid: { stretch: string; levels: number; z_min_m: number; z_max_m: number; depths_m: number[] };
    range_test: { checked: boolean; test?: string; failed?: number; checked_cells?: number; failed_range?: [number, number] };
    masked_cells: number;
    cf_assumptions: string[];
  };
}

export interface Observation {
  kind: "argo" | "glider";
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
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${path}`);
  }
  return (await response.json()) as T;
}

export const getMeta = () => json<Meta>("/api/meta");

export const getVolumeMeta = (variable: string, source: string, timeIndex: number) =>
  json<VolumeMeta>(`/api/volume/meta?variable=${variable}&source=${source}&time_index=${timeIndex}`);

export const getObservations = (on: string, variable: string) =>
  json<{ observations: Observation[] }>(`/api/observations?on=${on}&variable=${variable}`);

export const getProfile = (platform: string, on: string, variable: string) =>
  json<ProfileComparison>(
    `/api/profile?platform=${encodeURIComponent(platform)}&on=${on}&variable=${variable}`,
  );

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
    `${BASE}/api/volume/data?variable=${variable}&source=${source}&time_index=${timeIndex}`,
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
