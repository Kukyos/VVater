/**
 * One water column from the cube: the model's native levels as dots joined by straight
 * lines, on the same depth axis the cube uses. Only the levels the data has are marked,
 * so it is visible how far apart they are at depth (hard rule 3).
 */

import { byId, paletteLut } from "../colorbar";
import { type DepthAxis, depthTicks, depthToT } from "./data";

export function drawColumn(canvas: HTMLCanvasElement,
                           column: { depth: number; value: number }[],
                           opts: { units: string; title: string; axis: DepthAxis;
                                   bottom: number; range: [number, number];
                                   paletteId: string; reversed: boolean }): void {
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 220;
  canvas.width = w * ratio;
  canvas.height = h * ratio;
  const g = canvas.getContext("2d")!;
  g.scale(ratio, ratio);
  g.clearRect(0, 0, w, h);
  const pad = { l: 46, r: 12, t: 22, b: 18 };
  const [lo0, hi0] = opts.range;
  const values = column.map((c) => c.value);
  const lo = Math.min(lo0, ...values);
  const hi = Math.max(hi0, ...values);
  const x = (v: number) => pad.l + ((v - lo) / (hi - lo || 1)) * (w - pad.l - pad.r);
  const y = (d: number) => pad.t + depthToT(d, 0, opts.bottom, opts.axis) * (h - pad.t - pad.b);

  g.font = "10px system-ui, sans-serif";
  g.fillStyle = "#8b919b";
  g.strokeStyle = "#2c2e33";
  g.lineWidth = 1;
  for (const d of depthTicks(0, opts.bottom, opts.axis)) {
    g.beginPath();
    g.moveTo(pad.l, y(d));
    g.lineTo(w - pad.r, y(d));
    g.stroke();
    g.textAlign = "right";
    g.fillText(`${d} m`, pad.l - 5, y(d) + 3);
  }
  g.textAlign = "left";
  g.fillText(`${opts.title} (${opts.units}) · native levels`, pad.l, 13);
  g.textAlign = "center";
  g.fillText(formatTick(lo), x(lo), h - 5);
  g.fillText(formatTick(hi), x(hi), h - 5);

  if (!column.length) {
    g.fillText("no water here", w / 2, h / 2);
    return;
  }
  g.strokeStyle = "#d9dde3";
  g.lineWidth = 1.5;
  g.beginPath();
  column.forEach((c, i) => (i ? g.lineTo(x(c.value), y(c.depth)) : g.moveTo(x(c.value), y(c.depth))));
  g.stroke();
  const lut = paletteLut(byId(opts.paletteId), opts.reversed);
  for (const c of column) {
    const k = Math.max(0, Math.min(255, Math.round(((c.value - lo0) / (hi0 - lo0 || 1)) * 255)));
    g.fillStyle = `rgb(${lut[k * 4]},${lut[k * 4 + 1]},${lut[k * 4 + 2]})`;
    g.beginPath();
    g.arc(x(c.value), y(c.depth), 3, 0, Math.PI * 2);
    g.fill();
  }
}

function formatTick(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2);
}
