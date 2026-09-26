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
import { type Field, FlowOverlay, type FlowStyle } from "./flow";

type Status = (message: string, kind?: "info" | "busy" | "warn" | "error") => void;

export class OceanLayer {
  private imagery?: ImageryLayer;
  surface?: { meta: api.SurfaceMeta; values: Float32Array; key: string };
  readonly flow: FlowOverlay;
  private surfaceTicket = 0;
  private windTicket = 0;
  private cubeWindTicket = 0;
  private airTicket = 0;
  surfaceOn = true;
  windOn = true;
  cubeWindOn = true;
  airOn = false;
  /** What the air layer shows, for the panel: its day and hour, or why it is missing. */
  airNote = "";
  /** Called whenever airNote changes, so the panel line follows it. */
  onAirNote?: () => void;
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

  // Each drop also bumps its layer's ticket: a fetch already in flight when a layer is
  // turned off would otherwise land afterwards and paint it back (opening straight into
  // immersive showed the cube's colour and currents it had just cleared).
  clearSurface(): void {
    this.surfaceTicket += 1;
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
    this.windTicket += 1;
    this.flow.remove("ocean");
  }

  /** Particles on the cube's top face: its box, its top depth, at its top's height. */
  async showCubeCurrents(request: CubeRequest, depth: number, height: number,
                         keep?: Field["keep"]): Promise<void> {
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
    // About the density the whole-ocean particles have when the cube fills the screen: a
    // fixed 4,000 on a small box turned its top face into white noise.
    const area = Math.abs((request.lon1 - request.lon0) * (request.lat1 - request.lat0));
    this.flow.set("cube", { ...field(got, height), keep },
      Math.round(Math.min(Math.max(area * 20, 300), 3000)));
  }

  /**
   * A side of the cube moved in: the cube's particles stay on what is left of its top, and
   * the ocean's come back over the water the cut uncovered. Particles drawn over the whole
   * original box hung in the air in front of the cut face.
   */
  cutTo(box: NonNullable<Field["keep"]>): void {
    this.flow.bounds("cube", { keep: box });
    this.flow.bounds("ocean", { hole: box });
  }

  /** 10 m wind worldwide, as warm trails over the ocean's white ones (marine.py). */
  async showAir(day: string): Promise<void> {
    const ticket = ++this.airTicket;
    if (!this.airOn) {
      this.flow.remove("air");
      return;
    }
    // Observed wind up to yesterday, the GFS forecast after it; the server decides and
    // the note carries which one it was.
    let got: Awaited<ReturnType<typeof api.getWind>>;
    this.airNote = `loading the wind for ${day}…`;
    this.onAirNote?.();
    try {
      got = await api.getWind(day);
    } catch (error) {
      if (ticket !== this.airTicket) return;
      this.airNote = (error as Error).message;
      this.status(this.airNote, "warn");
      this.onAirNote?.();
      return;
    }
    if (ticket !== this.airTicket) return;
    const p = got.meta.provenance;
    this.airNote = `wind at 10 m, ${String(p.time_utc).replace("T", " ")} UTC · ` +
      (p.forecast ? "forecast, NCEP GFS" : "observed, satellite scatterometers blended with ECMWF") +
      (p.stand_in ? ` · ${p.note}` : "");
    if (p.stand_in) this.status(String(p.note), "warn");
    this.onAirNote?.();
    this.flow.set("air", { ...field(got, 0), style: AIR }, Math.round(this.density * 0.6));
  }

  dropCubeWind(): void {
    this.cubeWindTicket += 1;
    this.flow.remove("cube");
  }

  /** Hide everything (the Bay volume view has its own streamlines). */
  setVisible(visible: boolean): void {
    if (this.imagery) this.imagery.show = visible && this.surfaceOn;
    this.flow.show(visible);
    this.kick();
  }
}

/** Wind: amber, and paced so 10 m/s moves about as fast on screen as a 0.8 m/s current. */
const AIR: FlowStyle = {
  bands: [4, 8, 13],
  colours: ["rgba(255,196,120,0.45)", "rgba(255,210,140,0.65)",
            "rgba(255,226,170,0.85)", "rgba(255,244,215,1)"],
  pace: 0.08,
};

function field(got: { meta: api.CurrentsMeta; u: Float32Array; v: Float32Array },
               height: number): Field {
  const [nx, ny] = got.meta.dimensions;
  return {
    u: got.u, v: got.v, nx, ny, height,
    west: got.meta.lonRange[0], east: got.meta.lonRange[1],
    south: got.meta.latRange[0], north: got.meta.latRange[1],
  };
}
