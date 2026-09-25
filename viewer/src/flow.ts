/**
 * Animated currents: particles carried through a day's u and v, drawn as fading trails.
 *
 * Drawn on a transparent 2D canvas laid over the globe, in the manner of earth.nullschool
 * and Windy: each particle lives in longitude/latitude, is advected on the CPU through the
 * field (bilinear, m/s turned into degrees at its latitude), projected through Cesium's
 * camera each frame, and drawn as a short line from where it was to where it is. Trails
 * come from fading the canvas a little every frame rather than clearing it. While a hand
 * moves the camera the particles are paused and hidden (`pauseOnMove`), so the globe has
 * the whole frame; in the cinematic, where the camera never rests, the canvas is wiped
 * each frame instead and every trail is redrawn from the last few positions its particle
 * held.
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

import {
  Cartesian2, Cartesian3, Ellipsoid, Math as CesiumMath, Matrix4, Rectangle, SceneMode,
  SceneTransforms, type Scene,
} from "@cesium/engine";

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
  /** Look and pace; the default is the ocean currents' white. */
  style?: FlowStyle;
}

export interface FlowStyle {
  /** Speeds (field units) splitting the four brightness bands. */
  bands: [number, number, number];
  colours: [string, string, string, string];
  /** Multiplies the picture speed: 10 m/s of wind must not race across the screen. */
  pace: number;
}

const CURRENTS: FlowStyle = {
  bands: [0.1, 0.25, 0.6],
  colours: ["rgba(170,210,235,0.55)", "rgba(205,232,250,0.75)",
            "rgba(235,248,255,0.9)", "rgba(255,255,255,1)"],
  pace: 1,
};

/** Positions kept per particle for the trail drawn while the camera moves ... */
const HISTORY = 8;
/** ... one every this many frames: 8 x 4 frames is about the half second a still trail
 * takes to fade, so a moving trail is as long as a still one. */
const HISTORY_EVERY = 4;
/** Pixels past the screen edge a point may sit and still anchor a trail into view. */
const EDGE_PX = 40;
/** Stillness before paused particles come back: long enough that inertia and a hand
 * resting mid-drag do not flicker them on and off. */
const RESUME_MS = 200;

