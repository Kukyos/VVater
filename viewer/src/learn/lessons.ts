/**
 * The course: six short lessons for school students (class 8 to 12), as data.
 *
 * A step says something, may move the viewer (the same whitelisted actions the assistant
 * uses, so a lesson can do nothing the assistant could not), and may ask for a place, wait
 * for the student to do something, or ask a question.
 *
 * Quiz answers are read from the data on screen wherever the question is about the ocean,
 * never typed in here: "is 500 m colder than the surface?" is answered by the cube the
 * student is looking at. The few general facts a lesson states are sourced in
 * docs/19-course.md.
 */

import type { ChatAction, SeaState } from "../api";
import type { CubeController } from "../cube/controller";

export interface Place { name: string; lat: number; lon: number }

/** What a step can read: the student's place, the sea near it, the cube, and a scratchpad. */
export interface Ctx {
  place: Place;
  sea?: SeaState;
  cube: CubeController;
  today: string;
  /** Values a lesson keeps between steps (the cube before a cyclone, say). */
  memo: Record<string, number>;
}

type Text = string | ((c: Ctx) => string);

export type Quiz =
  | { kind: "choice"; q: Text; options: string[] | ((c: Ctx) => string[]);
      answer: number | ((c: Ctx) => number); why: Text }
  | { kind: "pick"; q: Text; box: [number, number, number, number]; why: Text;
      /** Also require water there, by the cube on screen (which must cover the box). */
      sea?: boolean };

export interface Step {
  say: Text;
  /** Viewer actions, run in order; the cube is waited for afterwards. */
  do?: (c: Ctx) => ChatAction[];
  /** Runs after `do`, once the cube is on screen: read values into `memo`. */
  after?: (c: Ctx) => void;
  /** Viewer actions run once the cube is on screen (a colour range for that cube, say). */
  then?: (c: Ctx) => ChatAction[];
  /** Ask for the student's town or city. */
  place?: boolean;
  /** Next stays locked until this is true (polled): "click a float", say. */
  wait?: { hint: string; until: (c: Ctx) => boolean };
  quiz?: Quiz;
}

export interface Lesson { id: string; title: string; goal: string; steps: Step[] }

// ------------------------------------------------------------------ reading the cube

const fmt = (v: number, d = 1) => v.toFixed(d);
const ns = (lat: number) => `${fmt(Math.abs(lat), 1)}°${lat >= 0 ? "N" : "S"}`;
const ew = (lon: number) => `${fmt(Math.abs(lon), 1)}°${lon >= 0 ? "E" : "W"}`;

/**
 * The deepest water column in the cube, the one nearest its centre among equals: a
 * coastal box's middle can be a 30 m shelf, which says nothing about the deep.
 */
export function centreColumn(c: Ctx): { depth: number; value: number }[] {
  const d = c.cube.data;
  if (!d) return [];
  let best = { levels: -1, dist: Infinity, ix: 0, iy: 0 };
  for (let iy = 0; iy < d.ny; iy += 1) {
    for (let ix = 0; ix < d.nx; ix += 1) {
      let levels = 0;
      while (levels < d.nz && Number.isFinite(d.value(ix, iy, levels))) levels += 1;
      const dist = (ix - d.nx / 2) ** 2 + (iy - d.ny / 2) ** 2;
      if (levels > best.levels || (levels === best.levels && dist < best.dist)) {
        best = { levels, dist, ix, iy };
      }
    }
  }
  return d.column(d.lons[best.ix], d.lats[best.iy]);
}

/** Mean of the cube's top level over the part of the box that is sea. */
export function surfaceMean(c: Ctx, box?: [number, number, number, number]): number {
  const d = c.cube.data;
  if (!d) return NaN;
  let sum = 0;
  let n = 0;
  for (let iy = 0; iy < d.ny; iy += 1) {
    for (let ix = 0; ix < d.nx; ix += 1) {
      const lon = d.lons[ix] > 180 ? d.lons[ix] - 360 : d.lons[ix];
      if (box && !(lon >= box[0] && lon <= box[1] && d.lats[iy] >= box[2] && d.lats[iy] <= box[3])) continue;
      const v = d.value(ix, iy, 0);
      if (Number.isFinite(v)) { sum += v; n += 1; }
    }
  }
  return n ? sum / n : NaN;
}

