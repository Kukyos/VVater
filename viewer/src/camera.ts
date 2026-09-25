/**
 * The two cameras we drive ourselves: an orbit camera for the Region view and a
 * constant-height flight camera. Globe and Map keep Cesium's own controller.
 *
 * Why not Cesium's controller in the Region view: its zoom speed scales with the distance
 * to whatever the cursor picks. With a translucent sea surface and collision detection
 * off (both needed to see into the water column) that pick is unreliable, so a little
 * zoom-out left the camera so far away that zooming back in barely moved it, and a
 * left-drag spun the whole planet rather than moving across the Bay. A 3D package's orbit
 * camera -- a target on the sea surface, a heading, a pitch and a distance, each clamped --
 * cannot get lost.
 */

import { Cartesian3, Cartographic, HeadingPitchRange, Math as CesiumMath, Matrix4 } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Keys that are "held" controls, tracked for both cameras. */
const held = new Set<string>();
const typingInto = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.matches("input, textarea, select, [contenteditable], [contenteditable] *");
window.addEventListener("keydown", (e) => {
  if (!typingInto(e.target)) held.add(e.key.toLowerCase());
});
window.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => held.clear());

export { typingInto };

// ------------------------------------------------------------------ orbit

export interface Bounds { lon: [number, number]; lat: [number, number] }

export interface OrbitPose { lon: number; lat: number; heading: number; pitch: number; range: number }

export class OrbitCamera {
  pose: OrbitPose;
  private active = false;
  private drag?: { x: number; y: number; mode: "orbit" | "pan" };
  private frame?: number;
  private last = 0;
  private readonly margin = 6; // degrees the target may leave the box by

  // Range limits: close enough to read a single 1-degree cell, far enough to see the
  // whole Bay with the land around it, and no further -- there is nothing out there.
  static readonly MIN_RANGE = 90_000;
  static readonly MAX_RANGE = 3_600_000;

  private minRange = OrbitCamera.MIN_RANGE;
  private maxRange = OrbitCamera.MAX_RANGE;
  /** Height of the point the camera orbits: 0 is the sea surface; a raised cube is aimed
   * at its middle, so orbiting turns it about its own centre rather than its base. */
  private targetHeight = 0;

  constructor(private viewer: Viewer, private bounds: Bounds,
              private home: OrbitPose, private onMove: () => void) {
    this.pose = { ...home };
  }

  /**
   * Aim at something else: a new box, home pose and range limits. The limits scale with
   * the box, because a 100-degree cube cannot be seen whole from the Bay's 3,600 km.
   */
  retarget(bounds: Bounds, home: OrbitPose,
           opts: { minRange?: number; maxRange?: number; targetHeight?: number } = {}): void {
    this.bounds = bounds;
    this.home = { ...home };
    this.minRange = opts.minRange ?? OrbitCamera.MIN_RANGE;
    this.maxRange = opts.maxRange ?? OrbitCamera.MAX_RANGE;
    this.targetHeight = opts.targetHeight ?? 0;
    this.pose = { ...home };
    if (this.active) this.apply();
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    const canvas = this.viewer.canvas;
    canvas.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("contextmenu", this.noMenu);
    this.apply();
    this.tick();
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    const canvas = this.viewer.canvas;
    canvas.removeEventListener("pointerdown", this.down);
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerup", this.up);
    canvas.removeEventListener("wheel", this.wheel);
    canvas.removeEventListener("contextmenu", this.noMenu);
    if (this.frame) cancelAnimationFrame(this.frame);
    // lookAt leaves a reference frame on the camera; the default controller misbehaves
    // in Globe and Map until it is cleared.
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
  }

  reset(): void {
    this.pose = { ...this.home };
    this.apply();
  }

  /** Aim at a place without changing the viewing angle. */
  lookAt(lon: number, lat: number, range?: number): void {
    this.pose.lon = lon;
    this.pose.lat = lat;
    if (range) this.pose.range = range;
    this.apply();
  }

  apply(): void {
    const p = this.pose;
    const { lon, lat } = this.bounds;
    p.lon = Math.min(Math.max(p.lon, lon[0] - this.margin), lon[1] + this.margin);
    p.lat = Math.min(Math.max(p.lat, lat[0] - this.margin), lat[1] + this.margin);
    p.range = Math.min(Math.max(p.range, this.minRange), this.maxRange);
    // Down to straight overhead; up to 12 degrees below the target, which puts the camera
    // inside the water column looking up through it.
    p.pitch = Math.min(Math.max(p.pitch, -89.5 * DEG), 12 * DEG);
    this.viewer.camera.lookAt(Cartesian3.fromDegrees(p.lon, p.lat, this.targetHeight),
      new HeadingPitchRange(p.heading, p.pitch, p.range));
    this.onMove();
  }

