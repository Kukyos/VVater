/**
 * The whole ocean around the cube, and the currents moving through it.
 *
 * **The surface.** One level of the cube's own variable over the entire globe
 * (server/ocean/surface.py, 1/4 deg), at the depth of the cube's top face and on the same
 * colour bar, so the cube stands in the ocean it was cut from and a colour means the
 * same value inside and outside it. Land is left transparent; the basemap shows through.
 *
 * **The currents.** Particles advected through that day's u and v, worldwide and on the
 * cube's top face (flow.ts). A particle field is the flow on one day at one level,
 * animated; it is not where water went over time, and the panel says so (as the
 * streamlines always have, D-13).
 */

import {
  ImageryLayer,
  Rectangle,
  SingleTileImageryProvider,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import * as api from "./api";
import type { CubeRequest } from "./api";
import type { Style } from "./cube/paint";
import { type Field, FlowOverlay } from "./flow";

type Status = (message: string, kind?: "info" | "busy" | "warn" | "error") => void;

export class OceanLayer {
  private imagery?: ImageryLayer;
  private surface?: { meta: api.SurfaceMeta; values: Float32Array; key: string };
  readonly flow: FlowOverlay;
  private surfaceTicket = 0;
  private windTicket = 0;
  private cubeWindTicket = 0;
  surfaceOn = true;
  windOn = true;
  cubeWindOn = true;
  density = 12_000;

  constructor(private viewer: Viewer, private status: Status, private kick: (ms?: number) => void) {
    this.flow = new FlowOverlay(viewer.scene, viewer.container as HTMLElement);
  }

  get surfaceMeta(): api.SurfaceMeta | undefined {
    return this.surface?.meta;
  }

  // ---------------------------------------------------------------- surface

  /** Fetch (or reuse) one level of a variable worldwide and paint it. */
  async showSurface(variable: string, day: string, depth: number, style: Style): Promise<void> {
    const ticket = ++this.surfaceTicket;
    if (!this.surfaceOn) {
      this.clearSurface();
      return;
    }
    const key = `${variable}|${day}|${Math.round(depth)}`;
    if (this.surface?.key !== key) {
      let got: Awaited<ReturnType<typeof api.getSurface>>;
      try {
        got = await api.getSurface(variable, day, Math.round(depth));
      } catch (error) {
        if (ticket === this.surfaceTicket) this.status((error as Error).message, "warn");
        return;
      }
      if (ticket !== this.surfaceTicket) return;
      this.surface = { ...got, key };
    }
    await this.paintSurface(style, ticket);
  }

  /** Repaint the held level with a new colour bar; no request. */
  async recolour(style: Style): Promise<void> {
    if (this.surface && this.surfaceOn) await this.paintSurface(style, ++this.surfaceTicket);
  }

  private async paintSurface(style: Style, ticket: number): Promise<void> {
    const s = this.surface!;
    const [nx, ny] = s.meta.dimensions;
    const canvas = document.createElement("canvas");
    canvas.width = nx;
    canvas.height = ny;
    const g = canvas.getContext("2d")!;
    const image = g.createImageData(nx, ny);
    const px = image.data;
    const logLo = Math.log(Math.max(style.lo, 1e-9));
    const logSpan = Math.log(Math.max(style.hi, 1e-9)) - logLo || 1;
    for (let y = 0; y < ny; y += 1) {
      const row = (ny - 1 - y) * nx;  // data south first, image north first
      for (let x = 0; x < nx; x += 1) {
        const v = s.values[y * nx + x];
        const o = (row + x) * 4;
        if (v !== v) continue;  // land: transparent
        const t = style.log ? (Math.log(Math.max(v, 1e-9)) - logLo) / logSpan
          : (v - style.lo) / (style.hi - style.lo || 1);
        const k = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
        px[o] = style.lut[k];
        px[o + 1] = style.lut[k + 1];
        px[o + 2] = style.lut[k + 2];
        px[o + 3] = 255;
      }
    }
    g.putImageData(image, 0, 0);
    const [lon0, lon1] = s.meta.lonRange;
    const [lat0, lat1] = s.meta.latRange;
    // Cell centres to cell edges, so the layer lines up with the coast.
    const hx = (lon1 - lon0) / (nx - 1) / 2;
    const hy = (lat1 - lat0) / (ny - 1) / 2;
    const provider = await SingleTileImageryProvider.fromUrl(canvas.toDataURL(), {
      rectangle: Rectangle.fromDegrees(Math.max(lon0 - hx, -180), Math.max(lat0 - hy, -90),
                                       Math.min(lon1 + hx, 180), Math.min(lat1 + hy, 90)),
    });
    if (ticket !== this.surfaceTicket) return;
    const previous = this.imagery;
    this.imagery = this.viewer.imageryLayers.addImageryProvider(provider);
    if (previous) this.viewer.imageryLayers.remove(previous);
    this.kick(800);
  }

  clearSurface(): void {
    if (this.imagery) this.viewer.imageryLayers.remove(this.imagery);
    this.imagery = undefined;
    this.kick();
  }

  // ---------------------------------------------------------------- currents

  /** Worldwide particles at one level on one day, kept out of the cube's footprint. */
  async showCurrents(day: string, depth: number, hole?: Field["hole"]): Promise<void> {
    const ticket = ++this.windTicket;
    if (!this.windOn) {
      this.dropWind();
      return;
    }
    let got: Awaited<ReturnType<typeof api.getCurrents>>;
    try {
      got = await api.getCurrents(day, Math.round(depth));
    } catch (error) {
      if (ticket === this.windTicket) this.status((error as Error).message, "warn");
      return;
    }
    if (ticket !== this.windTicket) return;
    this.flow.set("ocean", { ...field(got, 0), hole }, this.density);
  }

  dropWind(): void {
    this.flow.remove("ocean");
  }

  /** Particles on the cube's top face: its box, its top depth, at its top's height. */
  async showCubeCurrents(request: CubeRequest, depth: number, height: number): Promise<void> {
    const ticket = ++this.cubeWindTicket;
    if (!this.cubeWindOn) {
      this.dropCubeWind();
      return;
    }
    let got: Awaited<ReturnType<typeof api.getCurrents>>;
    try {
      got = await api.getCurrents(request.day, Math.round(depth), request);
    } catch (error) {
      if (ticket === this.cubeWindTicket) this.status((error as Error).message, "warn");
      return;
    }
    if (ticket !== this.cubeWindTicket) return;
    this.flow.set("cube", field(got, height), 4000);
  }

  dropCubeWind(): void {
    this.flow.remove("cube");
  }

  /** Hide everything (the Bay volume view has its own streamlines). */
  setVisible(visible: boolean): void {
    if (this.imagery) this.imagery.show = visible && this.surfaceOn;
    this.flow.show(visible);
    this.kick();
  }
}

function field(got: { meta: api.CurrentsMeta; u: Float32Array; v: Float32Array },
               height: number): Field {
  const [nx, ny] = got.meta.dimensions;
  return {
    u: got.u, v: got.v, nx, ny, height,
    west: got.meta.lonRange[0], east: got.meta.lonRange[1],
    south: got.meta.latRange[0], north: got.meta.latRange[1],
  };
}
