/**
 * The depth-vs-variable chart: one cast, and the analysis interpolated onto it.
 *
 * This is the brief's central promise — "click a float/glider to inspect a depth-vs-
 * variable profile chart with timestamps" — and the one view where being quietly wrong
 * matters most, so three things are deliberate:
 *
 *   * depth increases downward, because that is how every oceanographer reads a profile
 *   * QC-rejected levels are drawn as hollow marks rather than hidden, so the reader can
 *     see what was thrown away and why
 *   * the analysis line carries its own uncertainty band when the source ships one
 *
 * Drawn on a plain canvas. A charting library would be ~100 KB to draw two polylines.
 */

import type { ProfileComparison } from "./api";

const PAD = { top: 22, right: 16, bottom: 34, left: 52 };

export interface ChartTheme {
  observed: string;
  modelled: string;
  rejected: string;
  band: string;
  axis: string;
  text: string;
}

export const THEME: ChartTheme = {
  observed: "#4dd2ff",
  modelled: "#ffb454",
  rejected: "#ff5f6d",
  band: "rgba(255, 180, 84, 0.18)",
  axis: "rgba(255, 255, 255, 0.28)",
  text: "rgba(233, 240, 247, 0.82)",
};

interface Point {
  value: number;
  depth: number;
  accepted: boolean;
  qc: string;
  error: number | null;
}

function points(profile: ProfileComparison, series: "observed" | "modelled"): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < profile.depth.length; i += 1) {
    const depth = profile.depth[i];
    const value = profile[series][i];
    if (depth === null || value === null) continue;
    out.push({
      value,
      depth,
      accepted: profile.accepted[i] ?? true,
      qc: profile.qc[i] ?? " ",
      error: profile.error?.[i] ?? null,
    });
  }
  return out;
}

/** Round depths, dense near the surface where a sqrt axis spends its space. */
const DEPTH_TICKS = [0, 50, 100, 200, 300, 500, 1000, 1500, 2000];

export function drawProfile(canvas: HTMLCanvasElement, profile: ProfileComparison,
                            units: string, maxDepth?: number): void {
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const observed = points(profile, "observed");
  const modelled = points(profile, "modelled");
  const all = [...observed, ...modelled];
  if (all.length === 0) {
    context.fillStyle = THEME.text;
    context.font = "12px system-ui, sans-serif";
    context.fillText("no comparable levels in this cast", PAD.left, height / 2);
    return;
  }

  // A little headroom so the extremes are not welded to the frame.
  const values = all.map((p) => p.value);
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  const margin = (vMax - vMin) * 0.06 || 0.5;
  vMin -= margin;
  vMax += margin;

  const dMax = maxDepth ?? Math.max(...all.map((p) => p.depth));

  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const x = (v: number) => PAD.left + ((v - vMin) / (vMax - vMin)) * plotW;
  // Square-root depth, the same stretch as the voxel grid. On a linear axis the upper
  // 300 m -- the mixed layer and thermocline, where the analysis and the glider disagree
  // (docs/13-eval-results.md) -- was squeezed into the top seventh of the chart.
  const y = (d: number) => PAD.top + Math.sqrt(Math.max(d, 0) / dMax) * plotH;

  // --- axes. Depth grows downward; that is not negotiable on a profile chart.
  context.strokeStyle = THEME.axis;
  context.fillStyle = THEME.text;
  context.lineWidth = 1;
  context.font = "10px system-ui, sans-serif";

  context.beginPath();
  context.moveTo(PAD.left, PAD.top);
  context.lineTo(PAD.left, PAD.top + plotH);
  context.lineTo(PAD.left + plotW, PAD.top + plotH);
  context.stroke();

  for (const depth of DEPTH_TICKS.filter((d) => d <= dMax)) {
    const py = y(depth);
    context.globalAlpha = 0.25;
    context.beginPath();
    context.moveTo(PAD.left, py);
    context.lineTo(PAD.left + plotW, py);
    context.stroke();
    context.globalAlpha = 1;
    context.textAlign = "right";
    context.fillText(`${Math.round(depth)}`, PAD.left - 6, py + 3);
  }
  context.textAlign = "center";
  for (let i = 0; i <= 4; i += 1) {
    const value = vMin + ((vMax - vMin) / 4) * i;
    context.fillText(value.toFixed(1), x(value), PAD.top + plotH + 14);
  }

  context.textAlign = "left";
  context.fillText(`depth (m, √ scale)  ·  ${units}`, PAD.left, 12);

  // --- analysis uncertainty band, when the source ships one
  const band = modelled.filter((p) => p.error !== null);
  if (band.length > 1) {
    context.fillStyle = THEME.band;
    context.beginPath();
    band.forEach((p, i) => {
      const px = x(p.value - (p.error ?? 0));
      i === 0 ? context.moveTo(px, y(p.depth)) : context.lineTo(px, y(p.depth));
    });
    for (let i = band.length - 1; i >= 0; i -= 1) {
      const p = band[i];
      context.lineTo(x(p.value + (p.error ?? 0)), y(p.depth));
    }
    context.closePath();
    context.fill();
  }

  const line = (series: Point[], colour: string) => {
    context.strokeStyle = colour;
    context.lineWidth = 1.6;
    context.beginPath();
    series.forEach((p, i) => {
      i === 0 ? context.moveTo(x(p.value), y(p.depth)) : context.lineTo(x(p.value), y(p.depth));
    });
    context.stroke();
  };

  line(modelled, THEME.modelled);
  line(observed.filter((p) => p.accepted), THEME.observed);

  // 16 of 134 casts in the demo window sit where the analysis has no water (masked
  // coastal cells) or only above its 5 m top. A chart with no orange line and no reason
  // reads as "the comparison failed to load"; say what actually happened instead.
  if (modelled.length === 0) {
    context.fillStyle = THEME.modelled;
    context.font = "11px system-ui, sans-serif";
    context.textAlign = "left";
    context.fillText("no analysis line: the analysis has no value", PAD.left + 8, PAD.top + plotH - 30);
    context.fillText("at this cast's location and depths", PAD.left + 8, PAD.top + plotH - 16);
  }

  // --- QC-rejected levels, drawn rather than dropped. Hiding them would make the
  // quality control invisible, which defeats the point of having read it.
  const rejected = observed.filter((p) => !p.accepted);
  context.strokeStyle = THEME.rejected;
  context.lineWidth = 1.2;
  rejected.forEach((p) => {
    context.beginPath();
    context.arc(x(p.value), y(p.depth), 2.6, 0, Math.PI * 2);
    context.stroke();
  });
}

