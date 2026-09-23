/**
 * Graphics settings: four quality tiers, an auto-tuner that picks the best one holding
 * 60 fps, and render-on-demand so an idle globe costs nothing.
 *
 * Measured on the development laptop (integrated GPU, 1586 x 806 canvas) with the INCOIS
 * volume on screen, in a Chrome that was not throttling the window:
 *
 *   volume hidden                                   60 fps (vsync)
 *   volume, MSAA off, resolution 100%               15 fps
 *   volume, MSAA off, resolution 75%                ~26 fps
 *   volume, MSAA off, resolution 50%, no sky        55 fps
 *
 * The volume is the whole cost and it is fill-rate bound: every pixel marches a ray. So
 * resolution is the lever, and pixel count goes with its square. MSAA goes first anyway
 * because FXAA replaces it almost for free.
 *
 * Two levers that look like they should help and do not:
 *   - VoxelPrimitive.stepSize. Cesium's marcher stops at every voxel boundary whatever
 *     the step (VoxelFS.glsl getStepSize clamps to the distance to the next boundary),
 *     so a coarser step changed nothing measurable here (13 -> 17 fps from 1x to 6x).
 *     It is not offered, rather than offered as a slider that does nothing.
 *   - Globe translucency. Off roughly triples the frame rate, but only because the
 *     opaque sea surface then hides the volume from the depth test. Not a tier.
 */

import type { Viewer } from "@cesium/widgets";

export interface Quality {
  msaa: 1 | 2 | 4;
  fxaa: boolean;
  resolution: number; // multiplier on the browser-recommended resolution
  sky: boolean; // atmosphere, stars, sun, moon
  onDemand: boolean; // render only when something changed
  showFps: boolean;
}

export type TierName = "high" | "medium" | "low" | "minimum";

export const TIERS: Record<TierName, Omit<Quality, "onDemand" | "showFps">> = {
  high: { msaa: 4, fxaa: false, resolution: 1, sky: true },
  medium: { msaa: 1, fxaa: true, resolution: 0.75, sky: true },
  low: { msaa: 1, fxaa: true, resolution: 0.6, sky: true },
  minimum: { msaa: 1, fxaa: false, resolution: 0.45, sky: false },
};

export const TIER_ORDER: TierName[] = ["high", "medium", "low", "minimum"];

/** Frames per second the auto-tuner accepts as "60". vsync jitter reads 57-59. */
const TARGET_FPS = 55;
// v2: v1 stored a raymarch-step lever that turned out to do nothing (see above).
const STORAGE_KEY = "vvater.graphics.v2";

export class Graphics {
  quality: Quality = { ...TIERS.medium, onDemand: true, showFps: false };
  tier: TierName | "custom" = "medium";
  auto = true;
  private burstUntil = 0;

  constructor(private viewer: Viewer) {
    // Keep rendering while a burst is live: voxel tiles, entities and imagery load over
    // several frames and not all of them ask for a render when they land.
    // preUpdate, not preRender: it fires on every tick of the render loop, including the
    // ticks render-on-demand decides to skip, so a burst can never stall itself.
    viewer.scene.preUpdate.addEventListener(() => {
      if (performance.now() < this.burstUntil) viewer.scene.requestRender();
    });
    this.restore();
  }

  /** Render continuously for `ms`, then go back to on-demand. Cheap to over-call. */
  kick(ms = 600): void {
    this.burstUntil = Math.max(this.burstUntil, performance.now() + ms);
    this.viewer.scene.requestRender();
  }

