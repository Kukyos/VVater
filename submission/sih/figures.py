"""Write the five slide bodies as HTML, with every number read from the eval harness.

    python -m server.eval.run_eval --json    # first, to refresh data/eval-latest.json
    python submission/sih/figures.py         # -> figures/body-*.html
    python submission/sih/render.py          # -> figures/body-*.png
    python submission/sih/figures.py --check # every body filled, no empty bands
    python submission/sih/build.py           # -> final/VVater-SIH2026.pptx

The first rule in docs/00-start-here.md ("The one architectural rule") is that no figure appears anywhere the harness did not produce.
That rule is only real if the deck *reads* the harness output rather than quoting it from
memory, so every number below comes out of `data/eval-latest.json` and a missing key is a
crash rather than a plausible-looking wrong number.

Who reads this: a judge who is not an oceanographer has to understand the problem and the
answer from slide 2 alone; an INCOIS forecaster has to find something they did not know.
So each slide carries a plain-language layer (what, why, for whom) and a technical layer
(how, measured), and every picture is a capture of the running build.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIGURES = Path(__file__).resolve().parent / "figures"
EVAL = ROOT / "data" / "eval-latest.json"
REPO = "github.com/Kukyos/VVater"

SHOTS = ["shot-workspace.png", "shot-region.png", "shot-map.png", "shot-simple.png",
         "shot-fly.png", "shot-resid.png"]
BODIES = ["body-solution", "body-technical", "body-feasibility", "body-impact",
          "body-references"]


def n2(value) -> str:
    return f"{float(value):.2f}"


def n1(value) -> str:
    return f"{float(value):.1f}"


def signed(value, digits=1) -> str:
    return f"{float(value):+.{digits}f}".replace("-", "&#8722;")


def load() -> dict:
    if not EVAL.exists():
        raise SystemExit(
            f"missing {EVAL.relative_to(ROOT)}. Run: python -m server.eval.run_eval --json"
        )
    missing = [s for s in SHOTS if not (FIGURES / s).exists()]
    if missing:
        raise SystemExit(f"missing screenshots {missing}; see docs/16-submission.md")
    return json.loads(EVAL.read_text(encoding="utf-8"))


def page(name: str, body: str) -> None:
    html = f"""<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
