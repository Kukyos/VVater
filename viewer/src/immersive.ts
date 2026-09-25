/**
 * Immersive view: the globe, its currents and its winds, and nothing else.
 *
 * Every dock, bar and readout goes; a small row of buttons at the top stays. The scene
 * changes it needs (sunlight, sky, a brighter basemap, particles through the cube's hole)
 * are saved on the way in and put back on the way out, so leaving it returns exactly the
 * workspace that was there.
 *
 * **Cinematic** is a camera that tells it by itself: a sequence of shots with cuts between
 * them -- the planet from space, a descent, a skim over the water, first light with the
 * sun on the horizon, and the pull back out to space across the day-night line. The shots
 * are driven frame by frame with `setView`, not `camera.flyTo`: a flight arcs upward on a
 * long hop and slerps its orientation, which ballooned the low shots into space.
 *
 * The sun is where it really is. The sunrise shot picks the minute, on today's date, when
 * the sun stands just above the horizon at that place (Cesium's own solar ephemeris), and
 * points the camera along its azimuth. Only the clock of the lighting is moved; the data
 * on screen keeps its own day, and the key at the bottom says which.
 */

import {
  Cartesian3,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Simon1994PlanetaryPositions,
  Transforms,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { greatCircleStep } from "./camera";

export interface ImmersiveHooks {
  /** Hide the cube and the workspace layers, put the globe view on. */
  enter: () => Promise<void>;
  /** Put the workspace back as it was. */
  exit: () => Promise<void>;
  layer: (name: "currents" | "air" | "colour", on: boolean) => void;
  /** What the particles and colour show, for the key. */
  describe: () => string;
  setBasemapBrightness: (b: number) => number;
  kick: (ms?: number) => void;
  /** The cinematic starts or stops: render every frame, particles synced to the render. */
  cinema: (on: boolean) => void;
}

interface Pose { lon: number; lat: number; height: number; heading: number; pitch: number }

interface Shot {
  title: string;
  sub: string;
  seconds: number;
  from: Pose;
  to: Pose;
  /** The lighting clock: noon over the shot, or the dawn minute found by sunrise(). */
  time: JulianDate;
  ease: "linear" | "glide" | "inOut" | "in";
}

const DEG = Math.PI / 180;
// From 30-42 km up the sea's horizon lies 5.6-6.6 degrees below level, so the sun that
// sits on the horizon in the frame is one still below the sea-level horizon.
const DAWN_ELEVATION = -5;

/** The sun's azimuth and elevation (degrees) seen from a place at a time. */
export function sunAt(time: JulianDate, lon: number, lat: number): { az: number; el: number } {
  const inertial = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
  // ICRF needs Earth-orientation data preloaded; without it Cesium itself falls back to TEME.
  const toFixed = Transforms.computeIcrfToFixedMatrix(time) ??
    Transforms.computeTemeToPseudoFixedMatrix(time);
  const sun = Matrix3.multiplyByVector(toFixed, inertial, new Cartesian3());
  const enu = Matrix4.inverseTransformation(
    Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, 0)), new Matrix4());
  const local = Matrix4.multiplyByPoint(enu, sun, new Cartesian3());
  return {
    az: (Math.atan2(local.x, local.y) / DEG + 360) % 360,
    el: Math.atan2(local.z, Math.hypot(local.x, local.y)) / DEG,
  };
}

/**
 * The minute nearest this UTC day's noon when the sun rises through `elevation` degrees
 * at a place. The search spans a day either side: east of about 80E local dawn falls
 * before 00:00 UTC, and a search from midnight found the sun already up and stopped.
 */
export function sunrise(day: Date, lon: number, lat: number, elevation = 1.5): JulianDate {
  const noonUtc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12);
  let best: JulianDate | undefined;
  let bestGap = Infinity;
  let before = Number.NaN;
  for (let minute = -1440; minute <= 1440; minute += 3) {
    const ms = noonUtc + minute * 60_000;
    const t = JulianDate.fromDate(new Date(ms));
    const el = sunAt(t, lon, lat).el;
    if (before < elevation && el >= elevation && Math.abs(minute) < bestGap) {
      best = t;
      bestGap = Math.abs(minute);
    }
    before = el;
  }
  return best ?? JulianDate.fromDate(new Date(noonUtc));  // polar day or night: any time will do
}

/** The UTC time when the sun is highest over a longitude on a day. */
function noon(day: Date, lon: number): JulianDate {
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return JulianDate.fromDate(new Date(midnight + (12 - lon / 15) * 3_600_000));
}