  apply(q: Partial<Quality> = {}): void {
    Object.assign(this.quality, q);
    const { scene } = this.viewer;
    const v = this.quality;

    scene.msaaSamples = v.msaa;
    scene.postProcessStages.fxaa.enabled = v.fxaa;
    this.viewer.resolutionScale = v.resolution;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = v.sky;
    if (scene.skyBox) scene.skyBox.show = v.sky;
    if (scene.sun) scene.sun.show = v.sky;
    if (scene.moon) scene.moon.show = v.sky;
    scene.globe.showGroundAtmosphere = v.sky;
    scene.fog.enabled = v.sky;
    scene.requestRenderMode = v.onDemand;
    // Infinity: time does not change the scene here (the timeline is ours, not Cesium's
    // clock), so the clock alone must never trigger a frame.
    scene.maximumRenderTimeChange = Infinity;
    scene.debugShowFramesPerSecond = v.showFps;
    this.kick();
    this.save();
  }

  setTier(name: TierName, auto = false): void {
    this.tier = name;
    this.auto = auto;
    this.apply(TIERS[name]);
  }

  /** A manual change to any single lever makes the tier "custom" and stops auto. */
  setCustom(q: Partial<Quality>): void {
    const isQualityLever = Object.keys(q).some((k) => k !== "onDemand" && k !== "showFps");
    if (isQualityLever) {
      this.tier = "custom";
      this.auto = false;
    }
    this.apply(q);
  }

  /**
   * Frames actually rendered per second, forcing a render every animation frame.
   * Counting requestAnimationFrame instead would read 60 while render-on-demand skipped
   * every frame, which is how a tuner convinces itself a slow machine is fast.
   */
  async measure(ms = 1500): Promise<number> {
    const { scene } = this.viewer;
    let frames = 0;
    const count = () => { frames++; };
    // Let the first frames after a change (shader recompiles, framebuffer resize) pass.
    this.kick(ms + 400);
    await new Promise((r) => setTimeout(r, 400));
    scene.postRender.addEventListener(count);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    scene.postRender.removeEventListener(count);
    return (frames * 1000) / (performance.now() - t0);
  }

  /**
   * Walk the tiers from best to worst and keep the first that holds TARGET_FPS.
   * Runs against whatever is on screen, so it is called after a volume has rendered —
   * tuning against an empty globe picks "high" and then stutters on the first volume.
   */
  async autoTune(report: (message: string) => void = () => {},
                 fromTop = false): Promise<TierName> {
    if (document.hidden) {
      // A hidden tab renders nothing; measuring it would pick "minimum" every time.
      await new Promise<void>((resolve) => {
        const onShow = () => {
          if (document.hidden) return;
          document.removeEventListener("visibilitychange", onShow);
          resolve();
        };
        document.addEventListener("visibilitychange", onShow);
      });
    }
    // Start from the last auto result, not from "high": walking down from the top on
    // every launch meant five seconds of visible stutter on exactly the machines that
    // needed the tuner. Choosing "Auto" in the panel walks from the top again.
    // shortcut: only steps down from the saved tier; a faster display later is found by
    // choosing Auto, not automatically.
    const saved = TIER_ORDER.indexOf(this.tier as TierName);
    const start = !fromTop && this.auto && saved > 0 ? saved : 0;
    let chosen: TierName = "minimum";
    let fps = 0;
    for (const name of TIER_ORDER.slice(start)) {
      this.setTier(name, true);
      report(`tuning graphics: trying ${name}…`);
      fps = await this.measure();
      chosen = name;
      if (fps >= TARGET_FPS) break;
    }
    // The measured number, not the target: if even "minimum" misses 60 it says so.
    report(`graphics: ${chosen} (auto) · ${fps.toFixed(0)} fps measured`);
    return chosen;
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        quality: this.quality, tier: this.tier, auto: this.auto,
      }));
    } catch {
      // Storage can be unavailable (private window, blocked site data). The defaults
      // are fine; the tuner simply runs again next time.
    }
  }

  private restore(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (!saved) return;
      this.quality = { ...this.quality, ...saved.quality };
      this.tier = saved.tier;
      this.auto = saved.auto;
    } catch {
      // Unreadable or absent: keep the defaults.
    }
  }
}