  /** Move the target in the camera's own frame: forward is where the camera faces. */
  private pan(forwardM: number, rightM: number): void {
    const h = this.pose.heading;
    const east = forwardM * Math.sin(h) + rightM * Math.cos(h);
    const north = forwardM * Math.cos(h) - rightM * Math.sin(h);
    this.pose.lat += north / 111_320;
    this.pose.lon += east / (111_320 * Math.cos(this.pose.lat * DEG));
  }

  private down = (e: PointerEvent) => {
    const pan = e.button === 1 || e.button === 2 || e.shiftKey;
    this.drag = { x: e.clientX, y: e.clientY, mode: pan ? "pan" : "orbit" };
  };

  private move = (e: PointerEvent) => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    if (this.drag.mode === "orbit") {
      this.pose.heading += dx * 0.005;
      this.pose.pitch -= dy * 0.004;
    } else {
      const perPixel = this.pose.range / this.viewer.canvas.clientHeight;
      this.pan(dy * perPixel, -dx * perPixel);
    }
    this.apply();
  };

  private up = () => { this.drag = undefined; };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.pose.range *= Math.pow(1.0015, e.deltaY);
    this.apply();
  };

  private noMenu = (e: Event) => e.preventDefault();

  /** Held keys: WASD pan, Q/E turn, R/F or +/- zoom, arrows tilt. Speed follows range. */
  private tick = () => {
    if (!this.active) return;
    const now = performance.now();
    const dt = Math.min((now - (this.last || now)) / 1000, 0.1);
    this.last = now;
    if (held.size) {
      const step = this.pose.range * 0.9 * dt;
      let moved = false;
      const k = (key: string) => held.has(key);
      if (k("w")) { this.pan(step, 0); moved = true; }
      if (k("s")) { this.pan(-step, 0); moved = true; }
      if (k("a")) { this.pan(0, -step); moved = true; }
      if (k("d")) { this.pan(0, step); moved = true; }
      if (k("q")) { this.pose.heading -= 1.2 * dt; moved = true; }
      if (k("e")) { this.pose.heading += 1.2 * dt; moved = true; }
      if (k("r") || k("+") || k("=")) { this.pose.range *= Math.pow(0.35, dt); moved = true; }
      if (k("f") || k("-")) { this.pose.range *= Math.pow(1 / 0.35, dt); moved = true; }
      if (k("arrowup")) { this.pose.pitch -= 0.9 * dt; moved = true; }
      if (k("arrowdown")) { this.pose.pitch += 0.9 * dt; moved = true; }
      if (moved) this.apply();
    }
    this.frame = requestAnimationFrame(this.tick);
  };
}

// ------------------------------------------------------------------ flight

/**
 * One great-circle step: from (lat, lon) along `bearing` for `distance` metres. Returns
 * the new position and the bearing on arrival, which differs from the start bearing
 * everywhere except along a meridian or the equator. Degrees in, degrees out.
 */
export function greatCircleStep(lat: number, lon: number, bearing: number, distance: number):
    { lat: number; lon: number; bearing: number } {
  const d = distance / EARTH_RADIUS_M;
  const p1 = lat * DEG;
  const l1 = lon * DEG;
  const b = bearing * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1),
    Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  // Final bearing: the reverse initial bearing from the destination, turned around.
  const y = Math.sin(l1 - l2) * Math.cos(p1);
  const x = Math.cos(p2) * Math.sin(p1) - Math.sin(p2) * Math.cos(p1) * Math.cos(l1 - l2);
  const back = Math.atan2(y, x) / DEG;
  return {
    lat: p2 / DEG,
    lon: ((l2 / DEG + 540) % 360) - 180,
    bearing: (back + 180 + 360) % 360,
  };
}

export interface FlightState {
  lat: number; lon: number; heading: number; // degrees
  height: number; // metres above the ellipsoid; changes by itself only to clear terrain
  speed: number; // m/s over the ground
  look: number; // camera pitch, degrees (negative = down)
}

/**
 * A plane that stays at its altitude. Altitude only changes on R/F, and between fixed
 * limits, so nobody can climb out into space or dive into the volume by accident.
 * Speeds are not an aircraft's: the Bay is 2,400 km across, and a demo has a minute.
 */