function shots(): Shot[] {
  // First light over the Bay of Bengal, looking along the sun's own bearing. The dawn
  // search is a few thousand ephemeris calls, so it runs once per loop, here, and never
  // at a cut where it would hold up the first frame of a shot.
  const today = new Date();
  const dawn = { lon: 88, lat: 12 };
  const sunTime = sunrise(today, dawn.lon, dawn.lat, DAWN_ELEVATION);
  const az = sunAt(sunTime, dawn.lon, dawn.lat).az;
  const ahead = greatCircleStep(dawn.lat, dawn.lon, az, 320_000);
  const skimEnd = greatCircleStep(9, 84, 40, 700_000);
  return [
    { title: "The ocean, moving", sub: "currents and winds on one day, over the whole planet",
      seconds: 14, time: noon(today, 96), ease: "linear",
      from: { lon: 38, lat: -2, height: 23_000_000, heading: 0, pitch: -90 },
      to: { lon: 96, lat: 8, height: 19_000_000, heading: 0, pitch: -90 } },
    { title: "Down to the Bay of Bengal", sub: "", seconds: 11, time: noon(today, 86), ease: "inOut",
      from: { lon: 80, lat: -9, height: 4_500_000, heading: 12, pitch: -72 },
      to: { lon: 86, lat: 5, height: 650_000, heading: 24, pitch: -38 } },
    { title: "Over the water", sub: "each trail is the day's flow at the surface", seconds: 12,
      time: noon(today, skimEnd.lon), ease: "glide",
      from: { lon: 84, lat: 9, height: 70_000, heading: 40, pitch: -14 },
      to: { lon: skimEnd.lon, lat: skimEnd.lat, height: 26_000, heading: skimEnd.bearing, pitch: -9 } },
    { title: "First light", sub: "the sun where it stands at dawn today", seconds: 15,
      time: sunTime, ease: "glide",
      from: { lon: dawn.lon, lat: dawn.lat, height: 30_000, heading: az, pitch: -4.5 },
      to: { lon: ahead.lon, lat: ahead.lat, height: 42_000, heading: ahead.bearing, pitch: -3.5 } },
    { title: "", sub: "", seconds: 15, time: sunTime, ease: "in",
      from: { lon: ahead.lon, lat: ahead.lat, height: 42_000, heading: ahead.bearing, pitch: -3.5 },
      to: { lon: 84, lat: 2, height: 15_000_000, heading: 0, pitch: -90 } },
  ];
}

const ease = {
  linear: (t: number) => t,
  // Linear through the middle, eased over the first and last tenth: a camera that is
  // already moving when the shot fades in, and does not stop dead as it fades out.
  glide: (t: number) => {
    const e = 0.1;
    const v = 1 / (1 - e);  // cruise speed so the whole curve still ends at 1
    if (t < e) return (v * t * t) / (2 * e);
    if (t > 1 - e) return 1 - (v * (1 - t) * (1 - t)) / (2 * e);
    return v * (t - e / 2);
  },
  inOut: (t: number) => t * t * (3 - 2 * t),
  in: (t: number) => t * t * t,
};

