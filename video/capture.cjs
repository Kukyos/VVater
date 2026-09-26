// Film clips from the running viewer (API on :8011, `npm run dev` on :5173).
//
//   node capture.cjs              every clip
//   node capture.cjs orbit float  just these
//
// Frame-stepped, not screen-recorded. The page's clock is virtual: performance.now and
// requestAnimationFrame are replaced before any script loads, and once a clip starts,
// time only moves when this script advances it by exactly one frame. So a frame that
// takes 400 ms to draw still lands 1/30 s after the one before it, and the currents move
// at their real speed in the film no matter how slow the GPU is. Data is fetched and
// settled on the real clock before a clip starts; nothing loads during a move.
//
// Frames are piped straight into ffmpeg: public/clips/<name>.mp4, 1920x1080, 30 fps.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.VIEWER || "http://localhost:5173/";
const OUT = path.join(__dirname, "public", "clips");
const FPS = 30, W = 1920, H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the page

async function settle(page, quiet = 2500, max = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const idle = await page.evaluate((q) => window.__film.realNow() - (window.__lastNet || 0) > q
      && (window.__inflight || 0) === 0, quiet);
    if (idle) break;
    await sleep(300);
  }
  await sleep(1500);
}

async function open(browser, query, { learn = "declined", docks = { left: false, right: false } } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((learn, docks) => {
    // Every frame drawn, at one fixed resolution, currents kept while the camera moves.
    localStorage.setItem("vvater.graphics.v2", JSON.stringify({
      tier: "high", auto: false,
      quality: { msaa: 4, fxaa: false, resolution: 1, sky: true, onDemand: false, showFps: false, pauseOnMove: false } }));
    if (learn) localStorage.setItem("vvater.learn", JSON.stringify({ seen: true, done: [] }));
    for (const [side, open] of Object.entries(docks))
      localStorage.setItem(`vvater.dock.${side}`, open ? "open" : "closed");

    // The virtual clock. Real until start(), then it moves only in step().
    const realNow = performance.now.bind(performance);
    const realRaf = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    let virtual = false, vt = 0, next = 1e9;
    const queue = new Map();
    performance.now = () => (virtual ? vt : realNow());
    window.requestAnimationFrame = (cb) => {
      if (!virtual) return realRaf(cb);
      const id = ++next; queue.set(id, cb); return id;
    };
    window.cancelAnimationFrame = (id) => { queue.delete(id); realCancel(id); };
    window.__film = {
      realNow,
      start() { if (!virtual) { vt = realNow(); virtual = true; } },
      stop() { virtual = false; const cbs = [...queue.values()]; queue.clear(); cbs.forEach((cb) => realRaf(cb)); },
      step(ms) {
        vt += ms;
        const cbs = [...queue.values()]; queue.clear();
        for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } }
      },
    };

    const f = window.fetch;
    window.__inflight = 0;
    window.fetch = async (...a) => {
      window.__inflight++; window.__lastNet = realNow();
      try { return await f(...a); } finally { window.__inflight--; window.__lastNet = realNow(); }
    };
  }, learn, docks);
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  await page.goto(BASE + (query ? "?" + query : ""), { waitUntil: "load" });
  await page.waitForFunction(() => window.vvater, { timeout: 60000 });
  await settle(page);
  return page;
}

const set = (page, id, value) => page.evaluate((id, value) => {
  const e = document.getElementById(id);
  if (e.type === "checkbox") { if (e.checked !== value) e.click(); return; }
  e.value = String(value);
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
}, id, value);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const js = (page, fn, ...a) => page.evaluate(fn, ...a);

// ------------------------------------------------------------------ recording

const ease = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  glide: (t) => 1 - Math.pow(1 - t, 3),
};

// The orbit camera's pose, read once so a move can be written relative to it.
const getPose = (page) => js(page, () => ({ ...window.vvater.orbit.pose }));

