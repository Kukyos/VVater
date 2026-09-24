/**
 * Faces of the cube as images: a vertical section along any line of constant latitude or
 * longitude, or a horizontal section at any depth. Painted on the CPU from `CubeData`, so
 * every pixel is a sampled data value through the colour bar the user set, and nothing
 * the GPU does can change what a colour means.
 *
 * Empty pixels are told apart and both drawn solid, so the cube reads as one block cut
 * out of the planet: **land** (no water in the column at all) in a pale earth colour, and
 * **rock** (below the sea floor) darker and shaded by depth, with the sea floor itself
 * edged in light so its shape reads on every wall. Neither colour is on the colour bar's
 * ramp, so neither can be mistaken for a value.
 */

import { CubeData, type DepthAxis, type Vertical, depthToT, tToDepth } from "./data";

export interface Style {
  lut: Uint8ClampedArray;    // 256 x RGBA, from colorbar.paletteLut
  lo: number;
  hi: number;
  log: boolean;
  /** Contour interval in data units; 0 draws none. */
  step: number;
  vertical: Vertical;
  axis: DepthAxis;
  /** The cube's own depth range, which the depth axis maps. */
  cubeTop: number;
  cubeBottom: number;
}

const ROCK: [number, number, number] = [58, 50, 44];
/** Shared with the sea-floor mesh, so a continent's top and its sides are one colour. */
export const LAND: [number, number, number] = [112, 104, 90];
const FLOOR_EDGE: [number, number, number] = [210, 196, 170];

/** Colour index 0..255 for a value, or -1 for no value. */
function index(v: number, s: Style): number {
  if (v !== v) return -1;
  let t: number;
  if (s.log) {
    const lo = Math.log(Math.max(s.lo, 1e-9));
    const hi = Math.log(Math.max(s.hi, 1e-9));
    t = (Math.log(Math.max(v, 1e-9)) - lo) / (hi - lo || 1);
  } else {
    t = (v - s.lo) / (s.hi - s.lo || 1);
  }
  return Math.max(0, Math.min(255, Math.round(t * 255)));
}

/** A value's colour through the style's colour bar, for things drawn outside a face. */
export function rgbFor(v: number, s: Style): [number, number, number] {
  const k = Math.max(index(v, s), 0);
  return [s.lut[k * 4], s.lut[k * 4 + 1], s.lut[k * 4 + 2]];
}

/** Contour band a value falls in; lines are drawn where neighbouring bands differ. */
function band(v: number, s: Style): number {
  if (v !== v || s.step <= 0) return NaN;
  return Math.floor(v / s.step);
}

/**
 * Turn a grid of sampled values into RGBA. `kinds` marks why an empty pixel is empty
 * (0 water, 1 land, 2 rock) so rock can be drawn and land left out.
 */
function colour(values: Float32Array, kinds: Uint8Array, width: number, height: number,
                s: Style, shadeRock: (row: number) => number, floorEdge: boolean): ImageData {
  const image = new ImageData(width, height);
  const px = image.data;
  for (let r = 0; r < height; r += 1) {
    const rockShade = shadeRock(r);
    for (let c = 0; c < width; c += 1) {
      const i = r * width + c;
      const o = i * 4;
      const v = values[i];
      const k = index(v, s);
      if (k >= 0) {
        px[o] = s.lut[k * 4];
        px[o + 1] = s.lut[k * 4 + 1];
        px[o + 2] = s.lut[k * 4 + 2];
        px[o + 3] = 255;
        if (s.step > 0) {
          const b = band(v, s);
          const right = c + 1 < width ? band(values[i + 1], s) : b;
          const below = r + 1 < height ? band(values[i + width], s) : b;
          if ((right === right && right !== b) || (below === below && below !== b)) {
            px[o] *= 0.55;
            px[o + 1] *= 0.55;
            px[o + 2] *= 0.55;
          }
        }
      } else if (kinds[i] === 2) {
        // The sea floor: the first rock pixel under water gets a light edge.
        const above = r > 0 ? i - width : -1;
        const edge = floorEdge && above >= 0 && values[above] === values[above];
        const rgb = edge ? FLOOR_EDGE : ROCK;
        const shade = edge ? 1 : rockShade;
        px[o] = rgb[0] * shade;
        px[o + 1] = rgb[1] * shade;
        px[o + 2] = rgb[2] * shade;
        px[o + 3] = 255;
      } else {
        px[o] = LAND[0];
        px[o + 1] = LAND[1];
        px[o + 2] = LAND[2];
        px[o + 3] = 255;
      }
    }
  }
  return image;
}

function toCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas;
}

/** A line along the surface: constant latitude (lon varies) or constant longitude. */
export interface Line { lon0: number; lat0: number; lon1: number; lat1: number }

/**
 * A vertical section along `line`, from depth `top` to `bottom`. Row 0 is the top. Rows
 * are uniform in the cube's depth axis (linear or stretched), because the wall they are
 * drawn on is uniform in height; each row's depth comes back through tToDepth.
 */
