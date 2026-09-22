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