/** Mean over the upper `depth` metres of the box: levels at or above it, sea cells only. */
export function upperMean(c: Ctx, depth: number, box: [number, number, number, number]): number {
  const d = c.cube.data;
  if (!d) return NaN;
  let sum = 0;
  let n = 0;
  for (let iz = 0; iz < d.nz && d.depths[iz] <= depth; iz += 1) {
    for (let iy = 0; iy < d.ny; iy += 1) {
      for (let ix = 0; ix < d.nx; ix += 1) {
        const lon = d.lons[ix] > 180 ? d.lons[ix] - 360 : d.lons[ix];
        if (!(lon >= box[0] && lon <= box[1] && d.lats[iy] >= box[2] && d.lats[iy] <= box[3])) continue;
        const v = d.value(ix, iy, iz);
        if (Number.isFinite(v)) { sum += v; n += 1; }
      }
    }
  }
  return n ? sum / n : NaN;
}

/** Depth where temperature falls fastest in a column: the heart of the thermocline. */
export function steepestDepth(col: { depth: number; value: number }[]): number {
  let best = NaN;
  let drop = -Infinity;
  for (let k = 1; k < col.length; k += 1) {
    const g = (col[k - 1].value - col[k].value) / Math.max(col[k].depth - col[k - 1].depth, 1e-6);
    if (g > drop) { drop = g; best = (col[k].depth + col[k - 1].depth) / 2; }
  }
  return best;
}

/** A box around a point, clipped to the latitudes the products cover. */
const q = (v: number) => Math.round(v * 4) / 4;  // quarter degrees: a tidy box and URL
const around = (lat: number, lon: number, r: number) => ({
  west: q(lon - r), east: q(lon + r), south: q(Math.max(lat - r, -79)), north: q(Math.min(lat + r, 89)),
});

const valueNear = (col: { depth: number; value: number }[], depth: number) =>
  col.reduce((a, b) => (Math.abs(b.depth - depth) < Math.abs(a.depth - depth) ? b : a), col[0]);

// ------------------------------------------------------------------ the course

// Where a lesson centres when the student skipped the place question: Chennai.
export const DEFAULT_PLACE: Place = { name: "Chennai", lat: 13.08, lon: 80.27 };

// The monsoon lesson reads the eastward current across this strip south of Sri Lanka.
const SRI_LANKA_STRIP: [number, number, number, number] = [78, 88, 3, 7];
// Where Amphan crossed the coast (IMD's report: the Sundarbans, near 21.65 N 88.3 E,
// 20 May 2020); the pick-quiz accepts a generous box around it.
const AMPHAN_LANDFALL: [number, number, number, number] = [86.5, 90.5, 20.5, 23.5];
const BAY_OF_BENGAL: [number, number, number, number] = [80, 95, 5, 23];