interface Swarm {
  field: Field;
  lon: Float32Array;
  lat: Float32Array;
  age: Uint16Array;
  count: number;
  /** Earth-fixed x, y, z of each particle's last HISTORY_EVERY-th positions, a ring. */
  hist: Float64Array;
  /** How many ring entries are valid for a particle; 0 after it is reborn. */
  histN: Uint8Array;
  /** Earth-fixed position last frame, and whether it is set (not on a particle's first). */
  last: Float64Array;
  lastOk: Uint8Array;
  frame: number;
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
  /** Draw through the holes (immersive view hides the cube that made them). */
  ignoreHoles = false;
  /** The part of the globe on screen, in degrees; particles are born here. */
  private view?: { west: number; east: number; south: number; north: number };
  private viewRect = new Rectangle();
  /** Camera range at the last full reseed; a big zoom since then reseeds everything. */
  private seededRange = 0;
  /** This frame's view-projection, and whether the matrix path applies (3D only). */
  private vp = new Matrix4();
  private direct = false;
  private cam = new Cartesian3();
  private camLen = 1;
  private checked = false;
  /** The canvas's CSS size, kept from resize(): reading clientWidth per projected point
   * was a DOM call hundreds of thousands of times a frame, most of the overlay's JS time. */
  private cssW = 1;
  private cssH = 1;
  /** Visual speed: degrees moved per second per m/s of current, scaled by zoom. */
  speed = 1;
  /**
   * Hide the particles while the camera moves and bring them back once it rests. A moving
   * camera is the overlay's most expensive frame (every trail re-projected and redrawn),
   * and it is exactly when the globe needs the frame budget to stay smooth.
   */
  pauseOnMove = true;
  private paused = false;
  private movedAt = 0;
  /** Drawn from the scene's postRender rather than its own clock (see follow()). */
  private following = false;

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
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.cssW * ratio);
    this.canvas.height = Math.round(this.cssH * ratio);
    this.clear();
  }

  clear(): void {
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Put a field on screen under a name; replacing a name keeps no old particles. */
  set(name: string, field: Field, count: number): void {
    const swarm: Swarm = {
      field, count, frame: 0,
      lon: new Float32Array(count), lat: new Float32Array(count), age: new Uint16Array(count),
      hist: new Float64Array(count * HISTORY * 3), histN: new Uint8Array(count),
      last: new Float64Array(count * 3), lastOk: new Uint8Array(count),
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

  /**
   * A new particle in the part of the field on screen, with a random age. Seeding the whole
   * globe put almost none of 12,000 particles in view once the camera came down low, so a
   * flight or a close-up showed empty water.
   */
  private seed(s: Swarm, i: number, randomAge = false): void {
    const f = s.field;
    const v = this.view;
    const west = v ? Math.max(f.west, v.west) : f.west;
    const east = v ? Math.min(f.east, v.east) : f.east;
    const south = v ? Math.max(f.south, v.south) : f.south;
    const north = v ? Math.min(f.north, v.north) : f.north;
    // The field is off screen: seed it anywhere, it costs nothing to draw.
    const onScreen = east > west && north > south;
    for (let tries = 0; tries < 8; tries += 1) {
      const lon = onScreen ? west + Math.random() * (east - west)
        : f.west + Math.random() * (f.east - f.west);
      const lat = onScreen ? south + Math.random() * (north - south)
        : f.south + Math.random() * (f.north - f.south);
      if (this.inHole(f, lon, lat)) continue;
      const [u, v] = sample(f, lon, lat);
      if (u === 0 && v === 0 && tries < 7) continue;  // land: try again
      s.lon[i] = lon;
      s.lat[i] = lat;
      break;
    }
    s.age[i] = randomAge ? Math.floor(Math.random() * MAX_AGE) : 0;
    s.histN[i] = 0;  // a reborn particle has no trail yet
    s.lastOk[i] = 0;
  }

  private inHole(f: Field, lon: number, lat: number): boolean {
    const h = f.hole;
    if (!h || this.ignoreHoles) return false;
    const l = lon < h.west ? lon + 360 : lon;
    return l >= h.west && l <= h.east && lat >= h.south && lat <= h.north;
  }

  /**
   * Draw each frame from the scene's own postRender instead of this overlay's clock. For a
   * camera that never stops (the cinematic): two animation-frame loops run in no fixed
   * order, so the overlay could project this frame's camera over a globe still showing
   * the last one, and the particles shivered against the water. It also exempts the
   * overlay from pauseOnMove, which would otherwise blank it for the whole film.
   */
  follow(on: boolean): void {
    if (on === this.following) return;
    this.following = on;
    if (on) this.scene.postRender.addEventListener(this.onRender);
    else this.scene.postRender.removeEventListener(this.onRender);
    this.last = 0;
  }

  private onRender = () => {
    if (this.frame !== undefined) this.draw(performance.now());
  };

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.following) this.draw(now);
  };

  /** Back from a pause: the view is new and the old trails are gone. */
  private resume(r: number): void {
    this.paused = false;
    this.last = 0;
    this.updateView();
    // The canvas is blank already, so a big zoom can reseed everything at once here.
    const all = r > this.seededRange * 3 || r < this.seededRange / 3;
    if (all) this.seededRange = r;
    for (const s of this.swarms.values()) {
      if (all) for (let i = 0; i < s.count; i += 1) this.seed(s, i, true);
      s.lastOk.fill(0);
      s.histN.fill(0);
    }
  }

  private draw(now: number): void {
    const camera = this.scene.camera;
    // A moving camera invalidates every trail on screen: wipe instead of smearing. The
    // epsilons are absolute (1 m, 1e-6): a relative 1 counted any zoom as "not moved", and
    // the trails smeared across the globe as white after-images.
    const moved = !Cartesian3.equalsEpsilon(camera.positionWC, this.lastCamera, 0, 1) ||
      !Cartesian3.equalsEpsilon(camera.directionWC, this.lastDirection, 0, 1e-6);
    const r = Cartesian3.magnitude(camera.positionWC) - EARTH_RADIUS;
    if (moved) this.movedAt = now;
    Cartesian3.clone(camera.positionWC, this.lastCamera);
    Cartesian3.clone(camera.directionWC, this.lastDirection);
    if (this.pauseOnMove && !this.following && now - this.movedAt < RESUME_MS) {
      // Moving: nothing advected, nothing drawn, until the camera rests.
      if (!this.paused) {
        this.paused = true;
        this.clear();
      }
      return;
    }
    if (this.paused) this.resume(r);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / 60;
    this.last = now;
    if (moved || !this.view) this.updateView();
    // After a zoom by a factor of three, the particles are still packed where the old view
    // was (a clump of white from space after a low pass); move a third of them into the
    // new one each time. Reseeding all of them at once wiped every trail, and a fast climb
    // crosses a factor of three every few frames: the screen went blank.
    if (this.view && (r > this.seededRange * 3 || r < this.seededRange / 3)) {
      this.seededRange = r;
      for (const s of this.swarms.values()) {
        for (let i = 0; i < s.count; i += 1) if (Math.random() < 1 / 3) this.seed(s, i, true);
      }
    }
    this.beginFrame();
    const g = this.g;
    if (moved) {
      this.clear();
    } else {
      g.globalCompositeOperation = "destination-in";
      g.fillStyle = "rgba(0,0,0,0.93)";
      g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    g.globalCompositeOperation = "source-over";
    const ratio = this.canvas.width / Math.max(this.cssW, 1);
    // Degrees a particle moves per second for each m/s of current, per metre of distance
    // from the camera: on screen a current moves at about the same pixel speed near and
    // far, close up and from space. This is a picture's speed, not the water's. It is each
    // particle's own distance, not the camera's height: looking along the horizon from
    // 60 km up, the water is hundreds of km away and paced by height it barely moved.
    const perMetre = this.speed * 6 / 1.0e7;
    const c = this.cam;
    const p = this.scratch;
    // Butt caps and bevel joins: stroking is the overlay's whole cost (projection is a
    // rounding error beside it), and round caps and joins about doubled the stroke time
    // of one-segment trails. At a 1.2 px line the difference is not visible.
    g.lineCap = "butt";
    g.lineJoin = "bevel";
    for (const s of this.swarms.values()) {
      const f = s.field;
      const style = f.style ?? CURRENTS;
      const pace = perMetre * style.pace;
      const [b0, b1, b2] = style.bands;
      const record = s.frame % HISTORY_EVERY === 0;
      const slot = Math.floor(s.frame / HISTORY_EVERY) % HISTORY;
      // The newest entry already written: this frame's slot is written after drawing.
      const newest = record ? slot - 1 : slot;
      s.frame += 1;
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
        const cosLat = Math.max(Math.cos(lat * DEG), 0.05);
        const L = i * 3;
        const far = s.lastOk[i]
          ? Math.hypot(s.last[L] - c.x, s.last[L + 1] - c.y, s.last[L + 2] - c.z) : r;
        const step = pace * Math.max(far, 30_000);
        lon += (u / cosLat) * step * dt;
        lat += v * step * dt;
        if (lon < f.west || lon > f.east || lat < f.south || lat > f.north ||
            this.inHole(f, lon, lat)) {
          this.seed(s, i);
          continue;
        }
        s.lon[i] = lon;
        s.lat[i] = lat;
        Cartesian3.fromDegrees(lon, lat, f.height, undefined, p);
        if (!this.toScreen(p.x, p.y, p.z, this.screen, 0)) {
          // Off screen or behind the planet: reborn where it can be seen.
          if (this.view) this.seed(s, i, true);
          continue;
        }
        const band = speed < b0 ? 0 : speed < b1 ? 1 : speed < b2 ? 2 : 3;
        const path = paths[band];
        const n = s.histN[i];
        if (moved) {
          // Moving: the canvas was wiped, so redraw the whole trail from the positions this
          // particle has been at. Straight streaks along today's flow looked like needles.
          let open = false;
          // ponytail: the cinematic redraws every trail every frame and stroke time goes
          // with segment count, so it takes every other stored point: half the segments,
          // the same trail length.
          const stride = this.following ? 2 : 1;
          for (let k = n - 1 - Math.max(n - 1, 0) % stride; k >= 0; k -= stride) {
            const h = (i * HISTORY + (newest - k + HISTORY * 2) % HISTORY) * 3;
            if (this.toScreen(s.hist[h], s.hist[h + 1], s.hist[h + 2], this.prevScreen, EDGE_PX)) {
              if (open) path.lineTo(this.prevScreen.x * ratio, this.prevScreen.y * ratio);
              else path.moveTo(this.prevScreen.x * ratio, this.prevScreen.y * ratio);
              open = true;
            } else {
              open = false;
            }
          }
          if (s.lastOk[i] && this.toScreen(s.last[L], s.last[L + 1], s.last[L + 2], this.prevScreen, EDGE_PX)) {
            if (open) path.lineTo(this.prevScreen.x * ratio, this.prevScreen.y * ratio);
            else path.moveTo(this.prevScreen.x * ratio, this.prevScreen.y * ratio);
            open = true;
          }
          if (open) path.lineTo(this.screen.x * ratio, this.screen.y * ratio);
        } else if (s.lastOk[i] &&
                   this.toScreen(s.last[L], s.last[L + 1], s.last[L + 2], this.prevScreen, EDGE_PX)) {
          // Still: one segment a frame; the fading canvas builds the trail.
          path.moveTo(this.prevScreen.x * ratio, this.prevScreen.y * ratio);
          path.lineTo(this.screen.x * ratio, this.screen.y * ratio);
        }
        s.last[L] = p.x;
        s.last[L + 1] = p.y;
        s.last[L + 2] = p.z;
        s.lastOk[i] = 1;
        if (record) {
          const h = (i * HISTORY + slot) * 3;
          s.hist[h] = p.x;
          s.hist[h + 1] = p.y;
          s.hist[h + 2] = p.z;
          s.histN[i] = Math.min(n + 1, HISTORY);
        }
      }
      paths.forEach((path, b) => {
        g.strokeStyle = style.colours[b];
        g.stroke(path);
      });
    }
  }

  /**
   * The globe's part of the screen, in degrees. Undefined when it wraps the date line or
   * the camera sees no globe; particles are then born anywhere in their field.
   */
  private updateView(): void {
    const r = this.scene.camera.computeViewRectangle(Ellipsoid.WGS84, this.viewRect);
    if (!r || r.east <= r.west) {
      this.view = undefined;
      return;
    }
    // Padded: Cesium samples the screen's edges for this box, and looking along the
    // horizon it came back short, cutting the particles off along a line.
    const d = CesiumMath.toDegrees;
    const padX = Math.max(d(r.east - r.west) * 0.25, 1);
    const padY = Math.max(d(r.north - r.south) * 0.25, 1);
    this.view = { west: d(r.west) - padX, east: d(r.east) + padX,
                  south: d(r.south) - padY, north: d(r.north) + padY };
  }

  /**
   * This frame's projection. In 3D a point is projected with the camera's own matrices,
   * a few multiplications; Cesium's per-point helper cost too much for a trail of eight
   * points on every particle. The 2D map projects the globe differently, so it keeps the
   * helper (and short trails are fine there: the map does not fly).
   */
  private beginFrame(): void {
    const camera = this.scene.camera;
    this.direct = this.scene.mode === SceneMode.SCENE3D;
    if (this.direct) {
      Matrix4.multiply(camera.frustum.projectionMatrix, camera.viewMatrix, this.vp);
    }
    Cartesian3.clone(camera.positionWC, this.cam);
    this.camLen = Cartesian3.magnitude(this.cam);
    if (this.direct && !this.checked && import.meta.env.DEV) {
      // Once, in development: the matrix path must land where Cesium's helper does.
      this.checked = true;
      const probe = Cartesian3.add(camera.positionWC,
        Cartesian3.multiplyByScalar(camera.directionWC, 1000, new Cartesian3()), new Cartesian3());
      const mine = new Cartesian2();
      const theirs = SceneTransforms.worldToWindowCoordinates(this.scene, probe);
      if (theirs && this.project(probe.x, probe.y, probe.z, mine)) {
        console.assert(Math.hypot(mine.x - theirs.x, mine.y - theirs.y) < 1.5,
          `flow: matrix projection off by ${mine.x - theirs.x}, ${mine.y - theirs.y} px`);
      }
    }
  }

  /** Window position of an Earth-fixed point, or false when behind the planet or off screen. */
  private toScreen(x: number, y: number, z: number, out: Cartesian2, edge: number): boolean {
    // Behind the horizon: the angle between the point and the camera, seen from the
    // centre of the Earth, is larger than the horizon's.
    const c = this.cam;
    const pLen = Math.sqrt(x * x + y * y + z * z);
    if ((x * c.x + y * c.y + z * c.z) / (pLen * this.camLen) < EARTH_RADIUS / this.camLen) return false;
    if (!this.project(x, y, z, out)) return false;
    const w = this.cssW;
    const h = this.cssH;
    return out.x >= -edge && out.y >= -edge && out.x <= w + edge && out.y <= h + edge;
  }

  private project(x: number, y: number, z: number, out: Cartesian2): boolean {
    if (!this.direct) {
      const w = SceneTransforms.worldToWindowCoordinates(this.scene, new Cartesian3(x, y, z), out);
      return !!w;
    }
    const m = this.vp;  // column-major
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0) return false;  // behind the camera
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    out.x = (cx / cw + 1) * 0.5 * this.cssW;
    out.y = (1 - cy / cw) * 0.5 * this.cssH;
    return true;
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