<link rel="stylesheet" href="deck.css"></head>
<body><div class="slide">{body}</div></body></html>
"""
    (FIGURES / f"{name}.html").write_text(html, encoding="utf-8")
    print(f"wrote figures/{name}.html")


# ------------------------------------------------------------------ charts

def band_chart(bands: dict, width=1180, height=620) -> str:
    """Grouped bars: RMSE by depth band, Argo (assimilated) vs glider (independent)."""
    labels = ["0-300 m", "300-950 m", "950-2000 m"]
    rows = [(b, bands[b]["argo"]["rmse"], bands[b]["glider"]["rmse"]) for b in labels]
    top = max(max(a, g) for _, a, g in rows)
    left, base = 90, height - 70
    scale = (base - 70) / top
    group = (width - left - 10) / len(rows)
    bar = group * 0.32
    out = [f'<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}">']
    for i in range(0, int(top) + 2):
        y = base - i * scale
        if y < 40:
            break
        out.append(f'<line x1="{left}" x2="{width}" y1="{y}" y2="{y}" stroke="#D5DCE4" stroke-width="2"/>')
        out.append(f'<text x="{left - 16}" y="{y + 12}" font-size="34" text-anchor="end" fill="#7A8594">{i}</text>')
    for k, (label, a, g) in enumerate(rows):
        x0 = left + k * group + group * 0.14
        for j, (value, colour) in enumerate(((a, "#A9B2BE"), (g, "#1F4E79"))):
            x = x0 + j * (bar + 12)
            y = base - value * scale
            out.append(f'<rect x="{x}" y="{y}" width="{bar}" height="{base - y}" fill="{colour}"/>')
            out.append(f'<text x="{x + bar / 2}" y="{y - 12}" font-size="38" font-weight="600" '
                       f'text-anchor="middle" fill="#16202B">{n2(value)}</text>')
        out.append(f'<text x="{x0 + bar + 6}" y="{base + 50}" font-size="36" text-anchor="middle" '
                   f'fill="#4F5B69">{label}</text>')
    out.append(f'<text x="{left - 16}" y="30" font-size="34" text-anchor="end" fill="#7A8594">&#176;C</text>')
    out.append("</svg>")
    return "".join(out)


def flowchart(empty_pct: str) -> str:
    """The pipeline with its three decisions, as the brief asks: a flow chart.

    Each decision is one the code really makes; the "no" branch of each is the part a
    reviewer should notice, because it is where most tools quietly drop or invent data.
    """
    W, H = 1840, 1420
    s = [f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         '<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
         '<path d="M0 0L10 5L0 10z" fill="#4F5B69"/></marker></defs>']

    def box(x, y, w, h, title, lines, fill="#F1F4F8", edge="#1F4E79", ink="#16202B", sub="#4F5B69"):
        s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{edge}" stroke-width="3"/>')
        s.append(f'<rect x="{x}" y="{y}" width="10" height="{h}" fill="{edge}"/>')
        s.append(f'<text x="{x + 30}" y="{y + 50}" font-size="40" font-weight="600" fill="{ink}">{title}</text>')
        for i, line in enumerate(lines):
            s.append(f'<text x="{x + 30}" y="{y + 96 + i * 42}" font-size="34" fill="{sub}">{line}</text>')

    def diamond(cx, cy, w, h, lines):
        s.append(f'<polygon points="{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}" '
                 f'fill="#FFF8E6" stroke="#B9770E" stroke-width="3"/>')
        top = cy - (len(lines) - 1) * 22 + 12
        for i, line in enumerate(lines):
            s.append(f'<text x="{cx}" y="{top + i * 44}" font-size="36" font-weight="600" text-anchor="middle" fill="#16202B">{line}</text>')

    def arrow(points, label=None, at=None, colour="#4F5B69"):
        pts = " ".join(f"{x},{y}" for x, y in points)
        s.append(f'<polyline points="{pts}" fill="none" stroke="{colour}" stroke-width="3.5" marker-end="url(#a)"/>')
        if label:
            lx, ly = at
            s.append(f'<text x="{lx}" y="{ly}" font-size="34" font-weight="600" fill="{colour}">{label}</text>')

    L, BW = 20, 840          # spine column
    cx = L + BW / 2
    R = 1000                  # branch column
    RW = W - R - 10

    box(L, 0, BW, 170, "1  Fetch", ["INCOIS analysis · Copernicus GLORYS12", "Argo floats · IOOS gliders · your CSV/TSV"])
    arrow([(cx, 170), (cx, 222)])
    box(L, 222, BW, 170, "2  Read and normalise", ["NetCDF (xarray) and text (by column name)", "odd units and axes fixed, every fix recorded"])
    arrow([(cx, 392), (cx, 432)])
    diamond(cx, 530, 600, 196, ["Level passes", "its QC flag?"])
    arrow([(cx + 300, 530), (R, 530)], "no", (cx + 330, 515), "#C0392B")
    box(R, 452, RW - 130, 156, "Drawn red as rejected", ["kept on the chart, never silently dropped"], fill="#FDEDEC", edge="#C0392B")
    arrow([(cx, 628), (cx, 680)], "yes", (cx + 16, 666))
    box(L, 680, BW, 170, "3  Regrid and pair", ["depth levels ≤ what the source has", "each cast vs nearest analysis, ±5 days"])
    arrow([(cx, 850), (cx, 890)])
    diamond(cx, 988, 600, 196, ["Grid cell has a", "measurement?"])
    arrow([(cx + 300, 988), (R, 988)], "no", (cx + 330, 973), "#B9770E")
    box(R, 910, RW - 130, 156, "Left empty, not guessed", [f"{empty_pct}% of the volume, shown as such"], fill="#FEF5E7", edge="#B9770E")
    arrow([(cx, 1086), (cx, 1130)], "yes", (cx + 16, 1118))
    box(L, 1130, BW, 120, "4  Compare: observed − model", [])
    s.append(f'<text x="{L + 30}" y="{1130 + 96}" font-size="34" fill="#4F5B69">residual per cell · cyclone heat potential</text>')

    # the currents branch, off the fetch step
    diamond(R + 220, 150, 440, 196, ["Source carries", "currents (u, v)?"])
    arrow([(L + BW, 85), (R + 10, 85), (R + 10, 150), (R + 10, 150)])
    arrow([(R + 440, 150), (R + 480, 150)], "yes", (R + 428, 112))
    box(R + 480, 60, RW - 480, 180, "Streamlines", ["RK2 on the server,", "at the slice depth"], fill="#EAF2FB", edge="#2E86C1")
    arrow([(R + 220, 248), (R + 220, 300)], "no", (R + 236, 285), "#4F5B69")
    box(R, 300, 520, 124, "Control says why", ["INCOIS has no u, v"], fill="#F1F4F8", edge="#A9B2BE")

    # everything lands in the API and the viewer
    y = 1290
    box(0, y, W, 130, "5  FastAPI  →  browser (CesiumJS)", [], fill="#1F4E79", edge="#1F4E79", ink="#FFFFFF")
    s.append(f'<text x="30" y="{y + 100}" font-size="34" fill="#CFE3F5">volumes as float32 · WMS · CSV upload · assistant  →  Simple globe · Region 3D · Map 2D · Fly · profiles</text>')
    arrow([(cx, 1250), (cx, y)])
    arrow([(W - 60, 240), (W - 60, y)])
    s.append("</svg>")
    return "".join(s)


# ------------------------------------------------------------------ slides

def main() -> None:
    FIGURES.mkdir(parents=True, exist_ok=True)
    e = load()

    bands = e["depth_bands"]
    shallow, deep = bands["0-300 m"], bands["300-950 m"]
    res, field, argo, glider = e["residual"], e["field"], e["argo"], e["glider"]
    coloc, rng, cur = e["colocation"], e["field_range_test"], e["currents"]
    tchp, text, regrid = e["tchp"], e["text_ingest"], e["regrid"]
    levels = regrid["output_levels"]
    ta, tg = tchp["argo"], tchp["glider"]
    empty_pct = f"{100 - float(res['coverage_percent']):.0f}"
    # The region box, as the harness recorded it: width along its middle latitude.
    import math
    (lon0, lon1), (lat0, lat1) = e["region"]["lon"], e["region"]["lat"]
    width_km = round((lon1 - lon0) * 111.32 * math.cos(math.radians((lat0 + lat1) / 2)) / 100) * 100
    depth_km = float(regrid["z_max_m"]) / 1000

    # ============================================================ 2 solution
    page("body-solution", f"""