export const LESSONS: Lesson[] = [
  {
    id: "your-ocean",
    title: "Your ocean",
    goal: "Find the sea nearest you and read today's waves and wind there.",
    steps: [
      {
        say: "This is the whole Earth. The colour on the sea is the temperature of its " +
          "surface water, bright yellow warm and dark purple cold, and the moving streaks are the ocean's " +
          "currents. Let's start with the sea nearest you.",
        // The Bay cube stays loaded, hidden: the Bay of Bengal quiz reads its land mask.
        do: () => [{ action: "set_control", target: "cube-scenario", value: "bay_of_bengal" },
                   { action: "show_cube", on: false }, { action: "set_view", view: "globe" }],
      },
      { say: "Which town or city do you live in?", place: true },
      {
        say: (c) => c.sea
          ? `The sea nearest ${c.place.name} is ${Math.round(c.sea.distance_km)} km away, at ` +
            `${ns(c.sea.sea_point[0])} ${ew(c.sea.sea_point[1])}. Today the waves there are ` +
            `about ${fmt(c.sea.wave_height_m)} m high` +
            (c.sea.wind_ms !== null ? ` and the wind is ${fmt(c.sea.wind_ms)} m/s ` +
              `(${Math.round(c.sea.wind_ms * 3.6)} km/h)` : "") +
            `. These come from a wave model, ${c.sea.wave_provenance.dataset}, at ` +
            `${c.sea.wave_provenance.time_utc.slice(11, 16)} UTC.`
          : `We could not read today's waves near ${c.place.name}; the lesson carries on with the map.`,
        do: (c) => {
          const [lat, lon] = c.sea?.sea_point ?? [c.place.lat, c.place.lon];
          return [{ action: "look_down", lat, lon }];
        },
      },
      {
        say: "The amber streaks are the wind, the white ones the water. Waves are made by " +
          "wind blowing over the sea: the stronger it blows, and the longer and farther, " +
          "the bigger they grow. Watch them for a moment.",
        do: () => [{ action: "set_control", target: "ocean-air", value: true },
                   { action: "set_control", target: "ocean-wind", value: true }],
      },
      {
        say: "Quick check.",
        // Answerable from what the lesson just said, not from memory of a number: the
        // screen shows wind and currents, and no wave layer to read a height from.
        quiz: {
          kind: "choice",
          q: (c) => `Tomorrow the wind near ${c.place.name.split(",")[0]} blows twice as hard, ` +
            "all day. What happens to the waves?",
          options: ["They grow bigger", "They get smaller", "Nothing changes"],
          answer: 0,
          why: (c) => "Stronger wind, blowing for longer, puts more energy into the sea, so " +
            "the waves grow." + (c.sea?.wind_ms != null
              ? ` Today's ${fmt(c.sea.wind_ms)} m/s gave waves of about ${fmt(c.sea.wave_height_m)} m there.`
              : ""),
        },
      },
      {
        say: "Now find a sea yourself.",
        do: () => [{ action: "set_view", view: "globe" }],
        quiz: {
          kind: "pick", q: "Click on the Bay of Bengal.", box: BAY_OF_BENGAL, sea: true,
          why: "The Bay of Bengal is the sea east of India, between India, Bangladesh, " +
            "Myanmar and Sri Lanka.",
        },
      },
    ],
  },
  {
    id: "3d",
    title: "The ocean is 3D",
    goal: "See that the ocean has layers: a warm lid over cold deep water.",
    steps: [
      {
        say: (c) => `Maps show only the top of the sea. Here is a block of ocean cut out off ` +
          `${c.place.name}, from the surface down to 1,000 m. Its sides are painted with the ` +
          "temperature at every depth. Depth is stretched so you can see it: the real block " +
          "is far wider than it is deep.",
        do: (c) => {
          const [lat, lon] = c.sea?.sea_point ?? [c.place.lat, c.place.lon];
          return [{ action: "make_cube", ...around(lat, lon, 4), variable: "temperature",
                    day: c.today, depth_max: 1000 },
                  { action: "set_view", view: "region" }];
        },
      },
      {
        say: "Look at the sides: bright yellow (warm) at the top, dark blue and purple " +
          "(cold) further down. Now we slice the block open from the west, so you look at " +
          "the inside.",
        do: () => [{ action: "set_control", target: "cut-west", value: 500 }],
      },
      {
        say: "Quick check.",
        quiz: {
          kind: "choice",
          q: "In this block, is the water at 500 m warmer or colder than at the surface?",
          options: ["Warmer", "Colder", "About the same"],
          answer: (c) => {
            const col = centreColumn(c);
            if (col.length < 2) return 1;
            const top = col[0].value;
            const deep = valueNear(col, 500).value;
            return Math.abs(top - deep) < 0.5 ? 2 : deep > top ? 0 : 1;
          },
          why: (c) => {
            const col = centreColumn(c);
            if (col.length < 2) return "This block has too little water to read.";
            const deep = valueNear(col, 500);
            return `In the deepest water of the block the model has ${fmt(col[0].value)} °C at ` +
              `${Math.round(col[0].depth)} m and ${fmt(deep.value)} °C at ${Math.round(deep.depth)} m. ` +
              "Sunlight warms only the top of the sea.";
          },
        },
      },
      {
        say: "Between the warm lid and the cold deep there is a layer where the temperature " +
          "drops fast. It is called the thermocline. Fish, submarines and cyclones all " +
          "care where it is.",
        do: () => [{ action: "set_control", target: "cut-west", value: 0 },
                   { action: "set_control", target: "cube-contours", value: true }],
        quiz: {
          kind: "choice",
          q: "In this block, where does the temperature change fastest?",
          options: ["In the top 30 m", "Between 30 m and 400 m down", "Deeper than 400 m"],
          answer: (c) => {
            const d = steepestDepth(centreColumn(c));
            return d < 30 ? 0 : d <= 400 ? 1 : 2;
          },
          why: (c) => {
            const d = steepestDepth(centreColumn(c));
            return Number.isFinite(d)
              ? `Here it falls fastest around ${Math.round(d)} m: that is this place's thermocline. ` +
                "The contour lines crowd together there."
              : "This block has too little water to read.";
          },
        },
      },
    ],
  },
  {
    id: "currents",
    title: "Rivers in the sea",
    goal: "See that currents can turn around with the monsoon.",
    steps: [
      {
        say: "The ocean moves. South of Sri Lanka the current changes direction with the " +
          "monsoon winds. This block is coloured by the current: red for water going " +
          "east, blue for water going west, white for still. This is January.",
        do: () => [{ action: "make_cube", west: 76, east: 92, south: 0, north: 12,
                     variable: "u", day: "2020-01-15", depth_max: 200 },
                   { action: "set_view", view: "region" }],
        after: (c) => { c.memo.januaryU = upperMean(c, 50, SRI_LANKA_STRIP); },
      },
      {
        say: "And the same water in July, in the summer (south-west) monsoon.",
        do: () => [{ action: "make_cube", west: 76, east: 92, south: 0, north: 12,
                     variable: "u", day: "2020-07-15", depth_max: 200 }],
        after: (c) => { c.memo.julyU = upperMean(c, 50, SRI_LANKA_STRIP); },
      },
      {
        say: "Quick check.",
        quiz: {
          kind: "choice",
          q: "South of Sri Lanka, in the top 50 m, which way was the water going in July?",
          options: ["East", "West"],
          answer: (c) => (c.memo.julyU >= 0 ? 0 : 1),
          why: (c) => `Averaged over the strip, the eastward current was ` +
            `${fmt(c.memo.januaryU, 2)} m/s in January and ${fmt(c.memo.julyU, 2)} m/s in July ` +
            "(minus means westward). The monsoon wind turns the current around.",
        },
      },
    ],
  },
  {
    id: "cyclones",
    title: "Cyclones run on warm water",
    goal: "See a cyclone take heat out of the sea.",
    steps: [
      {
        say: "Cyclones get their energy from warm sea water; they generally form only " +
          "where the surface is warmer than about 26 °C. This is the Bay of Bengal on " +
          "14 May 2020, two days before Cyclone Amphan formed.",
        do: () => [{ action: "set_control", target: "cube-scenario", value: "amphan_before" },
                   { action: "set_view", view: "region" }],
        after: (c) => { c.memo.before = surfaceMean(c); },
        // The change is under a degree; on the full 0-30 °C bar both days look the same.
        // A narrow bar, kept for the next day (same variable keeps its range), shows it.
        then: () => [{ action: "set_control", target: "range-min", value: 28 },
                     { action: "set_control", target: "range-max", value: 31.5 }],
      },
      {
        say: "Amphan grew into a super cyclone over the Bay and crossed the coast on 20 May. " +
          "Here is the same water on 22 May, two days after landfall, on the same colour " +
          "bar: from 28 °C (dark) to 31.5 °C (bright yellow). Look at the top of the block.",
        do: () => [{ action: "set_control", target: "cube-scenario", value: "amphan_after" }],
        after: (c) => { c.memo.after = surfaceMean(c); },
      },
      {
        say: "Quick check.",
        quiz: {
          kind: "choice",
          q: "After Amphan, was the surface of the Bay on average warmer or cooler than before?",
          options: ["Warmer", "Cooler"],
          answer: (c) => (c.memo.after >= c.memo.before ? 0 : 1),
          why: (c) => `The model's surface average over the box: ${fmt(c.memo.before, 2)} °C ` +
            `before and ${fmt(c.memo.after, 2)} °C after. A cyclone's winds stir cold water ` +
            "up from below and its clouds shade the sea.",
        },
      },
      {
        say: "One more. The block is put away so the coast is clear.",
        // A click lands on the globe's surface; the tall block would stand in the way.
        do: () => [{ action: "show_cube", on: false }, { action: "set_view", view: "globe" }],
        quiz: {
          kind: "pick", q: "Click where you think Amphan crossed the coast.",
          box: AMPHAN_LANDFALL,
          why: "It crossed the coast of West Bengal near the Sundarbans, close to the border " +
            "with Bangladesh.",
        },
      },
    ],
  },
  {
    id: "floats",
    title: "Who measures the ocean?",
    goal: "Meet the Argo floats and see a model checked against a measurement.",
    steps: [
      {
        say: "Everything so far came from a computer model of the ocean. Models are " +
          "checked against real measurements. Thousands of robot floats called Argo drift " +
          "in the ocean; every ten days each one sinks, then rises to the surface measuring " +
          "the water as it comes up. Here they are in the Bay of Bengal, drawn as sticks.",
        do: () => [{ action: "set_control", target: "cube-scenario", value: "bay_of_bengal" },
                   { action: "set_control", target: "cube-floats", value: true },
                   { action: "set_view", view: "region" }],
      },
      {
        say: "Each stick is one float's dive, coloured by what it measured. A white dot marks " +
          "where it came up. Click any stick.",
        wait: {
          hint: "Click a float's stick on the block…",
          until: () => !document.getElementById("profile-panel")?.classList.contains("hidden"),
        },
      },
      {
        say: "The chart on the right is that float's measurement against the model, depth " +
          "going down. Where the two lines part, the model is wrong there. Levels drawn in " +
          "red failed a quality check: we still show them, marked, instead of hiding them.",
      },
      {
        say: "Quick check.",
        quiz: {
          kind: "choice",
          q: "A red dot on a float's stick means…",
          options: ["The water there is very hot",
                    "That measurement failed a quality check, so it is shown but not trusted",
                    "The float is broken and all its data is thrown away"],
          answer: 1,
          why: "Every measurement carries a quality flag. A bad one is kept and marked, so " +
            "nobody is fooled and nothing is hidden.",
        },
      },
    ],
  },
  {
    id: "your-turn",
    title: "Your turn",
    goal: "Learn the controls and build your own block of ocean.",
    steps: [
      {
        say: "You have seen the ocean's layers, its currents, a cyclone and the floats. Now " +
          "the controls come back. This panel is where every block starts.",
        do: () => [{ action: "highlight", target: "cube-section" }],
      },
      {
        say: "Choose what to colour the block with: temperature, saltiness, currents, " +
          "oxygen, even the tiny plants (chlorophyll).",
        do: () => [{ action: "highlight", target: "cube-variable" }],
      },
      {
        say: "Press Draw a box, then drag on the globe to cut out any piece of ocean on Earth.",
        do: () => [{ action: "highlight", target: "cube-draw" }],
      },
      {
        say: "Slide these to cut the block open from any side, like you did before.",
        do: () => [{ action: "highlight", target: "cut-section" }],
      },
      {
        say: "Stuck? Ask the assistant in plain words, like “show me the Gulf Stream”: it " +
          "is under “Ask a question” below while you learn, and in the right-hand panel " +
          "afterwards. That's the course. The ocean is yours to explore.",
      },
    ],
  },
];

/** Self-check for the pure readers, run from main's dev checks. */
export function demo(): void {
  const col = [{ depth: 0, value: 29 }, { depth: 20, value: 28.8 }, { depth: 100, value: 20 },
               { depth: 300, value: 12 }, { depth: 1000, value: 5 }];
  const d = steepestDepth(col);
  assert(d > 20 && d < 100, `thermocline between 20 and 100 m, got ${d}`);
  assert(valueNear(col, 480).depth === 300, "nearest level to 480 m is 300 m");
  for (const l of LESSONS) {
    for (const s of l.steps) {
      if (s.quiz?.kind === "choice" && typeof s.quiz.answer === "number") {
        const n = Array.isArray(s.quiz.options) ? s.quiz.options.length : Infinity;
        assert(s.quiz.answer < n, `${l.id}: answer index past the options`);
      }
    }
  }
}

function assert(ok: boolean, message: string): void {
  if (!ok) throw new Error(`lessons: ${message}`);
}
