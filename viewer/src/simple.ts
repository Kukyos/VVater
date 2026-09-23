/**
 * The Simple view: the whole ocean on a globe, one surface layer at a time, a colour bar
 * and a timeline. For a first look, an exhibition screen or a classroom -- the brief's
 * outreach audience -- before anyone needs a depth slice or a QC flag.
 *
 * The data is server/ocean/globalsurface.py; this file is only the controls. Drawing the
 * layer onto the globe stays in main.ts with everything else that touches the scene.
 */

import type { GlobalLayer, GlobalSurfaceMeta } from "./api";
import { byId, paletteStops } from "./colorbar";

// Line icons, drawn for this page: 24 x 24, stroke only, currentColor.
const ICONS: Record<string, string> = {
  temperature: '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  salinity: '<path d="M12 3c3 4.5 6 7.8 6 11a6 6 0 0 1-12 0c0-3.2 3-6.5 6-11z"/><path d="M9.5 15.5h5"/>',
  currents: '<path d="M3 8c3-2 5 2 8 0s5 2 8 0"/><path d="M3 13c3-2 5 2 8 0s5 2 8 0"/><path d="M17 17l3 1-2 2.5"/><path d="M3 18c3-2 5 2 8 0s4 1.5 9 0"/>',
  sea_level: '<path d="M3 16c3-2 6 2 9 0s6 2 9 0"/><path d="M12 3v9"/><path d="M9 6l3-3 3 3"/>',
  mixed_layer: '<path d="M3 6h18"/><path d="M3 11h18"/><path d="M3 17h7m4 0h7" stroke-dasharray="2 2"/>',
  sea_ice: '<path d="M12 2v20M4 7l16 10M20 7L4 17"/><path d="M9 3.5l3 2 3-2M9 20.5l3-2 3 2"/>',
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class SimpleUI {
  layer = "temperature";
  dayIndex: number;
  playing = false;
  private timer?: number;

  constructor(private layers: GlobalLayer[], readonly days: string[], demoDate: string,
              private onChange: () => Promise<void>) {
    const i = days.findIndex((d) => d >= demoDate);
    this.dayIndex = i < 0 ? 0 : i;
    this.build();
  }

  get day(): string { return this.days[this.dayIndex]; }

  private build(): void {
    const list = el("s-layers");
    list.replaceChildren(...this.layers.map((layer) => {
      const button = document.createElement("button");
      button.dataset.layer = layer.key;
      button.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ` +
        `stroke-linecap="round" stroke-linejoin="round">${ICONS[layer.key] ?? ""}</svg>` +
        `<span><b>${layer.title}</b><i>GLORYS12 reanalysis · surface</i></span>`;
      button.addEventListener("click", () => {
        this.layer = layer.key;
        this.mark();
        void this.onChange();
      });
      return button;
    }));
    this.mark();

    const slider = el<HTMLInputElement>("s-day");
    slider.max = String(this.days.length - 1);
    slider.value = String(this.dayIndex);
    slider.addEventListener("input", () => this.go(Number(slider.value)));
    el("s-prev").addEventListener("click", () => this.go(this.dayIndex - 1));
    el("s-next").addEventListener("click", () => this.go(this.dayIndex + 1));
    el("s-play").addEventListener("click", () => this.setPlaying(!this.playing));

    // Month ticks under the timeline, like any date scrubber.
    const months = el("s-months");
    months.replaceChildren();
    let last = "";
    this.days.forEach((d, i) => {
      const month = new Date(`${d}T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" });
      if (month === last) return;
      last = month;
      const tick = document.createElement("span");
      tick.textContent = month;
      tick.style.left = `${(i / Math.max(this.days.length - 1, 1)) * 100}%`;
      months.append(tick);
    });
    this.showDate();
  }

  private mark(): void {
    el("s-layers").querySelectorAll<HTMLElement>("button").forEach((b) =>
      b.classList.toggle("on", b.dataset.layer === this.layer));
  }

  private showDate(): void {
    el<HTMLInputElement>("s-day").value = String(this.dayIndex);
    el("s-date").textContent = new Date(`${this.day}T00:00:00Z`)
      .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  }

  go(index: number): void {
    this.dayIndex = (index + this.days.length) % this.days.length;
    this.showDate();
    void this.onChange();
  }

  /** Each frame waits for its layer to be drawn, so a slow first fetch never skips days. */
  setPlaying(on: boolean): void {
    this.playing = on;
    el("s-play").innerHTML = on ? "❚❚" : "▶";
    window.clearTimeout(this.timer);
    if (!on) return;
    const step = async () => {
      if (!this.playing) return;
      this.dayIndex = (this.dayIndex + 1) % this.days.length;
      this.showDate();
      await this.onChange();
      if (this.playing) this.timer = window.setTimeout(() => void step(), 1100);
    };
    this.timer = window.setTimeout(() => void step(), 400);
  }

  /** The vertical colour bar: palette, range, units, and where the numbers come from. */
  legend(meta: GlobalSurfaceMeta): void {
    const canvas = el<HTMLCanvasElement>("s-bar");
    const context = canvas.getContext("2d")!;
    const stops = paletteStops(byId(meta.palette), false, 64);
    for (let i = 0; i < canvas.height; i += 1) {
      const [r, g, b] = stops[Math.floor((1 - i / canvas.height) * 63.999)];
      context.fillStyle = `rgb(${r * 255},${g * 255},${b * 255})`;
      context.fillRect(0, i, canvas.width, 1);
    }
    const [lo, hi] = meta.valueRange;
    const digits = hi - lo < 2 ? 2 : hi - lo < 20 ? 1 : 0;
    const ticks = el("s-ticks");
    ticks.replaceChildren(...[0, 1, 2, 3, 4].map((k) => {
      const span = document.createElement("span");
      span.textContent = (hi - ((hi - lo) * k) / 4).toFixed(digits);
      return span;
    }));
    el("s-units").textContent = meta.units;
    el("s-note").textContent =
      `${meta.title} · ${meta.provenance.source}` +
      (meta.provenance.level_m === null ? " · " : ` · ${meta.provenance.level_m} m · `) +
      `${meta.provenance.note}`;
  }
}