<p class="lead" style="font-size:56px">INCOIS knows the ocean in 3D; its forecasters still read it in 2D.
<b>VVater puts the model and every instrument in one 3D scene, in a browser, and shows where they disagree.</b></p>
<div class="cols grow" style="grid-template-columns: 1fr 1650px; gap: 60px">
  <div class="col" style="gap:16px">
    <h2 style="margin:0">The problem, in plain words</h2>
    <div class="cards" style="grid-template-columns: repeat(3, 1fr)">
      <div class="card red"><h3>The ocean has depth</h3><p>A cyclone feeds on a warm layer
        tens of metres thick. A surface map cannot show how thick, and thickness is the fuel.</p></div>
      <div class="card grey"><h3>Two versions of truth</h3><p>The <b>model</b> estimates the whole
        ocean on a grid; <b>floats and gliders</b> actually measure, at a few points. Where they
        disagree matters most.</p></div>
      <div class="card grey"><h3>Two separate tools</h3><p>Each is opened in its own desktop
        program, mostly as flat maps, so comparing them is manual — the gap the brief names.</p></div>
    </div>
    <h2 style="margin:4px 0 0">One question, today and with VVater</h2>
    <div class="journey">
      <div class="who">Today</div>
      <div class="step now">Open the model in one desktop tool, pick a depth</div>
      <div class="step now">Open the float files in another, plot one profile</div>
      <div class="step now">Line them up by eye; repeat for every depth</div>
      <div class="who" style="color:var(--navy)">VVater</div>
      <div class="step vv">Open one link. <b>No install</b>; deployable on INCOIS servers</div>
      <div class="step vv">Whole water column + <b>{argo["profiles"]} float profiles, {glider["casts"]} glider casts</b></div>
      <div class="step vv">Click a float: profile vs model, gap in <b>°C and cyclone fuel</b></div>
    </div>
    <h2 style="margin:4px 0 0">What makes it different</h2>
    <div class="cards" style="grid-template-columns: repeat(2, 1fr); gap:18px">
      <div class="card"><h3>Shows where the model is wrong</h3><p>Measured minus model as its
        own 3D layer. Only <b>{res["coverage_percent"]}%</b> was ever measured; the rest stays visibly empty.</p></div>
      <div class="card"><h3>Shows how sure the model is</h3><p>The analysis ships an error field;
        water the model is guessing about is drawn faint, not solid.</p></div>
      <div class="card"><h3>Speaks the forecaster's unit</h3><p>Every comparison also in
        <b>cyclone heat potential</b> (kJ/cm²); the 20 °C isotherm is one click.</p></div>
      <div class="card"><h3>Never hides a bad reading</h3><p>Each point carries its QC flag, data
        mode and source file; rejected levels are drawn red, not deleted.</p></div>
    </div>
    <div class="gloss" style="grid-template-columns: repeat(4, 1fr)">
      <div><b>Argo float</b>a robot that dives to 2,000 m every ten days</div>
      <div><b>Glider</b>an underwater drone that saw-tooths along a track</div>
      <div><b>Analysis</b>the model's best 3D estimate, published by INCOIS</div>
      <div><b>Residual</b>measured minus modelled: how wrong, and where</div>
    </div>
  </div>
  <div class="col" style="gap:16px">
    <figure class="shot"><img src="shot-workspace.png" style="aspect-ratio: 16 / 9; object-fit: cover; object-position: 100% 45%">
      <figcaption><b>The working prototype, not a mock-up:</b> the volume cut at 93 m with currents and every float; right, the built-in assistant opened a float for us and compared it with the model from the data.</figcaption></figure>
    <div class="thumbs" style="grid-template-columns: repeat(4, 1fr)">
      <figure><img src="shot-simple.png"><figcaption><b>Simple</b>the whole ocean, one layer</figcaption></figure>
      <figure><img src="shot-region.png"><figcaption><b>Region 3D</b>water column, 40× tall</figcaption></figure>
      <figure><img src="shot-map.png"><figcaption><b>Map 2D</b>section at any depth</figcaption></figure>
      <figure><img src="shot-fly.png"><figcaption><b>Fly</b>over the Bay, fixed height</figcaption></figure>
    </div>
  </div>
