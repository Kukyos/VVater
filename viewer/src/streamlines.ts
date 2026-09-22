/**
 * Current streamlines, drawn as polylines coloured by speed.
 *
 * The integration happens on the server (`server/ocean/currents.py`) because a wrong
 * integrator produces a picture that looks fine and is wrong, and a number on the server
 * can be tested where a picture cannot. All this file does is turn a list of points into
 * geometry.
 *
 * One `PolylineCollection` rather than one entity per line: 388 streamlines as 388
 * entities is 388 primitives and a visible frame-rate drop, where a single collection is
 * one draw call. That is the same decimation argument as L4, applied to the thing we
 * actually draw.
 */

import {
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  type Scene,
} from "@cesium/engine";
import type { Streamlines } from "./api";
import { byId, paletteStops } from "./colorbar";

const SPEED_PALETTE = "viridis";

/** Colour for a speed, using the same ramp maths the volume shader uses. */
function speedColor(speed: number, lo: number, hi: number, alpha: number): Color {
  const stops = paletteStops(byId(SPEED_PALETTE), false, 6);
  const t = Math.min(Math.max((speed - lo) / Math.max(hi - lo, 1e-6), 0), 1);
  const scaled = t * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const frac = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  return new Color(
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
    alpha,
  );
}

export class StreamlineLayer {
  private collection = new PolylineCollection();
  private added = false;

  constructor(private scene: Scene) {}

  /**
   * Draw a set of streamlines at a given height.
   *
   * `height` is where the slice sits in the exaggerated column, so the lines float at
   * the depth they describe rather than being pasted onto the sea surface. Drawing them
   * at zero would imply currents are a surface phenomenon, which is the misconception a
   * depth-resolved tool exists to correct.
   */
  show(data: Streamlines, height: number, opacity = 0.85): void {
    this.collection.removeAll();
    const [lo, hi] = data.speedRange;

    for (const line of data.streamlines) {
      if (line.points.length < 2) continue;

      const positions = line.points.map(([lon, lat]) =>
        Cartesian3.fromDegrees(lon, lat, height),
      );
      const mean = line.speeds.reduce((sum, s) => sum + s, 0) / line.speeds.length;

      this.collection.add({
        positions,
        width: 1.6,
        material: Material.fromType("Color", {
          color: speedColor(mean, lo, hi, opacity),
        }),
      });
    }

    if (!this.added) {
      this.scene.primitives.add(this.collection);
      this.added = true;
    }
    this.collection.show = true;
  }

  hide(): void {
    this.collection.show = false;
  }

  destroy(): void {
    if (this.added) {
      this.scene.primitives.remove(this.collection);
      this.added = false;
    }
  }
}
