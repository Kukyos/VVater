/**
 * Search-and-rescue drift on the globe (server/ocean/drift.py does the integration).
 *
 * Drawn on the sea surface, or on the cube's top when a cube is up (the cube's top is the
 * sea surface lifted): the ensemble's particles at the end, the mean track, and one 90 %
 * ellipse per day, labelled with its hour. The panel lists each day's ellipse and the share
 * of particles that reached the coast, and the stated choices the spread comes from.
 */

import {
  Cartesian2, Cartesian3, Color, CustomDataSource, HorizontalOrigin, LabelStyle, VerticalOrigin,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { Drift } from "./api";

const ELLIPSE = Color.fromCssColorString("#ffcf4a");
const TRACK = Color.fromCssColorString("#ff6b5a");
const PARTICLE = Color.fromCssColorString("#ffffff");

export class DriftLayer {
  private source = new CustomDataSource("drift");

  constructor(viewer: Viewer) {
    void viewer.dataSources.add(this.source);
  }

  clear(): void {
    this.source.entities.removeAll();
  }

  /** Draw a run at `height` metres (0 on the sea, the cube's top when there is one). */
  show(d: Drift, height: number): void {
    this.clear();
    const at = (p: number[], h = height) => Cartesian3.fromDegrees(p[0], p[1], h);
    const e = this.source.entities;
    e.add({
      position: at([d.start.lon, d.start.lat], height + 300),
      point: { pixelSize: 11, color: TRACK, outlineColor: Color.WHITE, outlineWidth: 2,
               disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: d.direction === "backward" ? "found here" : "released here",
               font: "600 12px system-ui, sans-serif", fillColor: Color.WHITE,
               outlineColor: Color.BLACK, outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
               horizontalOrigin: HorizontalOrigin.LEFT, verticalOrigin: VerticalOrigin.CENTER,
               pixelOffset: new Cartesian2(10, 0),
               disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    e.add({ polyline: { positions: d.track.map((p) => at(p, height + 200)), width: 3,
                        material: TRACK, arcType: 0 as never } });
    for (const day of d.days) {
      e.add({ polyline: { positions: day.ring.map((p) => at(p, height + 150)), width: 2,
                          material: ELLIPSE, arcType: 0 as never } });
      e.add({
        position: at([day.lon, day.lat], height + 400),
        label: { text: `${day.hour} h`, font: "600 12px system-ui, sans-serif",
                 fillColor: ELLIPSE, outlineColor: Color.BLACK, outlineWidth: 3,
                 style: LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cartesian2(0, -14),
                 disableDepthTestDistance: Number.POSITIVE_INFINITY },
      });
    }
    const last = d.snapshots[d.snapshots.length - 1];
    for (const p of last.points) {
      e.add({ position: at(p, height + 100),
              point: { pixelSize: 3, color: PARTICLE.withAlpha(0.85),
                       disableDepthTestDistance: Number.POSITIVE_INFINITY } });
    }
  }
}

/** The panel's table: one row per day. */
export function describe(d: Drift): string {
  const rows = d.days.map((x) =>
    `<tr><td>${x.hour} h</td><td>${x.a_km.toFixed(1)} × ${x.b_km.toFixed(1)} km</td>` +
    `<td>${Math.round(x.area_km2).toLocaleString()} km²</td>` +
    `<td>${Math.round(x.reached_coast * 100)} %</td></tr>`).join("");
  const p = d.provenance;
  const sources = [...new Set(p.currents.map((c) => c.source))].join(", ");
  return `<table class="drift-table"><tr><th></th><th>90 % ellipse</th><th>area</th>` +
    `<th>at the coast</th></tr>${rows}</table>` +
    `<div class="hint">${d.object.title}${d.object.leeway_pct ? `, leeway ${d.object.leeway_pct} % of the 10 m wind` : ""}` +
    ` · ${d.direction}, ${d.hours} h from ${d.start.time_utc} · currents: ${sources}, ` +
    `${p.currents.map((c) => c.day).join(", ")}</div>` +
    `<details><summary>How the spread is made</summary><div class="hint">${p.method}.<br>` +
    `${p.assumptions.join(".<br>")}.<br><b>${p.note}.</b></div></details>`;
}
