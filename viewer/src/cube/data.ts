/**
 * A cube of ocean held in memory, and every way the viewer reads a value out of it.
 *
 * The server sends the field on the dataset's **native depth levels** (server/ocean/
 * cube.py), shallow first and south first, x fastest. Everything drawn — the six faces,
 * a cut anywhere inside, the value under the cursor — is sampled here, so the rules live
 * in one place:
 *
 *   * **Vertical.** Between two native levels a face is either interpolated linearly
 *     ("smooth", how oceanographic sections are drawn) or shows the level whose cell
 *     contains the depth ("native", the data as it is). Both are display choices over the
 *     same native values; neither adds a level to the data (hard rule 3,
 *     docs/03-limitations.md L13).
 *   * **Depth axis.** A face's height is the cube's depth range mapped linearly or through
 *     sqrt(depth). Every depth label is computed from metres through that mapping, never
 *     from a pixel or a voxel index (hard rule 4).
 *   * **Missing water.** NaN is land (no water in the column at all) or below the sea
 *     floor. The two are drawn differently, so the difference is kept: `kind()`.
 */

import type { CubeMeta } from "../api";

export type DepthAxis = "linear" | "stretched";
export type Vertical = "smooth" | "native";

/** A position inside the cube, in the data's own coordinates. */
export interface Point { lon: number; lat: number; depth: number }

export class CubeData {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly lons: Float64Array;
  readonly lats: Float64Array;
  readonly depths: Float64Array;
  /** Boundaries between native levels: level k owns [edges[k], edges[k+1]). */
  private readonly edges: Float64Array;
  /** The deepest depth any face may show: the last native level. */
  readonly maxDepth: number;

  constructor(readonly meta: CubeMeta, readonly values: Float32Array,
              readonly seafloor: Float32Array) {
    [this.nx, this.ny, this.nz] = meta.dimensions;
    this.lons = Float64Array.from(meta.lons);
    this.lats = Float64Array.from(meta.lats);
    this.depths = Float64Array.from(meta.depths ?? [0]);
    const d = this.depths;
    this.edges = new Float64Array(d.length + 1);
    this.edges[0] = 0;
    for (let k = 1; k < d.length; k += 1) this.edges[k] = (d[k - 1] + d[k]) / 2;
    this.edges[d.length] = d[d.length - 1];
    this.maxDepth = d[d.length - 1];
  }

  get west(): number { return this.lons[0]; }
  get east(): number { return this.lons[this.nx - 1]; }
  get south(): number { return this.lats[0]; }
  get north(): number { return this.lats[this.ny - 1]; }

  value(ix: number, iy: number, iz: number): number {
    return this.values[ix + this.nx * (iy + this.ny * iz)];
  }

  floor(ix: number, iy: number): number {
    return this.seafloor[ix + this.nx * iy];
  }

  /** Fractional index of a coordinate on a (possibly non-uniform) ascending axis. */
  static fraction(axis: Float64Array, v: number): number {
    const n = axis.length;
    if (n === 1 || v <= axis[0]) return 0;
    if (v >= axis[n - 1]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (axis[mid] <= v) lo = mid; else hi = mid;
    }
    return lo + (v - axis[lo]) / (axis[hi] - axis[lo]);
  }

  fx(lon: number): number { return CubeData.fraction(this.lons, lon); }
  fy(lat: number): number { return CubeData.fraction(this.lats, lat); }

  /**
   * The two levels a depth falls between and the weight of the deeper one, or the one
   * level that owns it in native mode. Precomputed per face row, so it is not in the
   * per-pixel loop.
   */
  levelsAt(depth: number, mode: Vertical): { k0: number; k1: number; w: number } {
    const d = this.depths;
    if (depth > this.maxDepth) return { k0: -1, k1: -1, w: 0 };
    if (mode === "native") {
      let k = 0;
      while (k < d.length - 1 && depth >= this.edges[k + 1]) k += 1;
      return { k0: k, k1: k, w: 0 };
    }
    if (depth <= d[0]) return { k0: 0, k1: 0, w: 0 };  // above the top level: the top level
    let k = 0;
    while (k < d.length - 2 && depth > d[k + 1]) k += 1;
    return { k0: k, k1: k + 1, w: (depth - d[k]) / (d[k + 1] - d[k]) };
  }

