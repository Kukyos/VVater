// Screenshots for the deck, from the running viewer (API on :8011, `npm run dev` on :5173).
//
//   npm i --prefix <somewhere> puppeteer-core
//   NODE_PATH=<somewhere>/node_modules node submission/sih/capture.cjs [shot ...]
//
// Headless Chrome, 1600 x 900 at device scale 2, Graphics forced to High: left on Auto a
// headless GPU tunes itself down and every shot comes out soft. Each shot starts from a
// fresh page with the course offer dismissed and reaches its state through URL parameters,
// the DOM and the dev-only window.vvater handle. Output: figures/shot-<name>.png.
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.VIEWER || "http://localhost:5173/";
const OUT = path.join(__dirname, "figures");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until no request has been in flight for `quiet` ms, then let the full-resolution
// frame land (the viewer redraws at full resolution 350 ms after the scene stops).
async function settle(page, quiet = 2500, max = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const idle = await page.evaluate((q) => performance.now() - (window.__lastNet || 0) > q
      && (window.__inflight || 0) === 0, quiet);
    if (idle) break;
    await sleep(300);
  }
  await sleep(1500);
}

async function open(browser, query, { learn = "declined", docks = { left: false, right: false } } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((learn, docks) => {
    localStorage.setItem("vvater.graphics.v2", JSON.stringify({
      tier: "high", auto: false,
      quality: { msaa: 4, fxaa: false, resolution: 1, sky: true, onDemand: true, showFps: false, pauseOnMove: true } }));
    if (learn) localStorage.setItem("vvater.learn", JSON.stringify({ seen: true, done: [] }));
    for (const [side, open] of Object.entries(docks))
      localStorage.setItem(`vvater.dock.${side}`, open ? "open" : "closed");
    // Count fetches in flight, for settle().
    const f = window.fetch;
    window.__inflight = 0;
    window.fetch = async (...a) => {
      window.__inflight++; window.__lastNet = performance.now();
      try { return await f(...a); } finally { window.__inflight--; window.__lastNet = performance.now(); }
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
// Move the orbit camera: angles in degrees, range as a multiple of the current one.
async function pose(page, { heading, pitch, zoom, km, dlon = 0, dlat = 0 } = {}) {
  await page.evaluate((heading, pitch, zoom, km, dlon, dlat) => {
    const o = window.vvater.orbit, p = o.pose, D = Math.PI / 180;
    if (heading !== undefined) p.heading = heading * D;
    if (pitch !== undefined) p.pitch = pitch * D;
    if (zoom) p.range *= zoom;
    if (km) p.range = km * 1000;
    p.lon += dlon; p.lat += dlat;
    o.apply();
  }, heading, pitch, zoom, km, dlon, dlat);
  await settle(page, 1200);
}

async function shoot(page, name, clip) {
  const file = path.join(OUT, `shot-${name}.png`);
  if (clip === "view") {
    const el = await page.$("#view");
    await el.screenshot({ path: file });
  } else await page.screenshot({ path: file, clip });
  console.log("  wrote", path.relative(process.cwd(), file));
}

const SHOTS = {};

// The hero state: Amphan's Bay two days before the storm, to 1,000 m, the south side cut
// in so the floats stand in the open section.
async function amphanCut(p) {
  await set(p, "cube-floats", true);
  await set(p, "cube-depth", 1000);
  await click(p, "#cube-load");
  await settle(p);
  await set(p, "cut-south", 450);
  await set(p, "cube-height", 25);
  await settle(p);
  await pose(p, { heading: -20, pitch: -40, zoom: 0.8 });
}

// Tuning helper: HERO='[{"name":..,"set":{id:value},"click":[sel],"pose":{..}}]'.
SHOTS.tune = async (b) => {
  const p = await open(b, process.env.QUERY || "scenario=amphan_before");
  for (const v of [].concat(JSON.parse(process.env.HERO || "{}"))) {
    for (const [id, val] of Object.entries(v.set || {})) await set(p, id, val);
    for (const sel of v.click || []) { await click(p, sel); await settle(p); }
    for (const [id, val] of Object.entries(v.after || {})) await set(p, id, val);
    await settle(p);
    await pose(p, v.pose || {});
    await shoot(p, v.name || "tune", "view");
  }
  return p;
};

// Slide 2 hero.
SHOTS.hero = async (b) => {
  const p = await open(b, "scenario=amphan_before");
  await amphanCut(p);
  await shoot(p, "hero", "view");
  return p;
};

// A float clicked: its stick against the model, with QC flags, data mode and file.
SHOTS.float = async (b) => {
  const p = await open(b, "scenario=amphan_before", { docks: { left: false, right: true } });
  await amphanCut(p);
  const hit = await js(p, () => {
    const v = window.vvater, c = v.viewer.canvas, r = c.getBoundingClientRect();
    for (let y = r.height * 0.25; y < r.height * 0.85; y += 6)
      for (let x = r.width * 0.2; x < r.width * 0.85; x += 6)
        if (v.cube.castAt({ x, y })) return { x: r.left + x, y: r.top + y };
    return null;
  });
  if (!hit) throw new Error("no float stick on screen");
  await p.mouse.move(hit.x, hit.y);
  await p.mouse.click(hit.x, hit.y);
  await settle(p);
  await shoot(p, "float");
  return p;
};

// The planet in the cube's colours, currents and winds flowing over it. Winter in the
// North Atlantic spans the colour bar; May in the Bay is 30 C wall to wall.
SHOTS.globe = async (b) => {
  const p = await open(b, `scenario=gulf_stream&view=globe${process.env.AIR === "0" ? "" : "&air=1"}`);
  await settle(p, 4000);
  await js(p, (c) => {
    const v = window.vvater.viewer, C = window.Cesium || v.constructor;
    v.camera.setView({ destination: v.scene.globe.ellipsoid.cartographicToCartesian(
      { longitude: c[0] * Math.PI / 180, latitude: c[1] * Math.PI / 180, height: c[2] * 1000 }) });
  }, JSON.parse(process.env.CAM || "[-45, 25, 11000]"));
  await settle(p, 4000);
  await shoot(p, "globe", "view");
  return p;
};

// The assistant asked for a cube; it builds it and rings the control it used.
SHOTS.assistant = async (b) => {
  const p = await open(b, "scenario=bay_of_bengal", { docks: { left: true, right: true } });
  await js(p, (q) => {
    const f = document.querySelector(".chat-form");
    f.querySelector("textarea, input").value = q;
    f.requestSubmit();
  }, process.env.ASK || "Make a cube of dissolved oxygen in the Arabian Sea, 50 to 78 E and 5 to 25 N, down to 1,500 m, on 15 October 2019");
  await p.waitForFunction(() => document.querySelectorAll(".chat-log > *").length >= 3, { timeout: 120000 });
  await settle(p, 3000, 240000);
  await shoot(p, "assistant");
  return p;
};

// Learner mode: lesson 4, Amphan, on its narrow colour bar.
SHOTS.learn = async (b) => {
  const p = await open(b, "scenario=amphan_before", { learn: null });
  await click(p, "#learn-btn");
  await sleep(800);
  await click(p, "[data-i='3']");
  await settle(p);
  for (let i = 0; i < Number(process.env.LEARN_STEPS || 2); i++) {
    await js(p, () => [...document.querySelectorAll("button")].find((b) => /^Next/.test(b.textContent.trim()))?.click());
    await settle(p);
  }
  await shoot(p, "learn");
  return p;
};

// Before and after Amphan: same box, camera and 28-31.5 C bar.
SHOTS.amphan = async (b) => {
  const p = await open(b, "scenario=amphan_before");
  const view = { heading: 0, pitch: -62, km: 2600 };
  await set(p, "range-min", 28); await set(p, "range-max", 31.5);
  await settle(p);
  await pose(p, view);
  await shoot(p, "amphan-before", "view");
  await set(p, "cube-scenario", "amphan_after");
  await settle(p);
  await set(p, "range-min", 28); await set(p, "range-max", 31.5);
  await settle(p);
  await pose(p, view);
  await shoot(p, "amphan-after", "view");
  return p;
};

// For fishermen: INCOIS PFZ advisories and the indicative zones with sea state.
SHOTS.fishing = async (b) => {
  const p = await open(b, `box=78,100,5,23&day=${new Date().toISOString().slice(0, 10)}&v=temperature`, { docks: { left: true, right: false } });
  await js(p, () => {
    for (const d of document.querySelectorAll("#left details")) d.open = d.id === "fishing-section";
  });
  await set(p, "pfz-on", true);
  await set(p, "fish-on", true);
  await settle(p, 3000);
  await js(p, () => document.getElementById("fishing-section").scrollIntoView());
  await shoot(p, "fishing");
  return p;
};

// Immersive, the cinematic tour at dawn.
SHOTS.immersive = async (b) => {
  const p = await open(b, "scenario=amphan_before&immersive=1");
  await settle(p, 3000);
  await click(p, "#imm-cinema");
  await sleep(Number(process.env.CINE_MS || 9000));
  await shoot(p, "immersive");
  return p;
};

// Fly over the Bay, terrain and imagery from Cesium ion.
SHOTS.fly = async (b) => {
  const p = await open(b, "scenario=amphan_before&view=fly");
  await settle(p, 4000);
  await shoot(p, "fly", "view");
  return p;
};

// The INCOIS Bay volume: observed minus model, where somebody measured.
SHOTS.residual = async (b) => {
  const p = await open(b, "scenario=bay_of_bengal");
  await set(p, "bay-volume", true);
  await settle(p, 3000);
  await set(p, "currents", false);
  await settle(p, 3000);
  await click(p, "#layer-residual");
  await settle(p, 3000);
  await shoot(p, "residual", "view");
  return p;
};

// The whole interface, both docks: every control the brief asks for is on screen.
SHOTS.ui = async (b) => {
  const p = await open(b, "scenario=arabian_sea", { docks: { left: true, right: true } });
  await set(p, "cube-floats", true);
  await settle(p, 3000);
  await shoot(p, "ui");
  return p;
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(SHOTS).filter((n) => n !== "tune");
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--window-size=1600,900"],
  });
  try {
    for (const n of names) {
      console.log(n);
      try { const p = await SHOTS[n](browser); await p.close(); }
      catch (e) { console.log("  FAILED:", e.message); }
    }
  } finally {
    await browser.close();
  }
})();
