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

/**
 * Speed ramp for the lines: light cyan (slow) through white to amber (fast).
 *
 * The lines used to take viridis, whose slow end is a dark purple. Deep currents are
 * slow, so below a few hundred metres every line drew in near-black over a dark sea and
 * the layer looked as if it had failed to load. Every stop here is light, so a line is
 * always visible and speed still reads as colour.
 */
const SPEED_STOPS: [number, number, number][] = [
  [0.45, 0.85, 1.0], [0.85, 0.97, 1.0], [1.0, 0.86, 0.45], [1.0, 0.55, 0.25],
];

/** Colour for a speed. sqrt, because currents are mostly slow with a few fast jets. */
function speedColor(speed: number, lo: number, hi: number, alpha: number): Color {
  const t = Math.sqrt(Math.min(Math.max((speed - lo) / Math.max(hi - lo, 1e-6), 0), 1));
  const scaled = t * (SPEED_STOPS.length - 1);
  const index = Math.min(Math.floor(scaled), SPEED_STOPS.length - 2);
  const frac = scaled - index;
  const a = SPEED_STOPS[index];
  const b = SPEED_STOPS[index + 1];
  // Slow water fades, fast jets stay bright: 300-odd lines at one alpha buried the
  // field they were drawn over.
  return new Color(
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
    alpha * (0.4 + 0.6 * t),
  );
}

export class StreamlineLayer {
  private collection = new PolylineCollection();
  private added = false;
  /** Shown by the user, as against hidden for a moment while the camera moves. */
  private wanted = false;
  /** Hide the lines while the camera moves, as the particle overlay does. */
  pauseOnMove = true;
  private lastCamera = new Cartesian3();
  private movedAt = 0;

  constructor(private scene: Scene) {
    // preUpdate fires on every tick, rendered or not, so the lines come back even when
    // render-on-demand has gone quiet after the camera stopped.
    scene.preUpdate.addEventListener(() => {
      if (!this.wanted) return;
      const now = performance.now();
      if (!Cartesian3.equalsEpsilon(scene.camera.positionWC, this.lastCamera, 0, 1)) {
        this.movedAt = now;
        Cartesian3.clone(scene.camera.positionWC, this.lastCamera);
      }
      const show = !this.pauseOnMove || now - this.movedAt > 200;
      if (show !== this.collection.show) {
        this.collection.show = show;
        if (show) scene.requestRender();
      }
    });
  }

  /**
   * Draw a set of streamlines at a given height.
   *
   * `height` is where the slice sits in the exaggerated column, so the lines float at
   * the depth they describe rather than being pasted onto the sea surface. Drawing them
   * at zero would imply currents are a surface phenomenon, which is the misconception a
   * depth-resolved tool exists to correct.
   */
  show(data: Streamlines, height: number, opacity = 0.9): void {
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
        width: 1.7,
        material: Material.fromType("Color", {
          color: speedColor(mean, lo, hi, opacity),
        }),
      });
    }

    if (!this.added) {
      this.scene.primitives.add(this.collection);
      this.added = true;
    }
    this.wanted = true;
    this.collection.show = true;
  }

  hide(): void {
    this.wanted = false;
    this.collection.show = false;
  }

  destroy(): void {
    if (this.added) {
      this.scene.primitives.remove(this.collection);
      this.added = false;
    }
  }
}