export class FlightCamera {
  state: FlightState;
  private active = false;
  private drag?: { x: number; y: number };
  private last = 0;
  paused = false;

  // Low enough to fly between the Eastern Ghats' ridges; the terrain clearance below keeps
  // the floor above the ground, since height is ellipsoidal and collision detection is off.
  static readonly MIN_HEIGHT = 1_500;
  static readonly MAX_HEIGHT = 250_000;
  static readonly CLEARANCE = 600;
  static readonly MIN_SPEED = 500;
  static readonly MAX_SPEED = 120_000;

  constructor(private viewer: Viewer, private start: FlightState,
              private onFrame: (s: FlightState) => void) {
    this.state = { ...start };
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.state = { ...this.start };
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.canvas.addEventListener("pointerdown", this.down);
    window.addEventListener("pointermove", this.move);
    window.addEventListener("pointerup", this.up);
    this.last = 0;
    // The pose is set inside Cesium's own tick, just before it renders, so the globe and
    // the particles drawn after it see the same camera (as the cinematic does).
    this.viewer.scene.preUpdate.addEventListener(this.tick);
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.viewer.scene.preUpdate.removeEventListener(this.tick);
    this.viewer.canvas.removeEventListener("pointerdown", this.down);
    window.removeEventListener("pointermove", this.move);
    window.removeEventListener("pointerup", this.up);
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
  }

  private down = (e: PointerEvent) => { this.drag = { x: e.clientX, y: e.clientY }; };
  private up = () => { this.drag = undefined; };
  private move = (e: PointerEvent) => {
    if (!this.drag) return;
    this.state.heading += (e.clientX - this.drag.x) * 0.15;
    this.state.look -= (e.clientY - this.drag.y) * 0.12;
    this.drag = { x: e.clientX, y: e.clientY };
  };

  private tick = () => {
    if (!this.active) return;
    const now = performance.now();
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    const s = this.state;
    const k = (key: string) => held.has(key);
    if (k("w")) s.speed *= Math.pow(2.2, dt);
    if (k("s")) s.speed /= Math.pow(2.2, dt);
    if (k("a") || k("arrowleft")) s.heading -= 45 * dt;
    if (k("d") || k("arrowright")) s.heading += 45 * dt;
    if (k("arrowup")) s.look += 30 * dt;
    if (k("arrowdown")) s.look -= 30 * dt;
    if (k("r")) s.height *= Math.pow(1.8, dt);
    if (k("f")) s.height /= Math.pow(1.8, dt);
    s.speed = Math.min(Math.max(s.speed, FlightCamera.MIN_SPEED), FlightCamera.MAX_SPEED);
    s.look = Math.min(Math.max(s.look, -89), 10);
    if (!this.paused && dt > 0) {
      const next = greatCircleStep(s.lat, s.lon, s.heading, s.speed * dt);
      s.lat = next.lat;
      s.lon = next.lon;
      s.heading = next.bearing;
    }
    // Undefined until the tile under the camera has loaded; the floor alone holds till then.
    const ground = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(s.lon, s.lat)) ?? 0;
    s.height = Math.min(Math.max(s.height, FlightCamera.MIN_HEIGHT, ground + FlightCamera.CLEARANCE),
      FlightCamera.MAX_HEIGHT);
    s.heading = ((s.heading % 360) + 360) % 360;
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(s.lon, s.lat, s.height),
      orientation: {
        heading: CesiumMath.toRadians(s.heading),
        pitch: CesiumMath.toRadians(s.look),
        roll: 0,
      },
    });
    this.onFrame(s);
  };
}

/** The great-circle step, checked once in development. */
export function demo(): void {
  const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
  const quarter = (Math.PI / 2) * EARTH_RADIUS_M;
  const east = greatCircleStep(0, 0, 90, quarter);
  console.assert(close(east.lat, 0) && close(east.lon, 90) && close(east.bearing, 90),
    "flight: a quarter circle east along the equator lands on 0N 90E, still heading east");
  const north = greatCircleStep(10, 80, 0, 111_195);
  console.assert(close(north.lat, 11, 1e-3) && close(north.lon, 80), "flight: 1 degree north");
  // Heading east from 20N, a great circle bends south: the arrival bearing exceeds 90.
  console.assert(greatCircleStep(20, 85, 90, 1_000_000).bearing > 90,
    "flight: eastward great circle from 20N must curve south");
  const wrap = greatCircleStep(0, 179, 90, 2 * 111_195);
  console.assert(close(wrap.lon, -179, 1e-3), "flight: longitude wraps at the date line");
}