export function paintWall(c: CubeData, line: Line, top: number, bottom: number, s: Style,
                          width: number, height: number): HTMLCanvasElement {
  const values = new Float32Array(width * height);
  const kinds = new Uint8Array(width * height);
  const t0 = depthToT(top, s.cubeTop, s.cubeBottom, s.axis);
  const t1 = depthToT(bottom, s.cubeTop, s.cubeBottom, s.axis);
  const nearest = s.vertical === "native";

  // Per column: where along the line, in fractional grid indices.
  const fxs = new Float64Array(width);
  const fys = new Float64Array(width);
  for (let col = 0; col < width; col += 1) {
    const f = width === 1 ? 0 : col / (width - 1);
    let fx = c.fx(line.lon0 + (line.lon1 - line.lon0) * f);
    let fy = c.fy(line.lat0 + (line.lat1 - line.lat0) * f);
    if (nearest) { fx = Math.round(fx); fy = Math.round(fy); }
    fxs[col] = fx;
    fys[col] = fy;
  }
  const depthOfRow = new Float64Array(height);
  for (let row = 0; row < height; row += 1) {
    const t = t0 + (t1 - t0) * (height === 1 ? 0 : row / (height - 1));
    const depth = tToDepth(t, s.cubeTop, s.cubeBottom, s.axis);
    depthOfRow[row] = depth;
    const lv = c.levelsAt(depth, s.vertical);
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const v = c.sample(fxs[col], fys[col], lv);
      values[i] = v;
      if (v !== v) {
        const kind = c.kind(fxs[col], fys[col], depth);
        kinds[i] = kind === "land" ? 1 : kind === "rock" ? 2 : 1;
      }
    }
  }
  // Rock darkens with depth, so the floor has form rather than being a flat silhouette.
  const shade = (row: number) => 1.25 - 0.75 * (depthOfRow[row] / Math.max(s.cubeBottom, 1));
  return toCanvas(colour(values, kinds, width, height, s, shade, true));
}

/**
 * A horizontal section at `depth` over a longitude/latitude window. Row 0 is north,
 * because a texture's first row lands at the top of the image and Cesium maps a
 * rectangle's image north-up.
 */
export function paintLevel(c: CubeData, lon0: number, lon1: number, lat0: number,
                           lat1: number, depth: number, s: Style,
                           width: number, height: number): HTMLCanvasElement {
  const values = new Float32Array(width * height);
  const kinds = new Uint8Array(width * height);
  const lv = c.levelsAt(depth, s.vertical);
  const nearest = s.vertical === "native";
  for (let row = 0; row < height; row += 1) {
    const lat = lat1 + (lat0 - lat1) * (height === 1 ? 0 : row / (height - 1));
    let fy = c.fy(lat);
    if (nearest) fy = Math.round(fy);
    for (let col = 0; col < width; col += 1) {
      const lon = lon0 + (lon1 - lon0) * (width === 1 ? 0 : col / (width - 1));
      let fx = c.fx(lon);
      if (nearest) fx = Math.round(fx);
      const i = row * width + col;
      const v = c.sample(fx, fy, lv);
      values[i] = v;
      if (v !== v) kinds[i] = c.kind(fx, fy, depth) === "rock" ? 2 : 1;
    }
  }
  return toCanvas(colour(values, kinds, width, height, s, () => 0.9, false));
}

/**
 * The sea floor as a texture for its mesh: earth tones by depth with a baked hillshade,
 * so canyons and shelves read without scene lighting. Row 0 is north. Land is left
 * transparent; the mesh raises it to the top of the cube and colours it separately.
 */
export function paintFloor(c: CubeData, bottom: number): HTMLCanvasElement {
  const w = c.nx;
  const h = c.ny;
  const image = new ImageData(w, h);
  const px = image.data;
  const depthAt = (x: number, y: number) => {
    const f = c.floor(Math.min(Math.max(x, 0), w - 1), Math.min(Math.max(y, 0), h - 1));
    return Number.isNaN(f) ? 0 : Math.min(f, bottom);
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = ((h - 1 - y) * w + x) * 4;  // data is south first, the image north first
      const f = c.floor(x, y);
      if (Number.isNaN(f)) {
        px[o] = LAND[0]; px[o + 1] = LAND[1]; px[o + 2] = LAND[2]; px[o + 3] = 255;
        continue;
      }
      // Slope toward a light from the north-west, in depth metres per cell.
      const dzdx = (depthAt(x + 1, y) - depthAt(x - 1, y)) / 2;
      const dzdy = (depthAt(x, y + 1) - depthAt(x, y - 1)) / 2;
      const light = Math.max(0.35, Math.min(1.25, 0.85 + (dzdx - dzdy) / 900));
      const t = Math.min(Math.min(f, bottom) / Math.max(bottom, 1), 1);
      // Shelf sand to abyssal slate.
      px[o] = (156 - 110 * t) * light;
      px[o + 1] = (138 - 96 * t) * light;
      px[o + 2] = (110 - 62 * t) * light;
      px[o + 3] = 255;
    }
  }
  return toCanvas(image);
}