</div>
""")

    # ============================================================ 3 technical
    page("body-technical", f"""
<div class="cols grow" style="grid-template-columns: 1840px 1fr; gap: 90px">
  <div class="col">
    <h2 style="margin:0">From raw files to the scene — and what happens to bad or missing data</h2>
    {flowchart(empty_pct)}
    <p class="muted" style="font-size:36px">Diamonds are decisions the code makes. The red and amber
    branches are where most tools quietly drop a bad reading or paint over a gap; here both stay
    on screen, labelled.</p>
  </div>
  <div class="col" style="gap:22px">
    <h2 style="margin:0">Stack — each choice against what we did not pick</h2>
    <table>
      <tr><th>Chosen</th><th>Instead of</th><th>Why</th></tr>
      <tr><td>CesiumJS</td><td class="alt">Three.js, deck.gl</td><td class="why">A real globe with
        correct geography, and a built-in voxel raymarcher; we wrote only the colour transfer
        function. Three.js needs both hand-built; deck.gl has no volume layer.</td></tr>
      <tr><td>TypeScript + Vite</td><td class="alt">React, Angular</td><td class="why">No UI framework,
        on purpose: one Cesium canvas and a control panel. React or Angular would add a second
        render loop beside Cesium's; typed ES modules do the job.</td></tr>
      <tr><td>FastAPI</td><td class="alt">Flask, Django</td><td class="why">The science stack
        (xarray, NumPy, TEOS-10) is Python; typed parameters and API docs come free; nothing
        here needs Django's database layer.</td></tr>
      <tr><td>xarray</td><td class="alt">PyNIO</td><td class="why">The brief names both; PyNIO is
        archived and unmaintained, xarray is live and reads CF metadata.</td></tr>
      <tr><td>Raw float32</td><td class="alt">JSON, OPeNDAP</td><td class="why">Bytes go straight
        into a GPU texture with no parsing: one full INCOIS timestep is <b>{n2(field["float32_mb"])} MB</b>.</td></tr>
      <tr><td>OGC WMS 1.3.0</td><td class="alt">only our own tiles</td><td class="why">The same layers
        open in QGIS or any national portal, as the brief's open-standards clause asks.</td></tr>
      <tr><td>Groq LLM + tools</td><td class="alt">a plain chatbot</td><td class="why">The model can
        only answer through our own API functions; every number in a reply is checked against the
        data it came from, and untraceable ones are flagged on screen.</td></tr>
    </table>
    <h2 style="margin:8px 0 0">How a volume is drawn</h2>
    <ul class="points">
      <li><b>Opacity per metre of water, not per sample</b><span>so a coarse and a fine grid of the same sea look the same</span></li>
      <li><b>Depth levels spaced by √depth, never more than the source has</b><span>{levels} levels, 5–2000 m; inventing levels would invent a thermocline</span></li>
      <li><b>New sensor = one parser function and one line of config</b><span>the same glider as CSV and as NetCDF gives {text["casts_identical"]} of {text["casts_netcdf"]} casts identical</span></li>
    </ul>
  </div>
