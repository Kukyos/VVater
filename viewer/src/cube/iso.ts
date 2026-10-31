/**
 * An isosurface through the cube: every place the field equals one value, as a mesh.
 *
 * **Marching tetrahedra on the native grid.** Each cell between eight neighbouring grid
 * nodes (two native levels, two latitudes, two longitudes) is split into six tetrahedra
 * around its main diagonal, and the surface crosses each tetrahedron as one triangle or
 * two. Tetrahedra need no 256-case table and leave no holes between cells, which a
 * marching-cubes table can.
 *
 * What it does not do, on purpose:
 *   * **No new levels.** A vertex sits where the value crosses the level on an edge between
 *     two grid nodes, placed linearly between them; that is the same linear reading the
 *     "smooth" faces make between native levels, and no level is added (hard rule 3).
 *   * **Nothing across land or the sea floor.** A cell with any NaN corner is skipped, so
 *     the surface stops at the coast and the bottom instead of wrapping around them.
 *
 * Positions come out as (lon, lat, depth in metres); the scene maps depth to height
 * through its depth axis, never from an index (hard rule 4). Normals are computed in a
 * local frame (east, north and display height) so the scene can shade the surface without
 * a light that depends on the time of day.
 */

import { CubeData } from "./data";

export interface IsoMesh {
  /** lon, lat, depth (m) per vertex. */
  points: Float64Array;
  /** Unit normal per vertex in the local display frame (east, north, up). */
  normals: Float32Array;
  indices: Uint32Array;
  /** Cells that held the surface; 0 means the value is not reached inside the cut. */
  cells: number;
}

export interface IsoRange { ix0: number; ix1: number; iy0: number; iy1: number; iz0: number; iz1: number }

// The six tetrahedra of a cell, as corners 0..7 with corner c at (c&1, c>>1&1, c>>2&1).
const TETS = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7], [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];

/**
 * The surface where `data` equals `level`, inside a range of grid indices. `height` maps a
 * depth to display height, so normals are those of the surface as it is drawn.
 */
