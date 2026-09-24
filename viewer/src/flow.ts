/**
 * Animated currents: particles carried through a day's u and v, drawn as fading trails.
 *
 * Drawn on a transparent 2D canvas laid over the globe, in the manner of earth.nullschool
 * and Windy: each particle lives in longitude/latitude, is advected on the CPU through the
 * field (bilinear, m/s turned into degrees at its latitude), projected through Cesium's
 * camera each frame, and drawn as a short line from where it was to where it is. Trails
 * come from fading the canvas a little every frame rather than clearing it.
 *
 * Why not GPU particles inside the Cesium scene: that needs Cesium's private renderer
 * classes (compute commands, framebuffers), which change without deprecation; a plugin that
 * does it was tried and drew nothing in this build (docs/11-deferred.md D-36). An overlay
 * touches no engine internals, animates on its own clock so the globe can keep rendering
 * only on demand, and 10-20 thousand particles cost a few milliseconds a frame.
 *
 * The honest limit, said in the UI: this is the flow on one day at one level, animated. It
 * is not where water went; that would need the field to change in time under the particles.
 */

import { Cartesian2, Cartesian3, SceneTransforms, type Scene } from "@cesium/engine";

const EARTH_RADIUS = 6_371_000;
const DEG = Math.PI / 180;

export interface Field {
  u: Float32Array;          // m/s, (lat, lon) south row first, 0 on land
  v: Float32Array;
  nx: number;
  ny: number;
  west: number;             // cell-centre longitudes and latitudes of the first/last cells
  east: number;
  south: number;
  north: number;
  height: number;           // metres above the ellipsoid the particles are drawn at
  /** Skip particles inside this box (a cube stands there and hides the water). */
  hole?: { west: number; east: number; south: number; north: number };
}

interface Swarm {
  field: Field;
  lon: Float32Array;
  lat: Float32Array;
  age: Uint16Array;
  count: number;
}

const MAX_AGE = 110;

export class FlowOverlay {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private swarms = new Map<string, Swarm>();
  private frame?: number;
  private lastCamera = new Cartesian3();
  private lastDirection = new Cartesian3();
  private scratch = new Cartesian3();
  private screen = new Cartesian2();
  private prevScreen = new Cartesian2();
  private last = 0;
  visible = true;
  /** Visual speed: degrees moved per second per m/s of current, scaled by zoom. */
  speed = 1;

