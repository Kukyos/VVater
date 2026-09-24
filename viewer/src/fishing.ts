/**
 * Likely fishing zones and the sea state, painted over the cube's box (server/ocean/fishing.py).
 *
 * The server decides; this file only decodes one byte per cell and paints it: likely zones
 * in orange, and the sea state as a wash -- yellow where a small boat should take care, red
 * where it should stay in. Five best spots are listed with their sea state and a button to
 * go there. Every view of it carries the line that it is indicative and not an INCOIS
 * Potential Fishing Zone advisory.
 */

import {
  ImageryLayer, Rectangle, SingleTileImageryProvider, TextureMagnificationFilter,
  TextureMinificationFilter,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import * as api from "./api";

const ZONE: [number, number, number, number] = [255, 154, 31, 235];
const STATE: [number, number, number, number][] = [
  [0, 0, 0, 0],            // fit: no wash
  [255, 210, 63, 70],      // caution
  [255, 95, 109, 95],      // stay in
  [0, 0, 0, 0],            // unknown: no wash, and the summary says what was missing
];

/** RGBA for one cell's byte: 255 is land, bit 0 a zone, bits 1-2 the sea state. */
export function cellColour(code: number): [number, number, number, number] {
  if (code === 255) return [0, 0, 0, 0];
  return code & 1 ? ZONE : STATE[(code >> 1) & 3];
}

export class FishingLayer {
  private imagery?: ImageryLayer;
  private ticket = 0;
  data?: api.Fishing;

  constructor(private viewer: Viewer, private kick: (ms?: number) => void) {
    // Kept on top: the whole-ocean colour and the map section repaint as new layers, and
    // each one would otherwise bury the zones.
    viewer.imageryLayers.layerAdded.addEventListener((layer: ImageryLayer) => {
      if (this.imagery && layer !== this.imagery) viewer.imageryLayers.raiseToTop(this.imagery);
    });
  }

  async show(box: { lon0: number; lon1: number; lat0: number; lat1: number }, day: string):
      Promise<api.Fishing | undefined> {
    const ticket = ++this.ticket;
    const got = await api.getFishing(box, day);
    if (ticket !== this.ticket) return undefined;
    this.data = got;
    const [nx, ny] = got.dimensions;
    const bytes = Uint8Array.from(atob(got.cells), (c) => c.charCodeAt(0));
    const canvas = document.createElement("canvas");
    canvas.width = nx;
    canvas.height = ny;
    const g = canvas.getContext("2d")!;
    const image = g.createImageData(nx, ny);
    for (let y = 0; y < ny; y += 1) {
      const row = (ny - 1 - y) * nx;  // data south first, image north first
      for (let x = 0; x < nx; x += 1) {
        image.data.set(cellColour(bytes[y * nx + x]), (row + x) * 4);
      }
    }
    g.putImageData(image, 0, 0);
    const [lon0, lon1] = got.lonRange;
    const [lat0, lat1] = got.latRange;
    const hx = (lon1 - lon0) / Math.max(nx - 1, 1) / 2;
    const hy = (lat1 - lat0) / Math.max(ny - 1, 1) / 2;
    const wrap = (v: number) => (v > 180 ? v - 360 : v);
    const provider = await SingleTileImageryProvider.fromUrl(canvas.toDataURL(), {
      rectangle: Rectangle.fromDegrees(wrap(lon0 - hx), Math.max(lat0 - hy, -90),
                                       wrap(lon1 + hx), Math.min(lat1 + hy, 90)),
    });
    if (ticket !== this.ticket) return undefined;
    const previous = this.imagery;
    // Nearest, not smoothed: a zone is a cell the rule picked, not a blur around it.
    this.imagery = new ImageryLayer(provider, {
      magnificationFilter: TextureMagnificationFilter.NEAREST,
      minificationFilter: TextureMinificationFilter.NEAREST,
    });
    this.viewer.imageryLayers.add(this.imagery);
    if (previous) this.viewer.imageryLayers.remove(previous);
    this.kick(800);
    return got;
  }

  clear(): void {
    this.ticket += 1;
    if (this.imagery) this.viewer.imageryLayers.remove(this.imagery);
    this.imagery = undefined;
    this.data = undefined;
    this.kick();
  }

  setVisible(visible: boolean): void {
    if (this.imagery) this.imagery.show = visible;
  }
}

/** The byte decoding, checked once in development. */
export function demo(): void {
  console.assert(cellColour(255)[3] === 0, "fishing: land is transparent");
  console.assert(cellColour(1 | (2 << 1)) === ZONE, "fishing: a zone shows as a zone whatever the sea");
  console.assert(cellColour(2 << 1)[0] === 255 && cellColour(2 << 1)[1] === 95, "fishing: stay in is red");
  console.assert(cellColour(0)[3] === 0, "fishing: fit water has no wash");
}