/** Shortest way round between two headings, in degrees. */
function turn(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

export class Immersive {
  active = false;
  private saved?: {
    lighting: boolean; dynamicLight: boolean; sky: boolean; sun: boolean; stars: boolean;
    moon: boolean; brightness: number; time: JulianDate; animate: boolean;
  };
  private layers = { currents: true, air: true, colour: false };
  private light = true;
  private cine?: { shots: Shot[]; index: number; started: number; rolling: boolean };
  /** The sky as it was before the cinematic brightened it. */
  private skySaved?: { glow: number; light: number; mie: Cartesian3; aniso: number };
  private app = document.getElementById("app")!;

  constructor(private viewer: Viewer, private hooks: ImmersiveHooks) {
    const on = (id: string, fn: () => void) =>
      document.getElementById(id)!.addEventListener("click", fn);
    on("imm-exit", () => void this.leave());
    on("imm-cinema", () => (this.cine ? this.stopCinema() : this.startCinema()));
    on("imm-light", () => this.setLight(!this.light));
    for (const name of ["currents", "air", "colour"] as const) {
      on(`imm-${name}`, () => this.setLayer(name, !this.layers[name]));
    }
    // Any hand on the globe takes the camera back from the cinematic.
    viewer.canvas.addEventListener("pointerdown", () => { if (this.cine) this.stopCinema(); });
  }

  async enter(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const scene = this.viewer.scene;
    this.saved = {
      lighting: scene.globe.enableLighting,
      dynamicLight: scene.globe.dynamicAtmosphereLighting,
      sky: scene.skyAtmosphere?.show ?? false, sun: scene.sun?.show ?? false,
      stars: scene.skyBox?.show ?? false, moon: scene.moon?.show ?? false,
      brightness: this.hooks.setBasemapBrightness(1),
      time: JulianDate.clone(this.viewer.clock.currentTime),
      animate: this.viewer.clock.shouldAnimate,
    };
    this.app.classList.add("immersive");
    await this.hooks.enter();
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    if (scene.sun) scene.sun.show = true;
    if (scene.skyBox) scene.skyBox.show = true;
    if (scene.moon) scene.moon.show = true;
    this.viewer.clock.shouldAnimate = false;
    this.viewer.clock.currentTime = JulianDate.now();
    this.setLight(this.light);
    for (const name of ["currents", "air", "colour"] as const) this.setLayer(name, this.layers[name]);
    this.hooks.kick(1500);
  }

  async leave(): Promise<void> {
    if (!this.active) return;
    this.stopCinema();
    this.active = false;
    const scene = this.viewer.scene;
    const s = this.saved!;
    scene.globe.enableLighting = s.lighting;
    scene.globe.dynamicAtmosphereLighting = s.dynamicLight;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = s.sky;
    if (scene.sun) scene.sun.show = s.sun;
    if (scene.skyBox) scene.skyBox.show = s.stars;
    if (scene.moon) scene.moon.show = s.moon;
    this.hooks.setBasemapBrightness(s.brightness);
    this.viewer.clock.currentTime = s.time;
    this.viewer.clock.shouldAnimate = s.animate;
    this.app.classList.remove("immersive");
    await this.hooks.exit();
    this.hooks.kick(1500);
  }

  toggle(): Promise<void> {
    return this.active ? this.leave() : this.enter();
  }

  setLayer(name: "currents" | "air" | "colour", on: boolean): void {
    this.layers[name] = on;
    document.getElementById(`imm-${name}`)!.classList.toggle("on", on);
    this.hooks.layer(name, on);
    this.renderKey();
  }

  setLight(on: boolean): void {
    this.light = on;
    this.viewer.scene.globe.enableLighting = on;
    this.viewer.scene.globe.dynamicAtmosphereLighting = on;
    document.getElementById("imm-light")!.classList.toggle("on", on);
    this.hooks.kick(300);
  }

  renderKey(): void {
    document.getElementById("immersive-key")!.textContent = this.hooks.describe();
  }

  // ---------------------------------------------------------------- cinematic

  startCinema(): void {
    if (!this.active || this.cine) return;
    const scene = this.viewer.scene;
    scene.screenSpaceCameraController.enableInputs = false;
    this.app.classList.add("cinema");
    document.getElementById("imm-cinema")!.classList.add("on");
    this.cine = { shots: shots(), index: -1, started: 0, rolling: false };
    this.brightSky(true);
    this.hooks.cinema(true);
    // The pose is set inside Cesium's own tick, just before it renders, so the globe and
    // the particles drawn after it always see the same camera.
    scene.preUpdate.addEventListener(this.roll);
    void this.cut();
  }

  stopCinema(): void {
    if (!this.cine) return;
    this.cine = undefined;
    const scene = this.viewer.scene;
    scene.preUpdate.removeEventListener(this.roll);
    this.hooks.cinema(false);
    this.brightSky(false);
    this.app.classList.remove("cinema");
    document.getElementById("imm-cinema")!.classList.remove("on");
    document.getElementById("cinema-title")!.classList.remove("on");
    document.getElementById("cinema-fade")!.classList.remove("on");
    this.viewer.clock.currentTime = JulianDate.now();
    scene.screenSpaceCameraController.enableInputs = true;
    this.hooks.kick(300);
  }

  /**
   * A brighter, softer sun for the film: a wider glow on the disc and more forward
   * scattering in the sky around it, so a sun on the horizon reads as a bright haze
   * rather than a hard dot. Set once for the whole film (not per shot) because each
   * change to the glow rebuilds the sun's texture. Put back exactly on the way out.
   */
  private brightSky(on: boolean): void {
    const { sun, skyAtmosphere: sky } = this.viewer.scene;
    if (!sun || !sky) return;
    if (on) {
      this.skySaved = { glow: sun.glowFactor, light: sky.atmosphereLightIntensity,
                        mie: Cartesian3.clone(sky.atmosphereMieCoefficient), aniso: sky.atmosphereMieAnisotropy };
      sun.glowFactor = 4;
      sky.atmosphereLightIntensity = 72;
      sky.atmosphereMieCoefficient = Cartesian3.multiplyByScalar(this.skySaved.mie, 2.2, new Cartesian3());
      sky.atmosphereMieAnisotropy = 0.84;
    } else if (this.skySaved) {
      const s = this.skySaved;
      sun.glowFactor = s.glow;
      sky.atmosphereLightIntensity = s.light;
      sky.atmosphereMieCoefficient = s.mie;
      sky.atmosphereMieAnisotropy = s.aniso;
      this.skySaved = undefined;
    }
  }

  /** To black, set the next shot up, back from black, and roll. */
  private async cut(): Promise<void> {
    const cine = this.cine;
    if (!cine) return;
    const fade = document.getElementById("cinema-fade")!;
    const title = document.getElementById("cinema-title")!;
    title.classList.remove("on");
    cine.rolling = false;
    if (cine.index >= 0) {
      fade.classList.add("on");
      await new Promise((r) => setTimeout(r, 480));
      if (this.cine !== cine) return;
    }
    cine.index = (cine.index + 1) % cine.shots.length;
    if (cine.index === 0 && cine.started) cine.shots = shots();  // a new loop re-reads today's sun
    const shot = cine.shots[cine.index];
    this.viewer.clock.currentTime = shot.time;
    this.pose(shot.from);
    title.innerHTML = shot.title ? `${shot.title}${shot.sub ? `<small>${shot.sub}</small>` : ""}` : "";
    fade.classList.remove("on");
    cine.started = performance.now();
    cine.rolling = true;
    if (shot.title) setTimeout(() => { if (this.cine === cine) title.classList.add("on"); }, 900);
    setTimeout(() => { if (this.cine === cine) title.classList.remove("on"); },
               (shot.seconds - 2.5) * 1000);
  }

  /** One frame of the current shot, from the scene's preUpdate. */
  private roll = () => {
    const cine = this.cine;
    if (!cine?.rolling) return;
    const shot = cine.shots[cine.index];
    const t = Math.min((performance.now() - cine.started) / (shot.seconds * 1000), 1);
    const k = ease[shot.ease](t);
    const a = shot.from;
    const b = shot.to;
    this.pose({
      lon: a.lon + (b.lon - a.lon) * k,
      lat: a.lat + (b.lat - a.lat) * k,
      // Height on a log scale: a fall from space slows as it nears the water, as a
      // camera operator would, instead of arriving at the same speed it left orbit.
      height: Math.exp(Math.log(a.height) + (Math.log(b.height) - Math.log(a.height)) * k),
      heading: turn(a.heading, b.heading, k),
      pitch: a.pitch + (b.pitch - a.pitch) * k,
    });
    if (t >= 1) void this.cut();
  };

  private pose(p: Pose): void {
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(p.lon, p.lat, p.height),
      orientation: { heading: CesiumMath.toRadians(p.heading), pitch: CesiumMath.toRadians(p.pitch), roll: 0 },
    });
  }
}