  /**
   * One value at fractional horizontal indices on a level pair. Bilinear where all four
   * neighbours are water; where some are not (a coast, the sea floor), the nearest water
   * neighbour, so a coastline does not bleed NaN a whole cell into the sea.
   */
  sample(fx: number, fy: number, lv: { k0: number; k1: number; w: number }): number {
    if (lv.k0 < 0) return NaN;
    const a = this.horizontal(fx, fy, lv.k0);
    if (lv.w === 0 || lv.k1 === lv.k0) return a;
    const b = this.horizontal(fx, fy, lv.k1);
    // Between the last water level and the first level below the floor, the water level
    // holds down to the midpoint between them, then the floor begins: no value is
    // invented below the deepest measurement.
    if (Number.isNaN(b)) return lv.w < 0.5 ? a : NaN;
    if (Number.isNaN(a)) return lv.w >= 0.5 ? b : NaN;
    return a + (b - a) * lv.w;
  }

  private horizontal(fx: number, fy: number, k: number): number {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, this.nx - 1);
    const y1 = Math.min(y0 + 1, this.ny - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v00 = this.value(x0, y0, k);
    const v10 = this.value(x1, y0, k);
    const v01 = this.value(x0, y1, k);
    const v11 = this.value(x1, y1, k);
    if (v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11) {
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
    const xi = tx < 0.5 ? x0 : x1;
    const yi = ty < 0.5 ? y0 : y1;
    return this.value(xi, yi, k);
  }

  /** Sea-floor depth at fractional indices, nearest cell. NaN is land. */
  floorAt(fx: number, fy: number): number {
    return this.floor(Math.round(fx), Math.round(fy));
  }

  /** Why a sample is empty: land (no column at all) or rock (below the sea floor). */
  kind(fx: number, fy: number, depth: number): "water" | "land" | "rock" {
    const f = this.floorAt(fx, fy);
    if (Number.isNaN(f)) return "land";
    return depth > f ? "rock" : "water";
  }

  valueAt(p: Point, mode: Vertical = "smooth"): number {
    return this.sample(this.fx(p.lon), this.fy(p.lat), this.levelsAt(p.depth, mode));
  }

  /** The whole column at one place, native levels only: for the probe's profile. */
  column(lon: number, lat: number): { depth: number; value: number }[] {
    const ix = Math.round(this.fx(lon));
    const iy = Math.round(this.fy(lat));
    const out = [];
    for (let k = 0; k < this.nz; k += 1) {
      const v = this.value(ix, iy, k);
      if (!Number.isNaN(v)) out.push({ depth: this.depths[k], value: v });
    }
    return out;
  }
}

// ------------------------------------------------------------------ depth axis

/** Depth (m) to a position down the face, 0 at the top of the range, 1 at the bottom. */
export function depthToT(depth: number, top: number, bottom: number, axis: DepthAxis): number {
  if (axis === "linear") return (depth - top) / (bottom - top);
  const s0 = Math.sqrt(top);
  return (Math.sqrt(depth) - s0) / (Math.sqrt(bottom) - s0);
}

/** The inverse: a position down the face back to metres. */
export function tToDepth(t: number, top: number, bottom: number, axis: DepthAxis): number {
  if (axis === "linear") return top + t * (bottom - top);
  const s0 = Math.sqrt(top);
  const s = s0 + t * (Math.sqrt(bottom) - s0);
  return s * s;
}

/**
 * Round-number depth ticks inside a range: the labels on the cube's edge. Chosen from
 * metres and placed through depthToT, so a label is always the depth at its height.
 */
export function depthTicks(top: number, bottom: number, axis: DepthAxis): number[] {
  const nice = [0, 50, 100, 200, 500, 1000, 2000, 3000, 4000, 5000, 6000];
  const inside = nice.filter((d) => d >= top && d <= bottom);
  // On a linear axis the shallow ticks crowd into the top edge; keep them at least 8% of
  // the height apart.
  const out: number[] = [];
  for (const d of inside) {
    const t = depthToT(d, top, bottom, axis);
    if (!out.length || t - depthToT(out[out.length - 1], top, bottom, axis) > 0.08) out.push(d);
  }
  return out;
}

/** A contour interval that gives about ten lines across a range. */
export function niceStep(lo: number, hi: number, lines = 10): number {
  const raw = Math.abs(hi - lo) / lines;
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * A catalogue variable from a loose name ("dissolved oxygen", "Oxygen", "sound_speed"):
 * the key or the title exactly, else a title containing the name. Never the other way
 * round: "phyto" contains "ph" and would build pH.
 */
export function matchVariable(want: string, options: { value: string; text: string }[]): string | undefined {
  const norm = (t: string) => t.toLowerCase().replace(/[_\s]+/g, " ").replace(/\s*\(.*\)$/, "").trim();
  const w = norm(want);
  if (!w) return undefined;
  return (options.find((o) => norm(o.value) === w || norm(o.text) === w)
    ?? options.find((o) => norm(o.text).includes(w)))?.value;
}

// ------------------------------------------------------------------ self-check

/** The sampling rules, checked once in development against a hand-built cube. */
export function demo(): void {
  const meta = {
    shape: [3, 2, 2], dimensions: [2, 2, 3] as [number, number, number],
    lons: [80, 81], lats: [10, 11], depths: [0.5, 100, 1000],
    valueRange: [0, 30] as [number, number], provenance: {} as CubeMeta["provenance"],
  };
  // x fastest, then y, then z. Column (1,1) is land; column (1,0) has its floor at 500 m.
  const values = new Float32Array([
    28, 28, 28, NaN,
    20, 20, 20, NaN,
    4, NaN, 4, NaN,
  ]);
  const floor = new Float32Array([4000, 500, 4000, NaN]);
  const c = new CubeData(meta as CubeMeta, values, floor);
  const ok = (cond: boolean, what: string) => console.assert(cond, `cube data: ${what}`);

  ok(c.value(0, 0, 2) === 4, "x fastest, then y, then z");
  ok(Math.abs(c.valueAt({ lon: 80, lat: 10, depth: 50.25 }) - 24) < 1e-6,
    "smooth: halfway between 0.5 m (28) and 100 m (20) is 24");
  ok(c.valueAt({ lon: 80, lat: 10, depth: 40 }, "native") === 28,
    "native: 40 m is inside the top level's cell (edge at 50.25 m)");
  ok(c.valueAt({ lon: 80, lat: 10, depth: 60 }, "native") === 20, "native: 60 m is level 2");
  ok(Number.isNaN(c.valueAt({ lon: 80, lat: 10, depth: 1200 })), "nothing below the last level");
  ok(c.valueAt({ lon: 81, lat: 10, depth: 300 }) === 20,
    "above the midpoint to a missing level, the water level holds");
  ok(Number.isNaN(c.valueAt({ lon: 81, lat: 10, depth: 800 })), "and below it, nothing");
  ok(c.kind(1, 1, 10) === "land" && c.kind(1, 0, 800) === "rock" && c.kind(0, 0, 10) === "water",
    "land and rock are told apart");
  ok(CubeData.fraction(Float64Array.from([0, 10, 30]), 20) === 1.5, "non-uniform axis");
  for (const axis of ["linear", "stretched"] as DepthAxis[]) {
    const t = depthToT(400, 0, 2000, axis);
    ok(Math.abs(tToDepth(t, 0, 2000, axis) - 400) < 1e-9, `${axis} depth mapping round-trips`);
  }
  ok(depthToT(500, 0, 2000, "stretched") === 0.5, "stretched: 500 m is halfway down 2000 m");
  ok(depthTicks(0, 2000, "stretched")[0] === 0 && depthTicks(0, 2000, "linear").includes(2000),
    "ticks start at the top and reach the bottom");
  ok(niceStep(2.7, 29.2) === 2, "contour step");
  const opts = [{ value: "ph", text: "pH" }, { value: "oxygen", text: "Dissolved oxygen (mmol/m³)" },
    { value: "phytoplankton", text: "Phytoplankton carbon (mmol/m³)" },
    { value: "sound_speed", text: "Speed of sound (m/s)" }];
  ok(matchVariable("dissolved oxygen", opts) === "oxygen" && matchVariable("Oxygen", opts) === "oxygen",
    "a variable by its title, in part or whole");
  ok(matchVariable("phyto", opts) === "phytoplankton", "phyto is phytoplankton, not pH");
  ok(matchVariable("sound_speed", opts) === "sound_speed" && matchVariable("pH", opts) === "ph", "by key");
  ok(matchVariable("salinity", opts) === undefined, "an unknown name matches nothing");
}
