/**
 * The Ocean Cube's controls and state: which water, which day, which variable, how it is
 * cut, and what the cursor is over. The scene is `scene.ts`, the sampling is `data.ts`;
 * this file is the part a person touches.
 *
 * The URL carries the cube (`?v=temperature&day=2020-02-15&box=-80,-50,30,45&depth=2000`,
 * or `?scenario=gulf_stream`), so a view can be sent to someone and opens as it was.
 */

import {
  Cartesian2,
  Cartographic,
  Color,
  Entity,
  Math as CesiumMath,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import * as api from "../api";
import type { Catalog, CatalogVariable, CubeRequest, Scenario } from "../api";
import { byId, hasPalette, paletteLut } from "../colorbar";
import { CubeData, depthToT, niceStep, tToDepth } from "./data";
import { type Style, paintLevel } from "./paint";
import { type Cut, CubeScene } from "./scene";

/** The colour the cube is painted with; the colour-map controls edit this. */
export interface CubeColour {
  paletteId: string;
  reversed: boolean;
  log: boolean;
  range: [number, number];
}

export interface CubeHooks {
  viewer: Viewer;
  status: (message: string, kind?: "info" | "busy" | "warn" | "error") => void;
  kick: (ms?: number) => void;
  /** A cube arrived: sync the colour controls, legend, provenance and HUD. */
  onLoaded: (cube: CubeController) => void;
  /** Point the orbit camera at the cube. */
  aim: (cube: CubeController) => void;
  /** Hand mouse input to the box tool (false) and back to the camera (true). */
  navigation: (enabled: boolean) => void;
}

const MAX_BOX = { lon: 100, lat: 80 };  // server/ocean/cube.py MAX_BOX_DEG
const DAY_MS = 86_400_000;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtDeg = (v: number, pos: string, neg: string) =>
  `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;
const lonLabel = (lon: number) => {
  const w = lon > 180 ? lon - 360 : lon;
  return fmtDeg(w, "E", "W");
};

export class CubeController {
  readonly scene: CubeScene;
  data?: CubeData;
  request?: CubeRequest;
  variable?: CatalogVariable;
  colour: CubeColour = { paletteId: "thermal", reversed: false, log: false, range: [0, 1] };
  /** Cut as fractions: depth ones in the depth axis (0 top), sides in degrees across. */
  cut = { top: 0, bottom: 1, west: 0, east: 1, south: 0, north: 1 };
  heightFraction = 0.3;
  /** Called after every repaint: the HUD and the map section follow the cut. */
  onRepaint?: () => void;
  stretched = true;
  native = false;
  contours = true;
  private ticket = 0;
  private repaintFrame?: number;
  private catalog!: Catalog;
  private drawing?: { start?: Cartographic; entity?: Entity };
  private handler: ScreenSpaceEventHandler;

  constructor(private hooks: CubeHooks) {
    this.scene = new CubeScene(hooks.viewer.scene);
    this.handler = new ScreenSpaceEventHandler(hooks.viewer.canvas);
  }

  // ---------------------------------------------------------------- setup

  async init(catalog: Catalog): Promise<void> {
    this.catalog = catalog;
    for (const v of catalog.variables) {
      if (!hasPalette(v.palette)) {
        this.hooks.status(`the catalogue names an unknown palette ${v.palette} for ${v.key}`, "warn");
      }
    }
    const scenarioSelect = el<HTMLSelectElement>("cube-scenario");
    for (const s of catalog.scenarios) scenarioSelect.add(new Option(s.title, s.key));
    scenarioSelect.add(new Option("Your own box", ""));

    const variableSelect = el<HTMLSelectElement>("cube-variable");
    const groups: Record<string, string> = { physics: "Physics", biogeochemistry: "Biogeochemistry" };
    for (const [group, label] of Object.entries(groups)) {
      const og = document.createElement("optgroup");
      og.label = label;
      for (const v of catalog.variables.filter((x) => x.group === group && x.depth && x.eras.length)) {
        og.append(new Option(v.title + (v.units ? ` (${v.units})` : ""), v.key));
      }
      variableSelect.append(og);
    }
    this.bindControls();

    // The URL wins; otherwise the flagship scenario.
    const q = new URLSearchParams(location.search);
    const box = q.get("box")?.split(",").map(Number);
    const fromUrl = q.get("scenario") ?? (box?.length === 4 ? "" : "bay_of_bengal");
    const scenario = catalog.scenarios.find((s) => s.key === fromUrl);
    if (scenario) {
      this.applyScenario(scenario);
    } else {
      scenarioSelect.value = "";
      if (box?.length === 4) this.setBoxInputs(box[0], box[1], box[2], box[3]);
      el<HTMLSelectElement>("cube-variable").value = q.get("v") ?? "temperature";
      el<HTMLInputElement>("cube-day").value = q.get("day") ?? catalog.today;
      el<HTMLSelectElement>("cube-depth").value = q.get("depth") ?? "2000";
    }
    if (q.get("cut")) {
      const [top, bottom, west, east, south, north] = q.get("cut")!.split(",").map(Number);
      this.cut = { top, bottom, west, east, south, north };
    }
    this.refreshDayLimits();
    await this.load();
  }

  private applyScenario(s: Scenario): void {
    el<HTMLSelectElement>("cube-scenario").value = s.key;
    el<HTMLSelectElement>("cube-variable").value = s.variable;
    el<HTMLInputElement>("cube-day").value = s.day;
    el<HTMLSelectElement>("cube-depth").value = String(
      [200, 500, 1000, 2000, 4000, 6000].find((d) => d >= s.depthMax) ?? 6000);
    this.setBoxInputs(...s.box);
    el("cube-why").textContent = s.why;
    this.cut = { top: 0, bottom: 1, west: 0, east: 1, south: 0, north: 1 };
    this.refreshDayLimits();
  }

  private setBoxInputs(w: number, e: number, s: number, n: number): void {
    el<HTMLInputElement>("cube-w").value = String(w > 180 ? w - 360 : w);
    el<HTMLInputElement>("cube-e").value = String(e > 180 ? e - 360 : e);
    el<HTMLInputElement>("cube-s").value = String(s);
    el<HTMLInputElement>("cube-n").value = String(n);
  }

  private variableKey(): string {
    return el<HTMLSelectElement>("cube-variable").value;
  }

  /** The day picker spans what the chosen variable actually has, from its eras. */
  private refreshDayLimits(): void {
    const v = this.catalog.variables.find((x) => x.key === this.variableKey());
    if (!v?.eras.length) return;
    const day = el<HTMLInputElement>("cube-day");
    day.min = v.eras.map((e) => e.from).sort()[0];
    day.max = v.eras.map((e) => e.to).sort().at(-1)!;
    this.describeEra();
  }

  private describeEra(): void {
    const v = this.catalog.variables.find((x) => x.key === this.variableKey());
    const day = el<HTMLInputElement>("cube-day").value;
    const node = el("cube-era");
    if (!v) return;
    const era = v.eras.find((e) => day >= e.from && day <= e.to);
    const forecast = day > this.catalog.today;
    node.classList.toggle("forecast", forecast);
    node.textContent = era
      ? `${forecast ? "FORECAST · " : ""}${era.source} (${era.name}), ` +
        `${era.from} to ${era.to}`
      : `no ${v.title.toLowerCase()} on this day; available ` +
        v.eras.map((e) => `${e.from} to ${e.to}`).join(", ");
  }

  private readRequest(): CubeRequest | string {
    const num = (id: string) => Number(el<HTMLInputElement>(id).value);
    let lon0 = num("cube-w");
    let lon1 = num("cube-e");
    const lat0 = num("cube-s");
    const lat1 = num("cube-n");
    if ([lon0, lon1, lat0, lat1].some((v) => !Number.isFinite(v))) return "the box needs four numbers";
    if (lon1 <= lon0) lon1 += 360;  // across the antimeridian
    if (lon1 - lon0 > MAX_BOX.lon || lat1 - lat0 > MAX_BOX.lat || lat1 <= lat0) {
      return `a cube can be at most ${MAX_BOX.lon}° wide and ${MAX_BOX.lat}° tall`;
    }
    const width = lon1 - lon0;
    lon0 = ((lon0 + 540) % 360) - 180;
    return {
      variable: this.variableKey(), lon0, lon1: lon0 + width,
      lat0, lat1, day: el<HTMLInputElement>("cube-day").value,
      depthMax: Number(el<HTMLSelectElement>("cube-depth").value),
    };
  }

  // ---------------------------------------------------------------- loading

  async load(): Promise<void> {
    const request = this.readRequest();
    if (typeof request === "string") {
      this.hooks.status(request, "warn");
      return;
    }
    const ticket = ++this.ticket;
    const variable = this.catalog.variables.find((v) => v.key === request.variable)!;
    this.hooks.status(`fetching ${variable.title.toLowerCase()} for ${request.day}…`, "busy");
    let got: Awaited<ReturnType<typeof api.getCube>>;
    try {
      got = await api.getCube(request);
    } catch (error) {
      if (ticket === this.ticket) this.hooks.status((error as Error).message, "error");
      return;
    }
    if (ticket !== this.ticket) return;  // a newer request was made meanwhile
    const sameVariable = this.variable?.key === variable.key;
    this.request = request;
    this.variable = variable;
    this.data = new CubeData(got.meta, got.values, got.seafloor);
    // A new variable takes its own palette and range; the same variable keeps whatever
    // the user set, so stepping through days keeps one colour meaning one value.
    if (!sameVariable) {
      this.colour = {
        paletteId: hasPalette(variable.palette) ? variable.palette : "viridis",
        reversed: false,
        log: variable.log && got.meta.valueRange[0] > 0,
        range: [...got.meta.valueRange] as [number, number],
      };
    }
    this.writeUrl();
    this.repaintNow();
    this.hooks.onLoaded(this);
    this.hooks.aim(this);
    const p = got.meta.provenance;
    const [nx, ny, nz] = got.meta.dimensions;
    this.hooks.status(`${p.title} · ${p.day}${p.forecast ? " · FORECAST" : ""} · ` +
      `${p.sources[0].source} · ${nx}×${ny} cells × ${nz} native levels`);
    this.prefetch(1);
  }

  /** Warm tomorrow while today is being looked at; the browser caches the response. */
  private prefetch(days: number): void {
    if (!this.request) return;
    const next = shiftDay(this.request.day, days);
    const day = el<HTMLInputElement>("cube-day");
    if (next > day.max) return;
    void api.getCube({ ...this.request, day: next }).catch(() => undefined);
  }

  /** Step the day and reload; used by the timeline. */
  async setDay(day: string): Promise<void> {
    el<HTMLInputElement>("cube-day").value = day;
    this.describeEra();
    await this.load();
  }

  // ---------------------------------------------------------------- drawing

  currentCut(): Cut | undefined {
    const d = this.data;
    if (!d) return undefined;
    const axis = this.stretched ? "stretched" : "linear";
    const top = 0;
    const bottom = d.maxDepth;
    const depthAt = (f: number) => tToDepth(f, top, bottom, axis);
    const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
    return {
      lon0: lerp(d.west, d.east, this.cut.west), lon1: lerp(d.west, d.east, this.cut.east),
      lat0: lerp(d.south, d.north, this.cut.south), lat1: lerp(d.south, d.north, this.cut.north),
      top: depthAt(this.cut.top), bottom: depthAt(this.cut.bottom),
    };
  }

  /**
   * Display height: a fraction of the box's shorter side, so any cube reads as a block.
   * The longer side made a long thin box (the equatorial Pacific, 100 x 20 deg) into a wall
   * thousands of kilometres high.
   */
  displayHeight(): number {
    const d = this.data!;
    const lat = (d.south + d.north) / 2;
    const side = Math.min((d.east - d.west) * 111_320 * Math.cos(lat * Math.PI / 180),
                          (d.north - d.south) * 110_574);
    return side * this.heightFraction;
  }

  /** Whether a place is inside the cube's footprint (for which markers to show). */
  contains(lon: number, lat: number): boolean {
    const d = this.data;
    if (!d) return false;
    const l = lon < d.west ? lon + 360 : lon;
    return l >= d.west && l <= d.east && lat >= d.south && lat <= d.north;
  }

  /** Repaint on the next frame; many control events in one frame cost one repaint. */
  repaint(): void {
    if (this.repaintFrame) return;
    this.repaintFrame = requestAnimationFrame(() => {
      this.repaintFrame = undefined;
      this.repaintNow();
    });
  }

  style(): Style {
    const [lo, hi] = this.colour.range;
    return {
      lut: paletteLut(byId(this.colour.paletteId), this.colour.reversed),
      lo, hi, log: this.colour.log,
      step: this.contours ? niceStep(lo, hi) : 0,
      vertical: this.native ? "native" : "smooth",
      axis: this.stretched ? "stretched" : "linear",
      cubeTop: 0, cubeBottom: this.data!.maxDepth,
    };
  }

  /** The top of the cut as a flat image, for the Map 2D view. */
  mapSection(): { canvas: HTMLCanvasElement; west: number; east: number; south: number;
                  north: number } | undefined {
    const d = this.data;
    const cut = this.currentCut();
    if (!d || !cut) return undefined;
    const w = Math.min(1024, Math.round((cut.lon1 - cut.lon0) / ((d.east - d.west) / (d.nx - 1)) + 1) * 4);
    const h = Math.min(1024, Math.round((cut.lat1 - cut.lat0) / ((d.north - d.south) / (d.ny - 1)) + 1) * 4);
    const wrap = (lon: number) => (lon > 180 ? lon - 360 : lon);
    return {
      canvas: paintLevel(d, cut.lon0, cut.lon1, cut.lat0, cut.lat1, cut.top, this.style(), w, h),
      west: wrap(cut.lon0), east: wrap(cut.lon1), south: cut.lat0, north: cut.lat1,
    };
  }

  repaintNow(): void {
    const d = this.data;
    const cut = this.currentCut();
    if (!d || !cut) return;
    this.scene.render(d, cut, this.style(), this.displayHeight());
    this.onRepaint?.();
    this.labelCut(cut);
    el("cube-height-label").textContent = `×${Math.round(this.scene.exaggeration)}`;
    this.hooks.kick(400);
  }

  private labelCut(cut: Cut): void {
    el("cut-top-label").textContent = `${Math.round(cut.top)} m`;
    el("cut-bottom-label").textContent = `${Math.round(cut.bottom)} m`;
    el("cut-west-label").textContent = lonLabel(cut.lon0).replace(/\.\d+/, "");
    el("cut-east-label").textContent = lonLabel(cut.lon1).replace(/\.\d+/, "");
    el("cut-south-label").textContent = fmtDeg(cut.lat0, "N", "S").replace(/\.\d+/, "");
    el("cut-north-label").textContent = fmtDeg(cut.lat1, "N", "S").replace(/\.\d+/, "");
  }

  private writeUrl(): void {
    const r = this.request!;
    const q = new URLSearchParams(location.search);
    const scenario = el<HTMLSelectElement>("cube-scenario").value;
    for (const k of ["scenario", "v", "day", "box", "depth", "cut"]) q.delete(k);
    q.set("v", r.variable);
    q.set("day", r.day);
    q.set("box", [r.lon0, r.lon1, r.lat0, r.lat1].join(","));
    q.set("depth", String(r.depthMax));
    if (scenario) q.set("scenario", scenario);
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }

  // ---------------------------------------------------------------- controls

  private bindControls(): void {
    el<HTMLSelectElement>("cube-scenario").addEventListener("change", (e) => {
      const s = this.catalog.scenarios.find((x) => x.key === (e.target as HTMLSelectElement).value);
      if (s) {
        this.applyScenario(s);
        void this.load();
      }
    });
    el<HTMLSelectElement>("cube-variable").addEventListener("change", () => {
      this.refreshDayLimits();
      void this.load();
    });
    el<HTMLInputElement>("cube-day").addEventListener("change", () => {
      this.describeEra();
      void this.load();
    });
    el<HTMLSelectElement>("cube-depth").addEventListener("change", () => void this.load());
    el("cube-load").addEventListener("click", () => {
      el<HTMLSelectElement>("cube-scenario").value = "";
      el("cube-why").textContent = "";
      void this.load();
    });
    el("cube-draw").addEventListener("click", () => this.toggleDrawing());

    // Cut sliders: each side is clamped against its opposite, so a cut can never turn
    // inside out.
    const bindCut = (id: string, key: keyof CubeController["cut"], min: () => number,
                     max: () => number) => {
      const node = el<HTMLInputElement>(id);
      node.addEventListener("input", () => {
        const v = Math.min(Math.max(Number(node.value) / 1000, min()), max());
        this.cut[key] = v;
        node.value = String(Math.round(v * 1000));
        this.repaint();
      });
    };
    const gap = 0.02;
    bindCut("cut-top", "top", () => 0, () => this.cut.bottom - gap);
    bindCut("cut-bottom", "bottom", () => this.cut.top + gap, () => 1);
    bindCut("cut-west", "west", () => 0, () => this.cut.east - gap);
    bindCut("cut-east", "east", () => this.cut.west + gap, () => 1);
    bindCut("cut-south", "south", () => 0, () => this.cut.north - gap);
    bindCut("cut-north", "north", () => this.cut.south + gap, () => 1);
    el("cut-reset").addEventListener("click", () => {
      this.cut = { top: 0, bottom: 1, west: 0, east: 1, south: 0, north: 1 };
      this.syncCutSliders();
      this.repaint();
    });
    el("cube-home").addEventListener("click", () => this.hooks.aim(this));

    el<HTMLInputElement>("cube-height").addEventListener("input", (e) => {
      this.heightFraction = Number((e.target as HTMLInputElement).value) / 100;
      this.repaint();
    });
    el<HTMLInputElement>("cube-height").addEventListener("change", () => this.hooks.aim(this));
    el<HTMLInputElement>("cube-stretched").addEventListener("change", (e) => {
      // The depth sliders are positions in the depth axis; keep the depths they point at.
      const before = this.currentCut();
      this.stretched = (e.target as HTMLInputElement).checked;
      if (before && this.data) {
        const axis = this.stretched ? "stretched" : "linear";
        this.cut.top = depthToT(before.top, 0, this.data.maxDepth, axis);
        this.cut.bottom = depthToT(before.bottom, 0, this.data.maxDepth, axis);
        this.syncCutSliders();
      }
      this.repaint();
    });
    el<HTMLInputElement>("cube-contours").addEventListener("change", (e) => {
      this.contours = (e.target as HTMLInputElement).checked;
      this.repaint();
    });
    el<HTMLInputElement>("cube-native").addEventListener("change", (e) => {
      this.native = (e.target as HTMLInputElement).checked;
      this.repaint();
    });
    this.syncCutSliders();
    this.bindProbe();
  }

  /** The probe follows the cursor, at most once a frame (a pick reads the depth buffer). */
  private bindProbe(): void {
    let pending: Cartesian2 | undefined;
    this.handler.setInputAction((m: { endPosition: Cartesian2 }) => {
      if (this.drawing) return;
      const first = !pending;
      pending = Cartesian2.clone(m.endPosition);
      if (first) requestAnimationFrame(() => {
        if (pending) this.readout(pending);
        pending = undefined;
      });
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  syncCutSliders(): void {
    const set = (id: string, v: number) => { el<HTMLInputElement>(id).value = String(Math.round(v * 1000)); };
    set("cut-top", this.cut.top);
    set("cut-bottom", this.cut.bottom);
    set("cut-west", this.cut.west);
    set("cut-east", this.cut.east);
    set("cut-south", this.cut.south);
    set("cut-north", this.cut.north);
    el<HTMLInputElement>("cube-height").value = String(Math.round(this.heightFraction * 100));
  }

  // ---------------------------------------------------------------- probe

  /** The value under a screen position, if the cursor is on the cube. */
  probeAt(position: Cartesian2): { lon: number; lat: number; depth: number; value: number } | undefined {
    const at = this.scene.probe(position);
    if (!at || !this.data) return undefined;
    const value = this.data.valueAt(at, this.native ? "native" : "smooth");
    return { ...at, value };
  }

  private readout(position: Cartesian2): void {
    const hit = this.probeAt(position);
    const node = el("probe-readout");
    if (!hit || !this.variable) return;
    const kind = Number.isNaN(hit.value)
      ? this.data!.kind(this.data!.fx(hit.lon), this.data!.fy(hit.lat), hit.depth)
      : "water";
    const where = `${Math.round(hit.depth)} m · ${fmtDeg(hit.lat, "N", "S")} ${lonLabel(hit.lon)}`;
    const p = this.data!.meta.provenance;
    node.innerHTML = kind === "water"
      ? `<b>${formatValue(hit.value)} ${this.variable.units}</b> ${this.variable.title.toLowerCase()} ` +
        `at ${where}<br>${p.day}${p.forecast ? ' · <span class="forecast">forecast</span>' : ""} · ` +
        `${p.sources[0].source}`
      : `${kind === "rock" ? "below the sea floor" : "land"} at ${where}`;
  }

  /** The whole column under a screen position, native levels only, for the chart. */
  columnAt(position: Cartesian2): { lon: number; lat: number; column: { depth: number; value: number }[] } | undefined {
    const at = this.scene.probe(position);
    if (!at || !this.data) return undefined;
    return { lon: at.lon, lat: at.lat, column: this.data.column(at.lon, at.lat) };
  }

  // ---------------------------------------------------------------- box tool

  private toggleDrawing(): void {
    if (this.drawing) {
      this.endDrawing();
      return;
    }
    this.drawing = {};
    el("cube-draw").classList.add("on");
    this.hooks.navigation(false);
    this.hooks.status("drag a box on the globe; Esc cancels");
    const pick = (p: Cartesian2) => {
      const world = this.hooks.viewer.camera.pickEllipsoid(p);
      return world ? Cartographic.fromCartesian(world) : undefined;
    };
    this.handler.setInputAction((e: { position: Cartesian2 }) => {
      if (!this.drawing) return;
      this.drawing.start = pick(e.position);
    }, ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      const start = this.drawing?.start;
      const here = pick(e.endPosition);
      if (!start || !here) return;
      const rect = boxOf(start, here);
      if (!this.drawing!.entity) {
        this.drawing!.entity = this.hooks.viewer.entities.add({
          rectangle: {
            coordinates: rect,
            material: Color.fromCssColorString("#4dd2ff").withAlpha(0.18),
            outline: true, outlineColor: Color.fromCssColorString("#4dd2ff"), height: 0,
          },
        });
      } else {
        this.drawing!.entity.rectangle!.coordinates = rect as never;
      }
      this.hooks.kick();
    }, ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction((e: { position: Cartesian2 }) => {
      const start = this.drawing?.start;
      const end = pick(e.position);
      if (!start || !end) return;
      const r = boxOf(start, end);
      const snap = (v: number) => Math.round(CesiumMath.toDegrees(v) * 4) / 4;
      const w = snap(r.west);
      let e2 = snap(r.east);
      const s = snap(r.south);
      const n = snap(r.north);
      if (e2 - w < 0.5 || n - s < 0.5) {
        this.hooks.status("that box is too small; drag a larger one", "warn");
        this.drawing!.start = undefined;
        return;
      }
      if (e2 - w > MAX_BOX.lon) e2 = w + MAX_BOX.lon;
      this.setBoxInputs(w, e2, s, Math.min(n, s + MAX_BOX.lat));
      el<HTMLSelectElement>("cube-scenario").value = "";
      el("cube-why").textContent = "";
      this.cut = { top: 0, bottom: 1, west: 0, east: 1, south: 0, north: 1 };
      this.syncCutSliders();
      this.endDrawing();
      void this.load();
    }, ScreenSpaceEventType.LEFT_UP);
    window.addEventListener("keydown", this.escape);
  }

  private escape = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.endDrawing();
  };

  private endDrawing(): void {
    if (this.drawing?.entity) this.hooks.viewer.entities.remove(this.drawing.entity);
    this.drawing = undefined;
    el("cube-draw").classList.remove("on");
    this.handler.removeInputAction(ScreenSpaceEventType.LEFT_DOWN);
    this.handler.removeInputAction(ScreenSpaceEventType.LEFT_UP);
    this.bindProbe();
    window.removeEventListener("keydown", this.escape);
    this.hooks.navigation(true);
    this.hooks.kick();
  }
}

/** The rectangle between two picked points, whichever way the drag went. */
function boxOf(a: Cartographic, b: Cartographic): Rectangle {
  return new Rectangle(Math.min(a.longitude, b.longitude), Math.min(a.latitude, b.latitude),
                       Math.max(a.longitude, b.longitude), Math.max(a.latitude, b.latitude));
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Enough digits to tell neighbouring values apart, whatever the variable's scale. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(2);
}