</div>
""")

    # ============================================================ 4 feasibility
    page("body-feasibility", f"""
<div class="stats" style="grid-template-columns: repeat(6, 1fr)">
  <div class="stat"><b>{argo["profiles"]}</b><span>Argo profiles in the demo window, {argo["data_modes"]["D"]} scientist-checked (delayed mode)</span></div>
  <div class="stat"><b>{glider["casts"]}</b><span>glider casts, {glider["levels"]:,} levels, from an independent instrument</span></div>
  <div class="stat"><b>{n2(field["float32_mb"])} MB</b><span>one full 3D timestep, temperature and its error, as sent to the browser</span></div>
  <div class="stat"><b>{res["build_seconds"]} s</b><span>to pair {res["casts"]} casts with the model and build the residual volume</span></div>
  <div class="stat"><b>{cur["count"]}</b><span>current streamlines integrated in {int(float(cur["seconds"]) * 1000)} ms on the server</span></div>
  <div class="stat"><b>{text["casts_identical"]}/{text["casts_netcdf"]}</b><span>casts identical read from CSV and from NetCDF — {text["levels_identical"]:,} levels</span></div>
</div>
<div class="cols grow feas" style="grid-template-columns: 1180px 1fr 1.25fr; gap: 70px">
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Measured finding: model error by depth</h2>
    {band_chart(bands, height=900)}
    <div class="legend"><i style="background:#A9B2BE"></i>Argo (the model already used them)
      <i style="background:#1F4E79"></i>Glider (independent)</div>
    <p style="font-size:35px" class="muted">Below 300 m model and instruments agree
    ({n2(deep["argo"]["rmse"])} vs {n2(deep["glider"]["rmse"])} °C). In the top 300 m — the warm layer a
    cyclone feeds on — the independent glider finds <b class="red">{n2(shallow["glider"]["rmse"])} °C</b>.
    That is the gap this tool makes visible.</p>
  </div>
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Runs on what INCOIS has</h2>
    <ul class="points">
      <li><b>One Python process + static files</b><span>no database server, no container required</span></li>
      <li><b>Any modern browser</b><span>no plug-in, no install, no account</span></li>
      <li><b>No third-party service at demo time</b><span>offline basemap, no map-tile token, data cached after first fetch</span></li>
      <li><b>INCOIS data needs no credentials</b><span>public ERDDAP; Copernicus is optional, for currents</span></li>
      <li><b>Graphics tuned to the machine</b><span>four quality tiers, picked by measuring real frames at start-up</span></li>
      <li><b>Every claim reproducible</b><span>one command regenerates every number on these slides</span></li>
    </ul>
    <h2 style="margin:10px 0 0">Model vs two instruments</h2>
    <table>
      <tr><th>Against</th><th>Casts</th><th>Bias</th><th>RMSE</th></tr>
      <tr><td>Argo</td><td>{coloc["profiles_compared"]}</td><td>{signed(coloc["mean_bias_degC"], 2)} °C</td><td>{n2(coloc["mean_rmse_degC"])} °C</td></tr>
      <tr><td>Glider</td><td>{coloc["glider_casts_compared"]}</td><td>{signed(coloc["glider_mean_bias_degC"], 2)} °C</td><td>{n2(coloc["glider_mean_rmse_degC"])} °C</td></tr>
    </table>
    <p class="muted" style="font-size:34px">Argo is a consistency check (the model assimilates it);
    the glider is the independent test.</p>
  </div>
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Risks we hit, and what we did</h2>
    <table>
      <tr><th>Risk</th><th>Handled by</th></tr>
      <tr><td>Brief's data links are dead</td><td class="why">Both are <span class="mono">ftp://</span>; port 21 is blocked. Replaced with tested HTTPS mirrors.</td></tr>
      <tr><td>Impossible values in the model</td><td class="why">{rng["failed"]} of {rng["checked_cells"]:,} cells fail the Argo range test; masked and counted, not drawn.</td></tr>
      <tr><td>Files not quite CF-standard</td><td class="why">Units like <span class="mono">degs</span> read defensively; each assumption shown with the data.</td></tr>
      <tr><td>Bad float levels</td><td class="why">{argo["levels_rejected"]} of {argo["levels"]:,} levels rejected by QC; drawn red, never dropped.</td></tr>
      <tr><td>Volume API is experimental</td><td class="why">Cesium version pinned exactly; re-tested on each upgrade.</td></tr>
      <tr><td>INCOIS TLS chain incomplete</td><td class="why">OS trust store, not disabled verification.</td></tr>
      <tr><td>Grid too large for a browser</td><td class="why">Display-only block mean, factor recorded; depth never resampled up.</td></tr>
      <tr><td>Copernicus needs an account</td><td class="why">INCOIS is the default and needs none; only currents use Copernicus.</td></tr>
      <tr><td>Unknown GPUs at INCOIS</td><td class="why">Quality tiers, chosen by measuring real frames on that machine.</td></tr>
      <tr><td>A cast with no model value</td><td class="why">Profile still drawn, with the reason printed; nothing filled in.</td></tr>
    </table>
  </div>