/** One-line caption under the chart: what this is and what was thrown away. */
/**
 * Heat above 26 °C, the fuel a cyclone draws on, from the cast and from the analysis on
 * the same levels. Unknown (not zero) when the cast never cools to 26 °C.
 */
function tchpText(profile: ProfileComparison): string | null {
  const t = profile.tchp;
  if (!t) return null;
  if (t.observed_kj_cm2 === null || t.analysis_kj_cm2 === null) {
    return "cyclone heat potential: unknown (no 26 °C crossing on the compared levels)";
  }
  const d = t.difference_kj_cm2 ?? 0;
  return `cyclone heat potential: observed ${t.observed_kj_cm2.toFixed(1)}, analysis ` +
    `${t.analysis_kj_cm2.toFixed(1)} kJ/cm² (${d >= 0 ? "+" : ""}${d.toFixed(1)}); ` +
    `D26 ${t.observed_d26_m} vs ${t.analysis_d26_m} m`;
}

export function captionFor(profile: ProfileComparison): string {
  const summary = profile.summary as Record<string, number | string>;
  // QC rejections and levels the analysis cannot reach are different things. This was
  // levels minus compared, so a cast with nothing rejected but five levels above the
  // grid's 5 m top was captioned "5 rejected" -- a QC claim the data never made.
  const rejected = Number(summary.levels_rejected ?? 0);
  const outside = Number(summary.levels ?? 0) - Number(summary.levels_compared ?? 0) - rejected;
  const mode = String(summary.data_mode ?? "?");
  const modeText = mode === "U"
    ? "unevaluated (no QC ever run on this source)"
    : mode === "Q"
      ? "QARTOD-flagged"
      : { R: "real-time", A: "adjusted", D: "delayed-mode" }[mode] ?? mode;

  const bias = Number(summary.bias);
  const rmse = Number(summary.rmse);
  const stats = Number.isFinite(bias)
    ? `bias ${bias >= 0 ? "+" : ""}${bias.toFixed(2)}, rmse ${rmse.toFixed(2)}`
    : "no comparable levels";

  return [
    `${profile.time}Z`,
    `${modeText}`,
    `${summary.levels_compared}/${summary.levels} levels compared`,
    rejected > 0 ? `${rejected} rejected by QC` : null,
    outside > 0 ? `${outside} outside the analysis grid` : null,
    stats,
    `analysis step ${summary.analysis_time} (${summary.time_offset_days} d away)`,
    // Hard rule 2: no observation without its QC, data mode AND source file. The first
    // two were shown; the file was in the response and never reached the screen.
    `${summary.field_used} from ${summary.source_file}`,
    tchpText(profile),
    // Hard rule 5: what the parser assumed travels with the cast, not just the upload reply.
    ...(profile.assumptions ?? []).map((a) => `assumed: ${a}`),
  ].filter(Boolean).join("  ·  ");
}