export function isosurface(data: CubeData, level: number, r: IsoRange,
                           height: (depth: number) => number): IsoMesh {
  const { nx, ny } = data;
  const latC = (data.lats[r.iy0] + data.lats[r.iy1]) / 2;
  const kx = 111_320 * Math.cos(latC * Math.PI / 180);
  const ky = 110_574;

  const pts: number[] = [];
  const local: number[] = [];  // x, y, z in metres, for normals
  const tris: number[] = [];
  const seen = new Map<number, number>();
  const nodes = nx * ny * data.nz;

  const node = (ix: number, iy: number, iz: number) => ix + nx * (iy + ny * iz);
  const cv = new Float64Array(8);
  const cn = new Int32Array(8);
  const cxyz = new Int32Array(24);

  /** The vertex on the edge between two corners, made once and shared by its neighbours. */
  const vertex = (a: number, b: number): number => {
    const na = cn[a], nb = cn[b];
    const key = na < nb ? na * nodes + nb : nb * nodes + na;
    const got = seen.get(key);
    if (got !== undefined) return got;
    const t = (level - cv[a]) / (cv[b] - cv[a]);
    const lon = lerp(data.lons[cxyz[a * 3]], data.lons[cxyz[b * 3]], t);
    const lat = lerp(data.lats[cxyz[a * 3 + 1]], data.lats[cxyz[b * 3 + 1]], t);
    const depth = lerp(data.depths[cxyz[a * 3 + 2]], data.depths[cxyz[b * 3 + 2]], t);
    const i = pts.length / 3;
    pts.push(lon, lat, depth);
    local.push(lon * kx, lat * ky, height(depth));
    seen.set(key, i);
    return i;
  };

  /** One triangle, wound so its normal points towards higher values. */
  const triangle = (i: number, j: number, k: number, up: [number, number, number]) => {
    const n = cross(local, i, j, k);
    if (n[0] * up[0] + n[1] * up[1] + n[2] * up[2] < 0) tris.push(i, k, j); else tris.push(i, j, k);
  };

  let cells = 0;
  for (let iz = r.iz0; iz < r.iz1; iz += 1) {
    for (let iy = r.iy0; iy < r.iy1; iy += 1) {
      for (let ix = r.ix0; ix < r.ix1; ix += 1) {
        let below = 0;
        let finite = true;
        for (let c = 0; c < 8; c += 1) {
          const x = ix + (c & 1), y = iy + ((c >> 1) & 1), z = iz + ((c >> 2) & 1);
          const v = data.value(x, y, z);
          if (v !== v) { finite = false; break; }
          cv[c] = v;
          cn[c] = node(x, y, z);
          cxyz[c * 3] = x; cxyz[c * 3 + 1] = y; cxyz[c * 3 + 2] = z;
          if (v < level) below += 1;
        }
        if (!finite || below === 0 || below === 8) continue;
        cells += 1;
        for (const tet of TETS) {
          const lo = tet.filter((c) => cv[c] < level);
          const hi = tet.filter((c) => cv[c] >= level);
          if (!lo.length || !hi.length) continue;
          const up = direction(cxyz, lo, hi, data, kx, ky, height);
          if (lo.length === 1 || hi.length === 1) {
            const [one, rest] = lo.length === 1 ? [lo[0], hi] : [hi[0], lo];
            triangle(vertex(one, rest[0]), vertex(one, rest[1]), vertex(one, rest[2]), up);
          } else {
            const a = vertex(lo[0], hi[0]), b = vertex(lo[0], hi[1]);
            const c = vertex(lo[1], hi[1]), d = vertex(lo[1], hi[0]);
            triangle(a, b, c, up);
            triangle(a, c, d, up);
          }
        }
      }
    }
  }

  // Smooth normals: each vertex the area-weighted mean of the triangles that share it.
  const normals = new Float32Array(pts.length);
  for (let t = 0; t < tris.length; t += 3) {
    const n = cross(local, tris[t], tris[t + 1], tris[t + 2]);
    for (let q = 0; q < 3; q += 1) {
      const v = tris[t + q] * 3;
      normals[v] += n[0]; normals[v + 1] += n[1]; normals[v + 2] += n[2];
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
    normals[v] /= l; normals[v + 1] /= l; normals[v + 2] /= l;
  }
  return { points: Float64Array.from(pts), normals, indices: Uint32Array.from(tris), cells };
}

/** The grid indices inside a cut: nodes whose coordinates fall within it. */
export function rangeFor(data: CubeData, cut: { lon0: number; lon1: number; lat0: number;
                                                lat1: number; top: number; bottom: number }):
  IsoRange | undefined {
  const within = (axis: Float64Array, a: number, b: number) => {
    let i0 = -1, i1 = -1;
    for (let i = 0; i < axis.length; i += 1) {
      if (axis[i] >= a - 1e-9 && axis[i] <= b + 1e-9) { if (i0 < 0) i0 = i; i1 = i; }
    }
    return [i0, i1];
  };
  const [ix0, ix1] = within(data.lons, cut.lon0, cut.lon1);
  const [iy0, iy1] = within(data.lats, cut.lat0, cut.lat1);
  const [iz0, iz1] = within(data.depths, cut.top, cut.bottom);
  if (ix1 - ix0 < 1 || iy1 - iy0 < 1 || iz1 - iz0 < 1) return undefined;
  return { ix0, ix1, iy0, iy1, iz0, iz1 };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function cross(p: number[], i: number, j: number, k: number): [number, number, number] {
  const ax = p[j * 3] - p[i * 3], ay = p[j * 3 + 1] - p[i * 3 + 1], az = p[j * 3 + 2] - p[i * 3 + 2];
  const bx = p[k * 3] - p[i * 3], by = p[k * 3 + 1] - p[i * 3 + 1], bz = p[k * 3 + 2] - p[i * 3 + 2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/** From the corners below the level to those above it, in the local frame. */
function direction(xyz: Int32Array, lo: number[], hi: number[], d: CubeData,
                   kx: number, ky: number, height: (depth: number) => number): [number, number, number] {
  const mean = (cs: number[]) => {
    let x = 0, y = 0, z = 0;
    for (const c of cs) {
      x += d.lons[xyz[c * 3]] * kx;
      y += d.lats[xyz[c * 3 + 1]] * ky;
      z += height(d.depths[xyz[c * 3 + 2]]);
    }
    return [x / cs.length, y / cs.length, z / cs.length];
  };
  const a = mean(lo), b = mean(hi);
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

// ------------------------------------------------------------------ self-check

/** A field that falls linearly with depth must give a flat sheet at the right depth. */
export function demo(): void {
  const ok = (cond: boolean, what: string) => console.assert(cond, `isosurface: ${what}`);
  const lons = [80, 81, 82], lats = [10, 11, 12], depths = [0, 50, 100, 200, 500];
  const nx = 3, ny = 3, nz = depths.length;
  const values = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) for (let i = 0; i < nx * ny; i += 1) values[z * nx * ny + i] = 30 - depths[z] / 10;
  const meta = { dimensions: [nx, ny, nz], lons, lats, depths } as never;
  const c = new CubeData(meta, values, new Float32Array(nx * ny).fill(4000));
  const all = { ix0: 0, ix1: 2, iy0: 0, iy1: 2, iz0: 0, iz1: nz - 1 };
  const m = isosurface(c, 15, all, (d) => -d);  // 30 - d/10 = 15 at 150 m
  ok(m.indices.length > 0 && m.cells === 4, "four cells hold the sheet");
  let flat = true;
  for (let v = 2; v < m.points.length; v += 3) flat &&= Math.abs(m.points[v] - 150) < 1e-9;
  ok(flat, "every vertex at 150 m, between the native 100 and 200 m levels");
  let level = true;
  for (let v = 0; v < m.points.length; v += 3) {
    level &&= Math.abs(c.valueAt({ lon: m.points[v], lat: m.points[v + 1], depth: m.points[v + 2] }) - 15) < 1e-4;
  }
  ok(level, "the field reads the iso value at every vertex");
  let facing = true;
  for (let v = 2; v < m.normals.length; v += 3) facing &&= m.normals[v] > 0.99;
  ok(facing, "normals point towards higher values: here the shallower water, which is up");
  ok(isosurface(c, 99, all, (d) => -d).indices.length === 0, "a value never reached gives nothing");
  values[1 * nx * ny + 4] = NaN;  // the centre node at 50 m: land or rock there
  ok(isosurface(c, 27.5, all, (d) => -d).cells === 0, "no cell with a missing corner holds a surface");
  ok(rangeFor(c, { lon0: 80, lon1: 81, lat0: 10, lat1: 12, top: 0, bottom: 100 })!.ix1 === 1,
     "a cut keeps the nodes inside it");
}