</div>
""")

    # ============================================================ 5 impact
    page("body-impact", f"""
<div class="cols grow" style="grid-template-columns: 1fr 1fr 1.05fr; gap: 70px">
  <div class="col">
    <h2 style="margin:0">For the cyclone forecaster</h2>
    <div class="card"><span class="num">{signed(tg["mean_difference_kj_cm2"])}</span><p>kJ/cm² —
      model minus measured <b>cyclone heat potential</b> along the independent glider track
      ({tg["with_d26"]} casts, one deployment; measured mean {n1(tg["mean_observed_kj_cm2"])}). Against
      Argo, which the model already absorbs: {signed(ta["mean_difference_kj_cm2"])}.</p></div>
    <ul class="points">
      <li><b>Fuel, in the unit already used</b><span>heat above 26 °C, per float and per glider cast</span></li>
      <li><b>20 °C isotherm in one click</b><span>the standard proxy for how deep the warm layer goes</span></li>
      <li><b>Model and truth side by side</b><span>no second program, no copying numbers between tools</span></li>
      <li><b>Confidence visible</b><span>uncertain water drawn faint; unmeasured water drawn empty</span></li>
    </ul>
    <h2 style="margin:6px 0 0">For INCOIS operations</h2>
    <ul class="points">
      <li><b>Search and rescue, fisheries, climate</b><span>currents and temperature at any depth, in the same view</span></li>
      <li><b>New instruments without re-engineering</b><span>drop a CSV of casts on the globe; it is paired with the model at once</span></li>
      <li><b>Open standards</b><span>WMS layers open in QGIS and national portals</span></li>
    </ul>
  </div>
  <div class="col">
    <h2 style="margin:0">For students, public and policy</h2>
    <div class="card green"><span class="num">{res["coverage_percent"]}%</span><p>of the Bay's
      water column had a measurement in this window. Shown honestly, that is itself the case
      for more floats — a sentence a policymaker can repeat.</p></div>
    <ul class="points">
      <li><b>True scale in one click</b><span>the Bay really is a film of water: {depth_km:g} km deep, {width_km:,} km wide. Then 40×, to read it</span></li>
      <li><b>From planet to profile</b><span>a simple globe, then the Bay in 3D, then fly over it, then one float's dive</span></li>
      <li><b>Runs in a school's browser</b><span>exhibitions, e-learning and outreach, as the brief asks</span></li>
      <li><b>Ask it in plain words</b><span>a built-in assistant answers from the data and moves the view for you</span></li>
    </ul>
    <h2 style="margin:6px 0 0">Where it goes next</h2>
    <ul class="points">
      <li><b>More regions and years</b><span>the region and window are configuration, not code</span></li>
      <li><b>More sensors</b><span>CTD, moorings, HF radar, ADCP: each one parser</span></li>
      <li><b>Machine-learning products</b><span>any gridded output renders as another volume</span></li>
    </ul>
  </div>
  <div class="col" style="gap:20px">
    <figure class="shot"><img src="shot-resid.png">
      <figcaption><b>Where the model is wrong.</b> Each block is a place someone measured, coloured
      by measured minus model (red warmer, blue colder). Everything else is empty on purpose:
      {empty_pct}% of the volume.</figcaption></figure>
    <figure class="shot"><img src="shot-simple.png">
      <figcaption><b>The Simple view, for everyone else.</b> The world's ocean one layer at a
      time — temperature, salinity, currents, sea level, mixed layer, ice — on a timeline.</figcaption></figure>
  </div>