// A move: for each frame, `frame(t)` runs in the page with t in 0..1 (eased), then the
// clock advances one frame and the page is photographed.
// `rebuild`: renders to give each frame, with the clock held, before it is photographed. A cut
// rebuilds the cube's faces, and new primitives and textures take a few renders to appear;
// moved every frame, they would never be drawn at all (the block renders white). A number,
// or a function of the frame for a clip where only some frames move something.
// `skip`: seconds to run the clock forward, rendering but not photographing, before the clip
// starts (to begin partway through something that moves by itself, like the cinematic).
// `drive(i)`: runs in Node before frame i, for the mouse and keyboard. Anything it starts that
// waits on the network (a cube loading, the assistant answering) runs on the real clock
// between frames, so a wait is shorter in the film than it was.
async function record(page, name, seconds, frame, { easing = "inOut", arg, rebuild = 0, skip = 0, drive } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.mp4`);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS),
    "-i", "-", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p", file],
    { stdio: ["pipe", "inherit", "inherit"] });
  const n = Math.round(seconds * FPS);
  const fnSrc = frame.toString();
  await js(page, () => window.__film.start());
  // A few frames with nothing moving, so the first captured frame is a settled one.
  for (let i = 0; i < 3 + Math.round(skip * FPS); i++) await js(page, (ms) => window.__film.step(ms), 1000 / FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const t = ease[easing](n === 1 ? 1 : i / (n - 1));
    if (drive) await drive(i);
    await page.evaluate(`(${fnSrc})(${t}, ${JSON.stringify(arg ?? null)}); window.__film.step(${1000 / FPS});`);
    const passes = typeof rebuild === "function" ? rebuild(i) : rebuild;
    for (let k = 0; k < passes; k++) { await sleep(20); await js(page, () => window.__film.step(0)); }
    const png = await page.screenshot({ type: "png", optimizeForSpeed: true });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  await js(page, () => window.__film.stop());
  console.log(`  wrote ${path.relative(process.cwd(), file)}  ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// Orbit-camera move from pose `a` to pose `b` (any subset of lon, lat, heading, pitch,
// range; degrees and metres). Missing fields hold.
function orbitMove(t, { a, b }) {
  const o = window.vvater.orbit, p = o.pose, D = Math.PI / 180;
  const lerp = (k) => (a[k] === undefined ? undefined : a[k] + (b[k] - a[k]) * t);
  for (const k of ["heading", "pitch"]) if (lerp(k) !== undefined) p[k] = lerp(k) * D;
  for (const k of ["lon", "lat"]) if (lerp(k) !== undefined) p[k] = lerp(k);
  // Range geometrically, so a zoom reads as a constant speed.
  if (a.range !== undefined) p.range = a.range * Math.pow(b.range / a.range, t);
  o.apply();
}
const hold = () => {};

// Headless Chrome draws no pointer, so the film's is a DOM arrow that follows the real mouse
// events the page receives; a press shows as a ring.
const showCursor = (page) => js(page, () => {
  const c = document.createElement("div");
  c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2 3.8 7.3-2.7 1.4-3.8-7.3L4 20z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "-50px", top: "-50px", zIndex: 99999, pointerEvents: "none",
    filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))", transform: "translate(-4px,-2px)" });
  const ring = document.createElement("div");
  Object.assign(ring.style, { position: "fixed", width: "34px", height: "34px", marginLeft: "-17px", marginTop: "-17px",
    border: "2px solid #38bdf8", borderRadius: "50%", zIndex: 99998, pointerEvents: "none", opacity: 0 });
  document.body.append(ring, c);
  const at = (e) => {
    c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`;
    ring.style.left = c.style.left; ring.style.top = c.style.top;
  };
  addEventListener("pointermove", at, true);
  addEventListener("pointerdown", (e) => { at(e); ring.style.opacity = 1; }, true);
  addEventListener("pointerup", () => { ring.style.opacity = 0; }, true);
});

// Where a longitude and latitude are on screen: the nearest picked pixel on an 8 px grid.
const screenOf = (page, lon, lat) => js(page, (lon, lat) => {
  const v = window.vvater.viewer, r = v.canvas.getBoundingClientRect(), e = v.scene.globe.ellipsoid;
  let best = null, bd = Infinity;
  for (let y = 0; y < r.height; y += 8) for (let x = 0; x < r.width; x += 8) {
    const w = v.camera.pickEllipsoid({ x, y });
    if (!w) continue;
    const g = e.cartesianToCartographic(w);
    const d = (g.longitude * 180 / Math.PI - lon) ** 2 + (g.latitude * 180 / Math.PI - lat) ** 2;
    if (d < bd) { bd = d; best = { x: r.left + x, y: r.top + y }; }
  }
  return best;
}, lon, lat);

// The mouse along a straight line from a to b over frames [i0, i1], eased.
const glide = (a, b, i, i0, i1) => {
  const k = Math.min(1, Math.max(0, (i - i0) / (i1 - i0))), e = k * k * (3 - 2 * k);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
};

// ------------------------------------------------------------------ the clips

// Each clip's length is the one script.json gives it, so the film is timed in one place.
const LENGTH = {};
for (const sc of JSON.parse(fs.readFileSync(path.join(__dirname, "script.json"), "utf8")).scenes)
  for (const c of sc.clips || []) LENGTH[c.name] = c.seconds;
const secs = (name) => {
  if (!LENGTH[name]) throw new Error(`${name} is not in script.json`);
  return LENGTH[name];
};
const DEG = 180 / Math.PI;

const CLIPS = {};

// Amphan's Bay two days before the storm, to 1,000 m (the deck's hero state).
async function amphan(b, { floats = false, cut = 0, docks } = {}) {
  const p = await open(b, "scenario=amphan_before", docks ? { docks } : {});
  await set(p, "cube-floats", floats);
  await set(p, "cube-depth", 1000);
  await click(p, "#cube-load");
  await settle(p);
  if (cut) await set(p, "cut-south", cut);
  await set(p, "cube-height", 25);
  await settle(p);
  return p;
}

// Open: the immersive cinematic, from its first frame (space, then down to the Bay).
CLIPS["cinema-open"] = async (b) => {
  const p = await open(b, "scenario=amphan_before&immersive=1");
  await settle(p, 3000);
  await js(p, () => { document.getElementById("immersive-bar").style.visibility = "hidden"; window.__film.start(); });
  await click(p, "#imm-cinema");
  await record(p, "cinema-open", secs("cinema-open"), hold, { easing: "linear" });
  return p;
};

// From straight above (a map) round to the side (a block).
CLIPS["amphan-tilt"] = async (b) => {
  const p = await amphan(b);
  const r = (await getPose(p)).range;
  await record(p, "amphan-tilt", secs("amphan-tilt"), orbitMove, { arg: {
    a: { heading: 0, pitch: -89, range: r * 1.05 },
    b: { heading: -12, pitch: -32, range: r * 1.0 } } });
  return p;
};

// The south side cut inwards while the camera drifts round.
CLIPS["amphan-cut"] = async (b) => {
  const p = await amphan(b);
  const r = (await getPose(p)).range;
  await record(p, "amphan-cut", secs("amphan-cut"), function (t, a) {
    const e = document.getElementById("cut-south");
    const k = Math.min(1, t / 0.55), s = k * k * (3 - 2 * k);
    // Only when it moves: each input rebuilds the faces, and a rebuild with no renders to
    // finish in draws the block white.
    const v = String(Math.round(450 * s));
    if (e.value !== v) { e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }
    // A drag ends in a change event. Fired every tenth frame as the side moves, the currents
    // follow the cut; every frame, their trails never grew back.
    window.__cutFrame = (window.__cutFrame || 0) + 1;
    if ((k < 1 && window.__cutFrame % 10 === 0) || (k >= 1 && !window.__cutDone)) {
      e.dispatchEvent(new Event("change", { bubbles: true }));
      window.__cutDone = k >= 1;
    }
    const o = window.vvater.orbit, D = Math.PI / 180;
    o.pose.heading = (-25 + 20 * t) * D;
    o.pose.pitch = (-32 + 4 * t) * D;
    o.pose.range = a.r * 0.8 * Math.pow(0.85, t);
    o.apply();
  }, { easing: "linear", arg: { r },
    // Renders only while the side moves: each one also ages the particles, and eight a frame
    // left the top almost bare.
    rebuild: (i) => (i < secs("amphan-cut") * FPS * 0.55 + 4 ? 8 : 0) });
  return p;
};

// A box drawn on the globe with the mouse, and the block it cuts out appearing. Over the Gulf
// Stream scenario's own box and day, so the chunks are already on disk.
CLIPS["draw-box"] = async (b) => {
  const p = await open(b, "scenario=gulf_stream");
  await set(p, "cube-show", false);
  await settle(p, 1500);
  await js(p, () => {
    const o = window.vvater.orbit, D = Math.PI / 180;
    o.pose.lon = -66; o.pose.lat = 36; o.pose.heading = 0; o.pose.pitch = -70 * D; o.pose.range = 5200e3;
    o.apply();
  });
  await settle(p, 2500);
  await showCursor(p);
  const A = await screenOf(p, -75, 43), B = await screenOf(p, -57, 33);
  const home = { x: A.x - 260, y: A.y + 220 };
  await p.mouse.move(home.x, home.y);
  // Pressing Draw shows the old cube again, and it covers the box being dragged (D-48), so
  // it is put away after the press and the new block shown the moment its data arrives.
  let shown = false;
  // The drag rectangle's geometry is rebuilt on every move, so the drag frames get renders too.
  await record(p, "draw-box", secs("draw-box"), hold, { easing: "linear", rebuild: (i) => (i > 45 && i <= 132 ? 6 : 0), drive: async (i) => {
    if (i === 0) {
      await js(p, () => { document.getElementById("cube-draw").click(); window.__old = window.vvater.cube.data; });
      await set(p, "cube-show", false);
    }
    if (i > 130 && !shown && await js(p, () => window.vvater.cube.data !== window.__old)) {
      await set(p, "cube-show", true);
      shown = true;
    }
    if (i <= 40) { const m = glide(home, A, i, 0, 40); await p.mouse.move(m.x, m.y); }
    if (i === 45) await p.mouse.down();
    if (i > 45 && i <= 125) { const m = glide(A, B, i, 45, 125); await p.mouse.move(m.x, m.y); }
    if (i === 130) await p.mouse.up();
    if (i > 150 && i <= 200) { const m = glide(B, { x: 1880, y: 1000 }, i, 150, 200); await p.mouse.move(m.x, m.y); }
  } });
  return p;
};

// Floats standing in the open section; push in towards them.
CLIPS.floats = async (b) => {
  const p = await amphan(b, { floats: true, cut: 450 });
  const r = (await getPose(p)).range;
  await record(p, "floats", secs("floats"), orbitMove, { arg: {
    a: { heading: -20, pitch: -30, range: r * 0.75 },
    b: { heading: 10, pitch: -22, range: r * 0.5 } } });
  return p;
};

// One float clicked: its profile against the model, with QC flag, data mode and file.
CLIPS["float-click"] = async (b) => {
  const p = await amphan(b, { floats: true, cut: 450, docks: { left: false, right: true } });
  const r = (await getPose(p)).range;
  await js(p, (r) => {
    const o = window.vvater.orbit, D = Math.PI / 180;
    o.pose.heading = -20 * D; o.pose.pitch = -40 * D; o.pose.range = r * 0.8; o.apply();
  }, r);
  await settle(p, 1200);
  const hit = await js(p, () => {
    const v = window.vvater, c = v.viewer.canvas, rc = c.getBoundingClientRect();
    for (let y = rc.height * 0.3; y < rc.height * 0.85; y += 6)
      for (let x = rc.width * 0.25; x < rc.width * 0.8; x += 6)
        if (v.cube.castAt({ x, y })) return { x: rc.left + x, y: rc.top + y };
    return null;
  });
  if (!hit) throw new Error("no float stick on screen");
  await p.mouse.move(hit.x, hit.y);
  await p.mouse.click(hit.x, hit.y);
  await settle(p);
  await record(p, "float-click", secs("float-click"), orbitMove, { arg: {
    a: { heading: -20, range: r * 0.8 }, b: { heading: -12, range: r * 0.72 } } });
  return p;
};

// Before and after Amphan: same box, camera and 28-31.5 C bar.
async function amphanDay(b, scenario, name) {
  const p = await open(b, `scenario=${scenario}`);
  await set(p, "range-min", 28);
  await set(p, "range-max", 31.5);
  await settle(p);
  await record(p, name, secs(name), orbitMove, { easing: "linear", arg: {
    a: { heading: -4, pitch: -62, range: 2600e3 }, b: { heading: 4, pitch: -62, range: 2450e3 } } });
  return p;
}
CLIPS["amphan-before"] = (b) => amphanDay(b, "amphan_before", "amphan-before");
CLIPS["amphan-after"] = (b) => amphanDay(b, "amphan_after", "amphan-after");

// The montage: each scenario as it opens, a slow turn.
async function scenarioOrbit(b, scenario, name, pose) {
  const p = await open(b, `scenario=${scenario}`);
  const s = await getPose(p);
  const h = pose?.heading ?? s.heading * DEG, pitch = pose?.pitch ?? s.pitch * DEG, r = s.range * (pose?.zoom ?? 1);
  await record(p, name, secs(name), orbitMove, { easing: "linear", arg: {
    a: { heading: h - 12, pitch, range: r }, b: { heading: h + 12, pitch: pitch + 4, range: r * 0.9 } } });
  return p;
}
CLIPS["arabian-sea"] = (b) => scenarioOrbit(b, "arabian_sea", "arabian-sea");
CLIPS["gulf-stream"] = (b) => scenarioOrbit(b, "gulf_stream", "gulf-stream");
// A 100-degree box: from its home pose it sits edge-on at the planet's rim.
CLIPS["el-nino"] = (b) => scenarioOrbit(b, "el_nino", "el-nino", { heading: 0, pitch: -30, zoom: 0.6 });
CLIPS.agulhas = (b) => scenarioOrbit(b, "agulhas", "agulhas");
CLIPS.drake = (b) => scenarioOrbit(b, "drake_passage", "drake");

// The planet in the cube's colours, currents and winds over it; the globe turns.
CLIPS.globe = async (b) => {
  const p = await open(b, "scenario=gulf_stream&view=globe&air=1");
  await settle(p, 4000);
  await record(p, "globe", secs("globe"), function (t) {
    const v = window.vvater.viewer, R = Math.PI / 180;
    v.camera.setView({ destination: v.scene.globe.ellipsoid.cartographicToCartesian(
      { longitude: (-70 + 45 * t) * R, latitude: 28 * R, height: 11000e3 }) });
  }, { easing: "linear" });
  return p;
};

// The cinematic's fourth shot, "First light": the sun on the horizon over the Bay. Its first
// three shots run 14 + 11 + 12 s; the cut into it passes through black, so it starts after.
CLIPS["cinema-dawn"] = async (b) => {
  const p = await open(b, "scenario=amphan_before&immersive=1");
  await settle(p, 3000);
  await js(p, () => { document.getElementById("immersive-bar").style.visibility = "hidden"; window.__film.start(); });
  await click(p, "#imm-cinema");
  await record(p, "cinema-dawn", secs("cinema-dawn"), hold, { easing: "linear", skip: 38.2 });
  return p;
};

// Fly: up Sri Lanka's east coast, the sea on the right and the hills on the left. Paused
// while the tiles for that place load, then flown on the virtual clock.
CLIPS.fly = async (b) => {
  const p = await open(b, "scenario=amphan_before&view=fly");
  // The sea as imagery, not painted with temperature: from a plane the 1/4-degree colour
  // cells read as blocks along the coast.
  await set(p, "ocean-surface", false);
  await js(p, () => {
    const f = window.vvater.flight;
    f.paused = true;
    Object.assign(f.state, { lat: 6.6, lon: 82.4, heading: 335, height: 9000, speed: 3000, look: -18 });
  });
  await settle(p, 6000);
  await js(p, () => { window.vvater.flight.paused = false; });
  await record(p, "fly", secs("fly"), hold, { easing: "linear" });
  return p;
};

// The properties panel, scrolled top to bottom: every control, on the Amphan block.
CLIPS.controls = async (b) => {
  const p = await amphan(b, { docks: { left: true, right: false } });
  await js(p, () => { for (const d of document.querySelectorAll("#left details")) d.open = true; });
  await settle(p, 1500);
  const s0 = await getPose(p);
  await record(p, "controls", secs("controls"), function (t, a) {
    const l = document.querySelector("#left .dock-body"), k = Math.min(1, Math.max(0, (t - 0.08) / 0.84));
    const e = k * k * (3 - 2 * k);
    l.scrollTop = e * (l.scrollHeight - l.clientHeight);
    const o = window.vvater.orbit, D = Math.PI / 180;
    o.pose.heading = a.h + (-18 + 26 * t) * D; o.pose.pitch = -34 * D; o.pose.range = a.r * 0.85; o.apply();
  }, { easing: "linear", arg: { h: s0.heading, r: s0.range } });
  return p;
};

// The four views, clicked in turn: Region 3D, Map 2D, Globe, Fly, and back.
CLIPS.views = async (b) => {
  const p = await open(b, "scenario=amphan_before");
  await showCursor(p);
  const centre = (sel) => js(p, (sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  const btn = { map: await centre("#view-map"), globe: await centre("#view-globe"), fly: await centre("#view-fly") };
  const start = { x: 900, y: 500 };
  await p.mouse.move(start.x, start.y);
  const n = Math.round(secs("views") * FPS), step = Math.floor(n / 4);
  // Each button: glide there over 20 frames, click, then leave the pointer at rest.
  const plan = [["map", 10], ["globe", 10 + step], ["fly", 10 + 2 * step]];
  let from = start;
  await record(p, "views", secs("views"), hold, { easing: "linear", drive: async (i) => {
    for (const [name, at] of plan) {
      if (i >= at && i <= at + 20) { const m = glide(from, btn[name], i, at, at + 20); await p.mouse.move(m.x, m.y); }
      if (i === at + 22) { await p.mouse.click(btn[name].x, btn[name].y); from = btn[name]; }
      if (i >= at + 30 && i <= at + 45) { const m = glide(btn[name], { x: btn[name].x, y: btn[name].y + 120 }, i, at + 30, at + 45); await p.mouse.move(m.x, m.y); if (i === at + 45) from = m; }
    }
  } });
  return p;
};

// For fishermen: INCOIS PFZ advisories and the indicative zones, left dock open on them.
CLIPS.fishing = async (b) => {
  const p = await open(b, `box=78,100,5,23&day=${new Date().toISOString().slice(0, 10)}&v=temperature`,
    { docks: { left: true, right: false } });
  await js(p, () => {
    for (const d of document.querySelectorAll("#left details")) d.open = d.id === "fishing-section";
  });
  await set(p, "pfz-on", true);
  await set(p, "fish-on", true);
  await settle(p, 3000);
  await js(p, () => document.getElementById("fishing-section").scrollIntoView());
  const s = await getPose(p);
  await record(p, "fishing", secs("fishing"), orbitMove, { easing: "linear", arg: {
    a: { heading: s.heading * DEG - 6, range: s.range }, b: { heading: s.heading * DEG + 6, range: s.range * 0.85 } } });
  return p;
};

// The INCOIS Bay volume; with `residual`, observed minus model.
// Streamlines off: from above they cover the volume completely.
async function bay(b, residual) {
  const p = await open(b, "scenario=bay_of_bengal");
  await set(p, "bay-volume", true);
  await settle(p, 3000);
  await set(p, "currents", false);
  await settle(p, 3000);
  if (residual) {
    await click(p, "#layer-residual");
    await settle(p, 3000);
  }
  return p;
}
CLIPS["bay-volume"] = async (b) => {
  const p = await bay(b, false);
  const s = await getPose(p);
  await record(p, "bay-volume", secs("bay-volume"), orbitMove, { arg: {
    a: { heading: s.heading * DEG - 20, pitch: -30, range: s.range * 0.9 },
    b: { heading: s.heading * DEG + 10, pitch: -22, range: s.range * 0.75 } } });
  return p;
};
CLIPS.residual = async (b) => {
  const p = await bay(b, true);
  const s = await getPose(p);
  await record(p, "residual", secs("residual"), orbitMove, { arg: {
    a: { heading: s.heading * DEG + 10, pitch: s.pitch * DEG, range: s.range * 0.9 },
    b: { heading: s.heading * DEG - 15, pitch: s.pitch * DEG + 4, range: s.range * 0.75 } } });
  return p;
};

// Learner mode: lesson 4, Amphan, a couple of steps in.
CLIPS.learn = async (b) => {
  const p = await open(b, "scenario=amphan_before", { learn: null });
  await click(p, "#learn-btn");
  await sleep(800);
  await click(p, "[data-i='3']");
  await settle(p);
  for (let i = 0; i < 2; i++) {
    await js(p, () => [...document.querySelectorAll("button")].find((b) => /^Next/.test(b.textContent.trim()))?.click());
    await settle(p);
  }
  const s = await getPose(p);
  await record(p, "learn", secs("learn"), orbitMove, { easing: "linear", arg: {
    a: { heading: s.heading * DEG - 8, range: s.range }, b: { heading: s.heading * DEG + 8, range: s.range * 0.9 } } });
  return p;
};

// The assistant, live: the question typed, Ask pressed, the answer arriving and the block it
// asked for being built. Typing runs at one character a frame. 2,000 m is one of the depth
// options, so the reply and the block agree (D-47).
const QUESTION = "Show me dissolved oxygen in the Arabian Sea, 50 to 78 E and 5 to 25 N, down to 2,000 m, on 15 October 2019";
CLIPS.assistant = async (b) => {
  const p = await open(b, "scenario=amphan_before", { docks: { left: false, right: true } });
  await showCursor(p);
  const centre = (sel) => js(p, (sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  const field = await centre(".chat-form textarea, .chat-form input");
  const ask = await centre(".chat-form button");
  const home = { x: field.x - 700, y: field.y + 300 };
  await p.mouse.move(home.x, home.y);
  const typeFrom = 40, typeTo = typeFrom + QUESTION.length;
  await record(p, "assistant", secs("assistant"), hold, { easing: "linear", drive: async (i) => {
    if (i <= 30) { const m = glide(home, field, i, 0, 30); await p.mouse.move(m.x, m.y); }
    if (i === 33) await p.mouse.click(field.x, field.y);
    if (i >= typeFrom && i < typeTo) await p.keyboard.type(QUESTION[i - typeFrom]);
    if (i > typeTo + 5 && i <= typeTo + 25) { const m = glide(field, ask, i, typeTo + 5, typeTo + 25); await p.mouse.move(m.x, m.y); }
    if (i === typeTo + 28) await p.mouse.click(ask.x, ask.y);
    if (i > typeTo + 40 && i <= typeTo + 70) { const m = glide(ask, { x: ask.x + 30, y: 1060 }, i, typeTo + 40, typeTo + 70); await p.mouse.move(m.x, m.y); }
  } });
  return p;
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(CLIPS);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", `--window-size=${W},${H}`],
  });
  try {
    for (const n of names) {
      console.log(n);
      try { const p = await CLIPS[n](browser); await p.close(); }
      catch (e) { console.log("  FAILED:", e.stack || e.message); process.exitCode = 1; }
    }
  } finally {
    await browser.close();
  }
})();
