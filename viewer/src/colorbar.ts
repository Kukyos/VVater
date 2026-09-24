/**
 * The colourbar editor the brief asks for: palette, min/max, linear or log.
 *
 * A palette is a list of stops. The shader evaluates the ramp from six of them
 * (`paletteStops`); the UI draws the same stops into a canvas for the legend. Changing
 * palette is six uniform writes and changing range is one — neither recompiles the
 * shader nor refetches anything.
 *
 * The oceanographic palettes are the cmocean family (Thyng et al. 2016), which exist
 * because the usual rainbow maps invent banding that is not in the data and lose detail
 * for readers with colour vision deficiency. `thermal` and `haline` are approximated
 * here from published anchor points rather than shipped at full fidelity — noted in
 * docs/10-unsourced.md.
 */

export interface Palette {
  id: string;
  label: string;
  note?: string;
  /** Diverging palettes are centred on zero and must be used with a symmetric range. */
  diverging?: boolean;
  stops: [number, number, number][];
}

export const PALETTES: Palette[] = [
  {
    id: "thermal",
    label: "Thermal",
    note: "cmocean thermal — the conventional choice for sea temperature",
    stops: [
      [3, 35, 51], [18, 54, 110], [62, 73, 137], [104, 89, 134],
      [151, 104, 116], [197, 122, 88], [231, 152, 60], [248, 191, 55],
      [232, 236, 116],
    ],
  },
  {
    id: "haline",
    label: "Haline",
    note: "cmocean haline — for salinity",
    stops: [
      [41, 24, 107], [21, 60, 128], [10, 96, 123], [21, 130, 113],
      [66, 161, 94], [140, 187, 74], [216, 205, 96], [253, 238, 153],
    ],
  },
  {
    id: "viridis",
    label: "Viridis",
    note: "perceptually uniform, colour-vision safe",
    stops: [
      [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
      [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
      [180, 222, 44], [253, 231, 37],
    ],
  },
  {
    id: "balance",
    label: "Balance (diverging)",
    note: "cmocean balance — for residuals, where the sign matters and zero is the middle",
    diverging: true,
    stops: [
      [24, 28, 89], [42, 83, 160], [93, 146, 200], [175, 203, 224],
      [247, 247, 247],
      [239, 185, 168], [216, 118, 96], [170, 52, 46], [103, 0, 31],
    ],
  },
  // The rest of the cmocean family, for the variables the global cube adds. Approximated
  // from published anchor points like thermal and haline (docs/10-unsourced.md).
  {
    id: "speed",
    label: "Speed",
    note: "cmocean speed — for current speed and sound speed",
    stops: [
      [255, 253, 205], [222, 224, 149], [176, 200, 97], [122, 177, 59], [67, 151, 43],
      [27, 120, 43], [20, 86, 39], [17, 55, 31], [23, 35, 19],
    ],
  },
  {
    id: "dense",
    label: "Dense",
    note: "cmocean dense — for density",
    stops: [
      [230, 241, 241], [182, 216, 229], [142, 190, 225], [118, 160, 227], [114, 125, 221],
      [117, 89, 196], [111, 57, 154], [91, 33, 104], [54, 14, 36],
    ],
  },
  {
    id: "algae",
    label: "Algae",
    note: "cmocean algae — for chlorophyll and phytoplankton",
    stops: [
      [215, 249, 208], [171, 222, 160], [123, 196, 113], [73, 171, 71], [30, 144, 54],
      [17, 114, 51], [18, 85, 44], [19, 58, 34], [18, 36, 20],
    ],
  },
  {
    id: "oxy",
    label: "Oxy",
    note: "cmocean oxy — red marks the oxygen-poor end, yellow the supersaturated end",
    stops: [
      [64, 5, 5], [136, 14, 14], [92, 91, 90], [128, 127, 126], [166, 165, 164],
      [206, 205, 204], [241, 240, 238], [233, 232, 69], [248, 248, 169],
    ],
  },
  {
    id: "matter",
    label: "Matter",
    note: "cmocean matter — for nutrients and carbon",
    stops: [
      [253, 237, 176], [246, 197, 138], [237, 157, 108], [224, 117, 93], [202, 82, 93],
      [170, 55, 97], [132, 35, 95], [90, 24, 82], [47, 15, 62],
    ],
  },
  {
    id: "deep",
    label: "Deep",
    note: "cmocean deep — for depths, such as the mixed layer",
    stops: [
      [253, 254, 204], [176, 227, 180], [101, 196, 170], [65, 158, 168], [64, 120, 159],
      [62, 82, 144], [60, 50, 107], [48, 32, 68], [40, 26, 44],
    ],
  },
  {
    id: "ice",
    label: "Ice",
    note: "cmocean ice — for sea ice",
    stops: [
      [4, 6, 19], [29, 31, 64], [54, 55, 114], [62, 89, 158], [70, 127, 178],
      [100, 164, 195], [146, 197, 210], [196, 229, 230], [234, 253, 253],
    ],
  },
  {
    id: "grey",
    label: "Greyscale",
    note: "for print, and for checking that structure is not a colour artefact",
    stops: [[20, 20, 20], [240, 240, 240]],
  },
];

export const DEFAULT_PALETTE_FOR: Record<string, string> = {
  temperature: "thermal",
  salinity: "haline",
  // Counts are not a physical field, so a perceptually uniform ramp beats an
  // oceanographic one: the question is "how many", not "how warm".
  observations: "viridis",
  // A residual has a sign. A sequential ramp on signed data is how people misread
  // residual plots: it makes -0.1 and +0.1 look like different magnitudes.
  residual: "balance",
};

/** A wide, visible version of the same palette for the legend strip in the UI. */
export function renderLegend(palette: Palette, reversed: boolean,
                             width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("could not get a 2d context for the legend");
  }

  const stops = reversed ? [...palette.stops].reverse() : palette.stops;
  const gradient = context.createLinearGradient(0, 0, width, 0);
  stops.forEach((stop, index) => {
    gradient.addColorStop(index / (stops.length - 1), `rgb(${stop[0]},${stop[1]},${stop[2]})`);
  });

  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  return canvas;
}

export const byId = (id: string): Palette =>
  PALETTES.find((p) => p.id === id) ?? PALETTES[0];

/** True when a palette id names a real palette. byId falls back to thermal silently,
 * which would draw chlorophyll in temperature colours; callers that take ids from the
 * server check with this first and say so. */
export const hasPalette = (id: string): boolean => PALETTES.some((p) => p.id === id);

/**
 * The palette as a 256-entry RGBA lookup table, for painting on the CPU. The cube's faces
 * use this rather than the six-stop shader ramp (D-10): they are painted in JavaScript,
 * so the full palette costs nothing and sharp palettes such as oxy keep their edges.
 */
export function paletteLut(palette: Palette, reversed = false): Uint8ClampedArray {
  const stops = reversed ? [...palette.stops].reverse() : palette.stops;
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i += 1) {
    const position = (i / 255) * (stops.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, stops.length - 1);
    const frac = position - lower;
    for (let c = 0; c < 3; c += 1) {
      lut[i * 4 + c] = stops[lower][c] + (stops[upper][c] - stops[lower][c]) * frac;
    }
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/**
 * A log scale needs a strictly positive lower bound, and sea temperature in this region
 * goes to about 2 degC but salinity and chlorophyll do not behave the same way. Rather
 * than silently clamping — which would draw a range the user did not ask for — the
 * control refuses and says why.
 */
export function logScaleAllowed(lo: number): { ok: boolean; reason?: string } {
  if (lo > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `log scale needs a positive minimum; this range starts at ${lo.toFixed(2)}`,
  };
}


/**
 * Resample a palette down to exactly `count` evenly spaced stops, normalised to 0..1.
 *
 * The shader interpolates between these directly instead of sampling a lookup texture.
 * That is not a stylistic choice: CesiumJS builds `CustomShader` texture uniforms
 * through a path that needs its context limits already populated, and in this setup they
 * are not by the time a VoxelPrimitive first updates — every palette upload failed with
 * "maximum texture size (0)" and rendering stopped. Six interpolated stops reproduce
 * these ramps closely, cost six vec3 uniforms instead of a 1 KB texture upload per
 * palette change, and remove the failure mode rather than working around it.
 */
export function paletteStops(palette: Palette, reversed = false,
                             count = RAMP_STOPS): [number, number, number][] {
  const stops = reversed ? [...palette.stops].reverse() : palette.stops;
  const out: [number, number, number][] = [];

  for (let i = 0; i < count; i += 1) {
    const position = (i / (count - 1)) * (stops.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, stops.length - 1);
    const frac = position - lower;
    out.push([0, 1, 2].map((c) =>
      (stops[lower][c] + (stops[upper][c] - stops[lower][c]) * frac) / 255,
    ) as [number, number, number]);
  }
  return out;
}

/** How many stops the shader ramp carries. Changing this means editing the GLSL too. */
export const RAMP_STOPS = 6;

/**
 * Force a range symmetric about zero.
 *
 * A diverging palette puts its neutral colour at the midpoint of the range, so unless
 * the range is symmetric that neutral sits at some arbitrary non-zero value and the map
 * lies about which cells are unbiased.
 */
export function symmetricRange(lo: number, hi: number): [number, number] {
  const extent = Math.max(Math.abs(lo), Math.abs(hi), 1e-6);
  return [-extent, extent];
}