/** The sun, checked once in development: dawn in the east, and the search finds it. */
export function demo(): void {
  const equinox = new Date(Date.UTC(2026, 2, 20));
  const t = sunrise(equinox, 88, 12);
  const { az, el } = sunAt(t, 88, 12);
  console.assert(az > 75 && az < 105, `immersive: equinox sunrise in the east (${az})`);
  console.assert(el >= 1.5 && el < 3, `immersive: just above the horizon (${el})`);
  const hour = JulianDate.toDate(t).getUTCHours();
  // 88E is UTC+5:52 solar: dawn near 00:00 UTC, either side of midnight.
  console.assert(hour === 0 || hour === 23, `immersive: dawn at 88E is near 00 UTC (${hour})`);
  for (const t of [0, 0.05, 0.1, 0.5, 0.9, 0.95, 1]) {
    const g = ease.glide(t);
    console.assert(g >= 0 && g <= 1, `immersive: glide stays in 0..1 (${t} -> ${g})`);
  }
  console.assert(Math.abs(ease.glide(1) - 1) < 1e-9 && ease.glide(0) === 0, "immersive: glide ends");
  const deep = sunAt(sunrise(equinox, 88, 12, -5), 88, 12).el;
  console.assert(deep >= -5 && deep < -4, `immersive: a crossing, not the first minute searched (${deep})`);
}