</div>
""")

    # ============================================================ 6 references
    page("body-references", f"""
<div class="banner"><span>Source code, docs and every measured number:</span>
  <span class="mono">https://{REPO}</span>
  <span class="note">public repository · all links below opened 2026-09-23</span></div>
<div class="cols grow refcols" style="grid-template-columns: 1fr 1fr; gap: 90px">
  <div class="col" style="gap:10px">
    <h2 style="margin:0">Data we fetched — each one probed, not assumed</h2>
    <ol class="refs">
      <li>INCOIS ERDDAP — Argo 10-day variational analysis (<span class="mono">incois_argo_10d_VAM</span>), temperature and salinity with per-cell error. <span class="why">The primary volume; no credentials.</span><span class="url">erddap.incois.gov.in/erddap/griddap/incois_argo_10d_VAM.html</span></li>
      <li>Copernicus Marine — GLORYS12 global reanalysis, GLOBAL_MULTIYEAR_PHY_001_030. <span class="why">Currents, and the global surface layer.</span><span class="url">data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_PHY_001_030</span></li>
      <li>Argo Global Data Assembly Centre, HTTPS mirror. <span class="why">Float profiles with QC flags and data mode.</span><span class="url">data-argo.ifremer.fr</span></li>
      <li>U.S. IOOS Glider DAC — Rutgers <i>ru29</i> deployment, NetCDF and CSV. <span class="why">The independent check.</span><span class="url">gliders.ioos.us/erddap</span></li>
      <li>INCOIS Live Access Server. <span class="why">Named in the brief; reachable, not yet ingested.</span><span class="url">las.incois.gov.in/las</span></li>
      <li>The brief's two <span class="mono">ftp.ifremer.fr</span> links. <span class="why">Probed: do not connect (port 21). Replaced by 3.</span><span class="url">ftp://ftp.ifremer.fr/ifremer/argo · …/glider/v2</span></li>
      <li>Argo Program overview, Scripps Institution of Oceanography. <span class="why">What a float is and does.</span><span class="url">argo.ucsd.edu</span></li>
      <li>Smart India Hackathon 2026, problem statement 26067 (MoES / INCOIS Ocean Valley). <span class="why">Quoted verbatim in the repository.</span><span class="url">github.com/Kukyos/VVater/blob/main/docs/01-problem-statement.md</span></li>
    </ol>
    <div class="card grey" style="margin-top:6px"><h3>How these links were checked</h3><p>Every
      URL was opened on 2026-09-23 with a browser user agent and returned HTTP 200, except the two
      FTP links (dead, listed as such) and the AMS journal page, which refuses scripted requests;
      its DOI resolves.</p></div>
  </div>
  <div class="col" style="gap:10px">
    <h2 style="margin:0">Standards and methods the code follows</h2>
    <ol class="refs" style="counter-reset: ref 8">
      <li>Wong et al., Argo Quality Control Manual for CTD and Trajectory Data. <span class="why">Range test and QC flags.</span><span class="url">doi.org/10.13155/33951</span></li>
      <li>U.S. IOOS QARTOD manuals. <span class="why">Glider QC flags.</span><span class="url">ioos.noaa.gov/project/qartod</span></li>
      <li>NetCDF Climate and Forecast (CF) Conventions. <span class="why">Read defensively; assumptions recorded.</span><span class="url">cfconventions.org</span></li>
      <li>OGC Web Map Service 1.3.0. <span class="why">The WMS endpoint.</span><span class="url">ogc.org/standards/wms</span></li>
      <li>IOC, SCOR, IAPSO (2010), TEOS-10 seawater equation. <span class="why">Pressure to depth, heat capacity.</span><span class="url">teos-10.org</span></li>
      <li>Leipper &amp; Volgenau (1972), Hurricane heat potential of the Gulf of Mexico, J. Phys. Oceanogr. 2. <span class="why">Heat above 26 °C.</span><span class="url">doi.org/10.1175/1520-0485(1972)002&lt;0218:HHPOTG&gt;2.0.CO;2</span></li>
      <li>Thyng et al. (2016), True colors of oceanography, Oceanography 29(3). <span class="why">cmocean palettes.</span><span class="url">doi.org/10.5670/oceanog.2016.66</span></li>
      <li>CesiumJS <span class="mono">VoxelPrimitive</span> reference. <span class="why">The volume renderer (experimental, pinned).</span><span class="url">cesium.com/learn/cesiumjs/ref-doc/VoxelPrimitive.html</span></li>
      <li>xarray and FastAPI documentation. <span class="why">Ingest and API.</span><span class="url">docs.xarray.dev · fastapi.tiangolo.com</span></li>
      <li>Unidata NetCDF. <span class="why">The file format the brief names.</span><span class="url">unidata.ucar.edu/software/netcdf</span></li>
    </ol>
  </div>
</div>
""")


# ------------------------------------------------------------------ check

def check() -> None:
    """Every rendered body must be filled: no empty band at the bottom, where a short slide
    shows it first. The template's footer bar sits right under the body, so white space
    there reads as an unfinished slide."""
    from PIL import Image

    failed = []
    for name in BODIES:
        image = Image.open(FIGURES / f"{name}.png").convert("L")
        w, h = image.size
        pixels = image.load()
        last = 0
        for y in range(h - 1, -1, -1):
            if any(pixels[x, y] < 235 for x in range(0, w, 4)):
                last = y
                break
        gap = (h - 1 - last) / h
        print(f"{name}: content reaches {100 * (1 - gap):.1f}% of the height")
        if gap > 0.05:
            failed.append(name)
    if failed:
        raise SystemExit(f"empty band at the bottom of {failed}")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