  constructor(private scene: Scene, host: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "flow-overlay";
    Object.assign(this.canvas.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none",
    });
    host.append(this.canvas);
    this.g = this.canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.canvas.clientWidth * ratio);
    this.canvas.height = Math.round(this.canvas.clientHeight * ratio);
    this.clear();
  }

  clear(): void {
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Put a field on screen under a name; replacing a name keeps no old particles. */
  set(name: string, field: Field, count: number): void {
    const swarm: Swarm = {
      field, count,
      lon: new Float32Array(count), lat: new Float32Array(count), age: new Uint16Array(count),
    };
    for (let i = 0; i < count; i += 1) this.seed(swarm, i, true);
    this.swarms.set(name, swarm);
    this.clear();
    this.start();
  }

  remove(name: string): void {
    this.swarms.delete(name);
    this.clear();
    if (!this.swarms.size) this.stop();
  }

  show(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.display = visible ? "" : "none";
    if (visible && this.swarms.size) this.start(); else this.stop();
  }

  private start(): void {
    if (this.frame === undefined && this.visible) {
      this.last = 0;
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private stop(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.clear();
  }

  /** A new particle somewhere in the field (or the visible part of it), with a random age. */
  private seed(s: Swarm, i: number, randomAge = false): void {
    const f = s.field;
    for (let tries = 0; tries < 8; tries += 1) {
      const lon = f.west + Math.random() * (f.east - f.west);
      const lat = f.south + Math.random() * (f.north - f.south);
      if (this.inHole(f, lon, lat)) continue;
      const [u, v] = sample(f, lon, lat);
      if (u === 0 && v === 0 && tries < 7) continue;  // land: try again
      s.lon[i] = lon;
      s.lat[i] = lat;
      break;
    }
    s.age[i] = randomAge ? Math.floor(Math.random() * MAX_AGE) : 0;
  }

  private inHole(f: Field, lon: number, lat: number): boolean {
    const h = f.hole;
    if (!h) return false;
    const l = lon < h.west ? lon + 360 : lon;
    return l >= h.west && l <= h.east && lat >= h.south && lat <= h.north;
  }

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / 60;
    this.last = now;
    const camera = this.scene.camera;
    // A moving camera invalidates every trail on screen: wipe instead of smearing.
    const moved = !Cartesian3.equalsEpsilon(camera.positionWC, this.lastCamera, 1) ||
      !Cartesian3.equalsEpsilon(camera.directionWC, this.lastDirection, 1e-6);
    Cartesian3.clone(camera.positionWC, this.lastCamera);
    Cartesian3.clone(camera.directionWC, this.lastDirection);
    const g = this.g;
    if (moved) {
      this.clear();
    } else {
      g.globalCompositeOperation = "destination-in";
      g.fillStyle = "rgba(0,0,0,0.93)";
      g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    g.globalCompositeOperation = "source-over";
    const ratio = this.canvas.width / Math.max(this.canvas.clientWidth, 1);
    // Degrees a particle moves per second for each m/s of current. It scales with the
    // camera's distance, so on screen a current moves at about the same pixel speed close
    // up and from space: this is a picture's speed, not the water's.
    const range = Cartesian3.magnitude(camera.positionWC) - EARTH_RADIUS;
    const degPerSecond = this.speed * 6 * Math.max(range, 30_000) / 1.0e7;
    const cam = camera.positionWC;
    const camLen = Cartesian3.magnitude(cam);
    g.lineCap = "round";
    for (const s of this.swarms.values()) {
      const f = s.field;
      g.lineWidth = 1.2 * ratio;
      // Four brightness bands by speed, one path each: a few draw calls per frame.
      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < s.count; i += 1) {
        let lon = s.lon[i];
        let lat = s.lat[i];
        const [u, v] = sample(f, lon, lat);
        const speed = Math.hypot(u, v);
        s.age[i] += 1;
        if (speed === 0 || s.age[i] > MAX_AGE || Math.random() < 0.002) {
          this.seed(s, i);
          continue;
        }
        const prevOk = this.project(lon, lat, f.height, cam, camLen, this.prevScreen);
        const cosLat = Math.max(Math.cos(lat * DEG), 0.05);
        lon += (u / cosLat) * degPerSecond * dt;
        lat += v * degPerSecond * dt;
        if (lon < f.west || lon > f.east || lat < f.south || lat > f.north ||
            this.inHole(f, lon, lat)) {
          this.seed(s, i);
          continue;
        }
        s.lon[i] = lon;
        s.lat[i] = lat;
        if (!prevOk || !this.project(lon, lat, f.height, cam, camLen, this.screen)) continue;
        const band = speed < 0.1 ? 0 : speed < 0.25 ? 1 : speed < 0.6 ? 2 : 3;
        const p = paths[band];
        p.moveTo(this.prevScreen.x * ratio, this.prevScreen.y * ratio);
        p.lineTo(this.screen.x * ratio, this.screen.y * ratio);
      }
      const colours = ["rgba(170,210,235,0.55)", "rgba(205,232,250,0.75)",
                       "rgba(235,248,255,0.9)", "rgba(255,255,255,1)"];
      paths.forEach((p, b) => {
        g.strokeStyle = colours[b];
        g.stroke(p);
      });
    }
  };

  /** Screen position of a place, or false when it is behind the planet or off screen. */
  private project(lon: number, lat: number, height: number, cam: Cartesian3, camLen: number,
                  out: Cartesian2): boolean {
    const p = Cartesian3.fromDegrees(lon, lat, height, undefined, this.scratch);
    // Behind the horizon: the angle between the point and the camera, seen from the
    // centre of the Earth, is larger than the horizon's.
    const pLen = Cartesian3.magnitude(p);
    const cosAngle = Cartesian3.dot(p, cam) / (pLen * camLen);
    if (cosAngle < EARTH_RADIUS / camLen) return false;
    const w = SceneTransforms.worldToWindowCoordinates(this.scene, p, out);
    return !!w && w.x >= 0 && w.y >= 0 && w.x <= this.canvas.clientWidth &&
      w.y <= this.canvas.clientHeight;
  }
}

/** Bilinear u, v at a place; 0, 0 outside the field or on land. */
export function sample(f: Field, lon: number, lat: number): [number, number] {
  const fx = (lon - f.west) / (f.east - f.west) * (f.nx - 1);
  const fy = (lat - f.south) / (f.north - f.south) * (f.ny - 1);
  if (fx < 0 || fy < 0 || fx > f.nx - 1 || fy > f.ny - 1) return [0, 0];
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, f.nx - 1);
  const y1 = Math.min(y0 + 1, f.ny - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (a: Float32Array, x: number, y: number) => a[y * f.nx + x];
  const bl = (a: Float32Array) =>
    (at(a, x0, y0) * (1 - tx) + at(a, x1, y0) * tx) * (1 - ty) +
    (at(a, x0, y1) * (1 - tx) + at(a, x1, y1) * tx) * ty;
  return [bl(f.u), bl(f.v)];
}

/** The sampling rule, checked once in development. */
export function demo(): void {
  const f: Field = { u: Float32Array.from([0, 2, 0, 2]), v: Float32Array.from([1, 1, 3, 3]),
                     nx: 2, ny: 2, west: 0, east: 1, south: 0, north: 1, height: 0 };
  const [u, v] = sample(f, 0.5, 0.5);
  console.assert(u === 1 && v === 2, "flow: bilinear at the centre of four cells");
  console.assert(sample(f, 2, 0)[0] === 0, "flow: outside the field there is no current");
}
