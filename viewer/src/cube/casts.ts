/**
 * Argo casts inside the cube: each one a vertical stick at the place it was measured,
 * coloured level by level through the same colour bar as the model around it. Where the
 * model and the float disagree, the stick is a different colour from the wall behind it.
 *
 * Hard rule 2 in the drawing itself: a level that failed QC is drawn in the rejected
 * colour, never left out, and every stick keeps its platform, data mode and source file
 * for the probe and the profile panel. A stick behind a face is drawn dashed rather than
 * hidden, so floats in the middle of the water are visible without pretending to be in
 * front of it.
 */

import {
  ArcType,
  Cartesian3,
  Color,
  GeometryInstance,
  Material,
  PointPrimitiveCollection,
  PolylineColorAppearance,
  PolylineGeometry,
  PolylineMaterialAppearance,
  Primitive,
  type Scene,
} from "@cesium/engine";

import type { CubeCast } from "../api";
import type { Cut } from "./scene";

/** The colour a rejected level is drawn in: the profile chart's QC-rejected red. */
export const REJECTED = Color.fromCssColorString("#ff5f6d");

export class CastLayer {
  private primitive?: Primitive;
  private heads = new PointPrimitiveCollection();
  casts: CubeCast[] = [];
  visible = true;

  constructor(private scene: Scene) {
    scene.primitives.add(this.heads);
  }

  clear(): void {
    if (this.primitive) this.scene.primitives.remove(this.primitive);
    this.primitive = undefined;
    this.heads.removeAll();
  }

  show(visible: boolean): void {
    this.visible = visible;
    if (this.primitive) this.primitive.show = visible;
    this.heads.show = visible;
  }

  /**
   * Draw the casts that fall inside the cut. `heightOf` is the cube's own depth-to-height
   * mapping, so a stick's 500 m is exactly the wall's 500 m; `colour` is the colour bar.
   */
  render(casts: CubeCast[], cut: Cut, heightOf: (depth: number) => number,
         colour: (value: number) => [number, number, number]): void {
    this.casts = casts;
    this.clear();
    const instances: GeometryInstance[] = [];
    const wrap = (lon: number) => (lon > 180 ? lon - 360 : lon);
    const inLon = (lon: number) => {
      const l = lon < cut.lon0 ? lon + 360 : lon;
      return l >= cut.lon0 && l <= cut.lon1;
    };
    casts.forEach((c, index) => {
      if (!inLon(c.lon) || c.lat < cut.lat0 || c.lat > cut.lat1) return;
      const positions: Cartesian3[] = [];
      const colors: Color[] = [];
      c.depth.forEach((d, i) => {
        const v = c.value[i];
        if (d === null || v === null || d < cut.top || d > cut.bottom) return;
        positions.push(Cartesian3.fromDegrees(wrap(c.lon), c.lat, heightOf(d)));
        if (!c.accepted[i]) {
          colors.push(REJECTED);
        } else {
          const [r, g, b] = colour(v);
          colors.push(new Color(r / 255, g / 255, b / 255, 1));
        }
      });
      if (positions.length < 2) return;
      instances.push(new GeometryInstance({
        id: { cast: index },
        geometry: new PolylineGeometry({
          positions, colors, colorsPerVertex: true, width: 5, arcType: ArcType.NONE,
          // The material format (position + st) serves both appearances: the solid one
          // reads the per-vertex colours, the dashed depth-fail one needs st.
          vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
        }),
      }));
      // A white head at the top of the stick: where the float surfaced, and a large
      // target to point at.
      this.heads.add({
        position: positions[0], pixelSize: 8, color: Color.WHITE,
        outlineColor: Color.BLACK.withAlpha(0.7), outlineWidth: 1.5,
        id: { cast: index },
      });
    });
    if (!instances.length) return;
    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PolylineColorAppearance({ translucent: false }),
      // Behind a face: dashed and faint, so it reads as inside the water.
      depthFailAppearance: new PolylineMaterialAppearance({
        material: Material.fromType("PolylineDash", {
          color: Color.WHITE.withAlpha(0.55), gapColor: Color.TRANSPARENT, dashLength: 10,
        }),
      }),
      asynchronous: false,
    });
    this.primitive.show = this.visible;
    this.heads.show = this.visible;
    this.scene.primitives.add(this.primitive);
  }

  /** The cast under a pick result, if the pick was one of ours. */
  castOf(picked: unknown): CubeCast | undefined {
    const id = (picked as { id?: { cast?: number } } | undefined)?.id;
    return id && typeof id.cast === "number" ? this.casts[id.cast] : undefined;
  }
}
