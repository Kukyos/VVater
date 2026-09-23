/**
 * A horizontal section through the loaded volume, drawn as an image for the 2D map.
 *
 * Cesium's VoxelPrimitive is 3D-only, so the map view cannot show the volume itself. It
 * shows the one thing a map can: the field at the slice depth, coloured by exactly the
 * ramp the voxel shader uses. Built from the values already in memory, so switching to
 * the map costs no request and always matches what the 3D view is drawing.
 *
 * Two index traps, both asserted below:
 *   - voxel z = 0 is the DEEPEST level (server/ocean/volume.py:_flatten), while the
 *     depth grid and the slider run shallow to deep, so depth index k is z = nz - 1 - k;
 *   - voxel y = 0 is the southern edge, and a canvas row 0 is the top, so rows flip.
 */

import { RAMP_STOPS, byId, paletteStops } from "./colorbar";

/** The values at depth index k, as ny rows of nx, north row first. */
export function sliceNorthUp(values: Float32Array, dims: [number, number, number],
                             k: number): Float32Array {
  const [nx, ny, nz] = dims;
  const z = nz - 1 - Math.min(Math.max(k, 0), nz - 1);
  const out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y += 1) {
    const row = ny - 1 - y;
    for (let x = 0; x < nx; x += 1) out[row * nx + x] = values[x + nx * (y + ny * z)];
  }
  return out;
}

export interface SectionStyle {
  paletteId: string;
  reversed: boolean;
  range: [number, number];
  logScale: boolean;
  errorWeight: number;
  /** Nearest-neighbour blocks rather than smoothed: the residual is one bin per cell. */
  blocky: boolean;
}

/** Same mapping as the GLSL in voxels.ts: six stops, linear, optional log. */
export function colourAt(value: number, style: SectionStyle,
                  stops: [number, number, number][]): [number, number, number] {
  const [lo, hi] = style.range;
  let t: number;
  if (style.logScale) {
    const safeLo = Math.max(lo, 1e-6);
    t = (Math.log(Math.max(value, safeLo)) - Math.log(safeLo)) /
      Math.max(Math.log(Math.max(hi, safeLo + 1e-6)) - Math.log(safeLo), 1e-6);
  } else {
    t = (value - lo) / Math.max(hi - lo, 1e-6);
  }
  const scaled = Math.min(Math.max(t, 0), 1) * (RAMP_STOPS - 1);
  const i = Math.min(Math.floor(scaled), RAMP_STOPS - 2);
  const f = scaled - i;
  return [0, 1, 2].map((c) => stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f) as
    [number, number, number];
}

/** The section as a canvas, upscaled so the map filters it the way we choose. */
export function sectionCanvas(values: Float32Array, errors: Float32Array | null,
                              dims: [number, number, number], k: number,
                              style: SectionStyle): HTMLCanvasElement {
  const [nx, ny] = dims;
  const slice = sliceNorthUp(values, dims, k);
  const err = errors ? sliceNorthUp(errors, dims, k) : null;
  const stops = paletteStops(byId(style.paletteId), style.reversed, RAMP_STOPS);

  const small = document.createElement("canvas");
  small.width = nx;
  small.height = ny;
  const context = small.getContext("2d")!;
  const image = context.createImageData(nx, ny);
  for (let i = 0; i < slice.length; i += 1) {
    const value = slice[i];
    // NaN is land or below the sea floor; -1e30 is an empty residual bin. Both clear.
    if (Number.isNaN(value) || value < -1e29) continue;
    const [r, g, b] = colourAt(value, style, stops);
    let alpha = 1;
    const e = err?.[i];
    if (e !== undefined && !Number.isNaN(e)) {
      alpha *= 1 + (Math.min(Math.max(1 - e, 0.05), 1) - 1) * style.errorWeight;
    }
    image.data.set([r * 255, g * 255, b * 255, alpha * 255], i * 4);
  }
  context.putImageData(image, 0, 0);

  const SCALE = 16;
  const big = document.createElement("canvas");
  big.width = nx * SCALE;
  big.height = ny * SCALE;
  const bigContext = big.getContext("2d")!;
  bigContext.imageSmoothingEnabled = !style.blocky;
  bigContext.drawImage(small, 0, 0, big.width, big.height);
  return big;
}

/**
 * The global surface layer (server/ocean/globalsurface.py) as a canvas, coloured with the
 * field's own palette and range so one colour means one temperature everywhere on screen.
 * The region's box is cut out: the volume is drawn there, and a surface image over it
 * would tint the very thing the view exists to show.
 */
export function surfaceCanvas(values: Float32Array, nx: number, ny: number,
                              lonRange: [number, number], latRange: [number, number],
                              style: SectionStyle,
                              hole: { lon: [number, number]; lat: [number, number] }): HTMLCanvasElement {
  const stops = paletteStops(byId(style.paletteId), style.reversed, RAMP_STOPS);
  const canvas = document.createElement("canvas");
  canvas.width = nx;
  canvas.height = ny;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(nx, ny);
  const dLon = (lonRange[1] - lonRange[0]) / (nx - 1);
  const dLat = (latRange[1] - latRange[0]) / (ny - 1);
  for (let row = 0; row < ny; row += 1) {
    const lat = latRange[1] - row * dLat;
    const inLat = lat >= hole.lat[0] && lat <= hole.lat[1];
    for (let x = 0; x < nx; x += 1) {
      const value = values[row * nx + x];
      if (Number.isNaN(value)) continue;
      const lon = lonRange[0] + x * dLon;
      if (inLat && lon >= hole.lon[0] && lon <= hole.lon[1]) continue;
      const [r, g, b] = colourAt(value, style, stops);
      image.data.set([r * 255, g * 255, b * 255, 255], (row * nx + x) * 4);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** The two index traps, checked once in development. */
export function demo(): void {
  // 2 x 2 x 3 volume, value = 100 z + 10 y + x.
  const dims: [number, number, number] = [2, 2, 3];
  const v = new Float32Array(12);
  for (let z = 0; z < 3; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++)
    v[x + 2 * (y + 2 * z)] = 100 * z + 10 * y + x;
  const top = sliceNorthUp(v, dims, 0);     // shallowest = z 2
  console.assert(top[0] === 210 && top[3] === 201, "section: k=0 must be z=nz-1, north row first");
  const bottom = sliceNorthUp(v, dims, 2);  // deepest = z 0
  console.assert(bottom[2] === 0, "section: deepest level must be z=0");
}
