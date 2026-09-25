"""Write the five slide bodies as HTML, with every number read from the eval harness.

    python -m server.eval.run_eval --json    # first, to refresh data/eval-latest.json
    node submission/sih/capture.cjs          # the screenshots (see docs/16-submission.md)
    python submission/sih/figures.py         # -> figures/body-*.html
    python submission/sih/render.py          # -> figures/body-*.png
    python submission/sih/figures.py --check # every body filled, no empty bands
    python submission/sih/build.py           # -> final/VVater-SIH2026.pptx

The first rule in docs/00-start-here.md ("The one architectural rule") is that no figure
appears anywhere the harness did not produce. That rule is only real if the deck *reads*
the harness output rather than quoting it from memory, so every number below comes out of
`data/eval-latest.json` and a missing key is a crash rather than a plausible-looking wrong
number.

Who reads this: an evaluator who will not open the live site. Every slide carries a real
capture of the running build, and each caption says what the picture proves. The text is
points, not paragraphs.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIGURES = Path(__file__).resolve().parent / "figures"
EVAL = ROOT / "data" / "eval-latest.json"
REPO = "github.com/Kukyos/VVater"

# Captures from capture.cjs, and the crop of each that a slide shows: (left, top, right,
# bottom) in the capture's own pixels. Crops of real captures, never mock-ups.
CROPS = {
    "hero": ("shot-hero.png", (250, 120, 3092, 1560)),
    "floats": ("shot-float.png", (1200, 560, 3200, 1760)),
    "anywhere": ("shot-gulf.png", (0, 150, 3092, 1680)),
    "planet": ("shot-globe.png", (300, 0, 2800, 1400)),
    "assistant": ("shot-assistant.png", (600, 70, 3200, 1500)),
    "before": ("shot-amphan-before.png", (200, 0, 2892, 1680)),
    "after": ("shot-amphan-after.png", (200, 0, 2892, 1680)),
    "learn": ("shot-learn.png", (0, 70, 3200, 1760)),
    "fishing": ("shot-fishing.png", (0, 70, 3200, 1760)),
    "immersive": ("shot-immersive.png", (160, 180, 3040, 1680)),
    "residual": ("shot-residual.png", (0, 200, 3092, 1600)),
}
BODIES = ["body-solution", "body-technical", "body-feasibility", "body-impact",
          "body-references"]


def n2(value) -> str:
    return f"{float(value):.2f}"


def n1(value) -> str:
    return f"{float(value):.1f}"


def signed(value, digits=1) -> str:
    return f"{float(value):+.{digits}f}".replace("-", "&#8722;")


def crops() -> None:
    from PIL import Image
    for name, (shot, box) in CROPS.items():
        # JPEG: the Canva copy embeds these as they are, and PNG made it 32 MB.
        Image.open(FIGURES / shot).convert("RGB").crop(box).save(
            FIGURES / f"crop-{name}.jpg", quality=90)


def load() -> dict:
    if not EVAL.exists():
        raise SystemExit(
            f"missing {EVAL.relative_to(ROOT)}. Run: python -m server.eval.run_eval --json"
        )
    missing = sorted({s for s, _ in CROPS.values() if not (FIGURES / s).exists()})
    if missing:
        raise SystemExit(f"missing screenshots {missing}; run submission/sih/capture.cjs")
    e = json.loads(EVAL.read_text(encoding="utf-8"))
    if "v2" not in e or "unavailable" in e["v2"].get("catalog", {}) or "hosting" not in e["v2"]:
        raise SystemExit("eval-latest.json has no complete v2 section; rerun the harness "
                         "with the network up, after python -m server.tools.measure_hosting")
    return e


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


def flowchart(v2: dict) -> str:
    """How a cube is made, and what happens to data that fails a test.

    The left lane is the cube generator: only the ARCO chunks a box touches are read. The
    right lane is the floats. Diamonds are decisions the code makes; the red and amber
    branches are where most tools quietly drop a reading or paint over it.
    """
    cat = v2["catalog"]
    W, H = 2260, 1440
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
            s.append(f'<text x="{cx}" y="{top + i * 44}" font-size="35" font-weight="600" text-anchor="middle" fill="#16202B">{line}</text>')

    def arrow(points, label=None, at=None, colour="#4F5B69"):
        pts = " ".join(f"{x},{y}" for x, y in points)
        s.append(f'<polyline points="{pts}" fill="none" stroke="{colour}" stroke-width="3.5" marker-end="url(#a)"/>')
        if label:
            lx, ly = at
            s.append(f'<text x="{lx}" y="{ly}" font-size="34" font-weight="600" fill="{colour}">{label}</text>')

    # ---- the cube lane
    L, BW = 0, 900
    cx = L + BW / 2
    box(L, 0, BW, 170, "1  You ask: box · day · variable",
        [f"anywhere, {cat['first_day'][:4]} to {cat['last_day']}, {cat['variables']} variables",
         "by hand, by a named scenario, or by the assistant"])
    arrow([(cx, 170), (cx, 214)])
    diamond(cx, 306, 560, 184, ["Reanalysis covers", "that day?"])
    arrow([(cx + 280, 306), (BW + 50, 306)], "no", (cx + 300, 292), "#B9770E")
    box(BW + 50, 238, 560, 136, "Analysis & forecast", ["labelled forecast on screen"],
        fill="#FEF5E7", edge="#B9770E")
    arrow([(cx, 398), (cx, 446)], "yes", (cx + 16, 432))
    box(L, 446, BW, 210, "2  Read only the chunks the box touches",
        ["Copernicus ARCO zarr stores on S3,", "cached on disk: no copy of the ocean,",
         "a day seen once opens from the cache"])
    # the chunk idea, drawn: the store's grid, the box, the chunks actually read
    gx, gy, cs = BW + 70, 452, 44
    for i in range(10):
        for j in range(5):
            hit = 3 <= i <= 6 and 1 <= j <= 3
            s.append(f'<rect x="{gx + i * cs}" y="{gy + j * cs}" width="{cs - 4}" height="{cs - 4}" '
                     f'fill="{"#2E86C1" if hit else "#E6ECF3"}"/>')
    s.append(f'<rect x="{gx + 3 * cs + 18}" y="{gy + cs + 12}" width="{3 * cs + 6}" height="{2 * cs + 12}" '
             f'fill="none" stroke="#C0392B" stroke-width="5"/>')
    s.append(f'<text x="{gx}" y="{gy + 5 * cs + 34}" font-size="32" fill="#4F5B69">'
             f'<tspan fill="#C0392B" font-weight="600">box</tspan> · '
             f'<tspan fill="#2E86C1" font-weight="600">chunks read</tspan></text>')
    arrow([(cx, 656), (cx, 700)])
    box(L, 700, BW, 170, "3  Native levels only, then derived fields",
        ["never more depth levels than the model has", "TEOS-10 density and speed of sound"])
    arrow([(cx, 870), (cx, 914)])
    diamond(cx, 1006, 560, 184, ["Value inside the", "published range?"])
    arrow([(cx + 280, 1006), (BW + 50, 1006)], "no", (cx + 300, 992), "#C0392B")
    box(BW + 50, 938, 560, 136, "Masked and counted", ["in the provenance panel"],
        fill="#FDEDEC", edge="#C0392B")
    arrow([(cx, 1098), (cx, 1142)], "yes", (cx + 16, 1128))
    box(L, 1142, BW, 124, "4  float32 cube → six painted faces", [])
    s.append(f'<text x="{L + 30}" y="{1142 + 96}" font-size="34" fill="#4F5B69">each face a section through the data</text>')

    # ---- the float lane
    R, RW = 1620, W - 1620
    rcx = R + RW / 2
    box(R, 0, RW, 170, "Floats in the box", ["Ifremer Argo ERDDAP,", "core and BGC, ±2 days"],
        fill="#EAF2FB", edge="#2E86C1")
    arrow([(rcx, 170), (rcx, 214)])
    diamond(rcx, 306, 560, 184, ["Level passes", "its QC flag?"])
    arrow([(rcx, 398), (rcx, 446)], "no", (rcx + 16, 432), "#C0392B")
    box(R, 446, RW, 136, "Drawn red", ["kept, never dropped"], fill="#FDEDEC", edge="#C0392B")
    arrow([(rcx, 582), (rcx, 700)], "kept", (rcx + 16, 650), "#C0392B")
    arrow([(rcx - 280, 306), (R - 20, 306), (R - 20, 700), (R, 700)], "yes", (R - 90, 290))
    box(R, 700, RW, 210, "Stick in the cube", ["coloured on the cube's bar;",
                                                "click: co-located with the", "model on its own day"],
        fill="#EAF2FB", edge="#2E86C1")
    arrow([(rcx, 910), (rcx, 1330)])

    # ---- everything lands in the API and the browser
    y = 1330
    box(0, y, W, 110, "", [], fill="#1F4E79", edge="#1F4E79")
    s.append(f'<text x="30" y="{y + 70}" font-size="38" font-weight="600" fill="#FFFFFF">5  FastAPI → CesiumJS in any browser'
             f'<tspan font-weight="400" fill="#CFE3F5">   ·  Region 3D · Map 2D · Globe · Fly · Immersive · Learn · Assistant</tspan></text>')
    arrow([(cx, 1266), (cx, y)])
    s.append("</svg>")
    return "".join(s)


# ------------------------------------------------------------------ slides

def main() -> None:
    FIGURES.mkdir(parents=True, exist_ok=True)
    e = load()
    crops()

    bands = e["depth_bands"]
    shallow = bands["0-300 m"]
    res, field, argo, glider = e["residual"], e["field"], e["argo"], e["glider"]
    rng, tchp = e["field_range_test"], e["tchp"]
    ta, tg = tchp["argo"], tchp["glider"]
    v2 = e["v2"]
    cat, host = v2["catalog"], v2["hosting"]
    before, after, casts = v2["amphan_before"], v2["amphan_after"], v2["amphan_before_casts"]
    empty_pct = f"{100 - float(res['coverage_percent']):.0f}"

    # ============================================================ 2 solution
    page("body-solution", f"""
<p class="lead" style="font-size:56px">Cut a block out of the ocean <b>anywhere on Earth, on any day
since {cat["first_day"][:4]}</b>, and look at it from the side, with the real Argo floats
standing inside it. In any browser.</p>
<div class="cols grow" style="grid-template-columns: 2280px 1fr; gap: 80px">
  <figure class="shot hero">
    <img src="crop-hero.jpg">
    <figcaption><b>The Bay of Bengal on {before["day"]}, two days before Cyclone Amphan formed</b>,
    cut open to 1,000 m. The warm lid, the thermocline under it and the cold water below are
    drawn on the model's own {before["levels"]} depth levels. Each dashed stick is an Argo float that
    surfaced within two days, coloured by what it measured ({casts["found"]} floats; a level that
    fails QC is drawn red, never dropped). Model: Copernicus GLORYS12, 1/12°.</figcaption>
  </figure>
  <div class="col" style="gap:16px">
    <h2 style="margin:0">The gap the brief names</h2>
    <ul class="points tight">
      <li><b>Tools are flat 2D or desktop-bound</b><span>a cyclone feeds on a warm layer tens of metres thick; a map cannot show it</span></li>
      <li><b>Model and instruments live apart</b><span>forecasters toggle between packages to compare them</span></li>
    </ul>
    <h2 style="margin:10px 0 0">What is new</h2>
    <div class="tiles">
      <figure><img src="crop-anywhere.jpg"><figcaption><b>Any ocean, any day</b>{cat["variables"]} variables, physics and biogeochemistry. Here the Gulf Stream.</figcaption></figure>
      <figure><img src="crop-floats.jpg"><figcaption><b>Floats inside the model</b>click one: its dive against the model, with QC, data mode and file</figcaption></figure>
      <figure><img src="crop-planet.jpg"><figcaption><b>One colour bar for the planet</b>the globe in the cube's colours, currents and winds flowing</figcaption></figure>
      <figure><img src="crop-assistant.jpg"><figcaption><b>Ask it, and it acts</b>"make a cube of oxygen in the Arabian Sea": built, and the control ringed</figcaption></figure>
    </div>
  </div>
</div>
""")

    # ============================================================ 3 technical
    rows = [
        ("3D volume, depth slices, time steps", "cube faces as sections, cut planes, a day-by-day timeline; the INCOIS voxel volume"),
        ("Isosurface", "20 °C isotherm, one click (INCOIS Bay volume)"),
        ("Argo, glider, BGC, click for a profile", "core and BGC floats, a glider, CSV casts; profile against the model"),
        ("NetCDF and delimited-text parsers", "xarray, and a text reader checked cast for cast against the NetCDF path"),
        ("Colour bar editor", "palette, min/max, linear or log"),
        ("Opacity, vertical exaggeration", "both sliders, the stretch printed on screen"),
        ("REST API, no client install", "FastAPI; the browser is the whole client"),
        ("Open standards", "OGC WMS; CF read defensively. WCS not built"),
        ("New sensors, variables, ML products", "one parser function and one config line each"),
        ("Outreach and e-learning", "a six-lesson course, immersive view, cinematic tour"),
    ]
    table = "".join(f'<tr><td>{a}</td><td class="why">{b}</td></tr>' for a, b in rows)
    page("body-technical", f"""
<div class="cols grow" style="grid-template-columns: 2260px 1fr; gap: 90px">
  <div class="col" style="gap:14px">
    <h2 style="margin:0">How a cube is made, and what happens to data that fails a test</h2>
    {flowchart(v2)}
  </div>
  <div class="col" style="gap:14px">
    <h2 style="margin:0">The brief, line by line</h2>
    <table class="brief"><tr><th>The brief asks for</th><th>Built as</th></tr>{table}</table>
    <p class="stack"><b>Stack</b> CesiumJS · TypeScript + Vite · Python FastAPI + xarray ·
    Copernicus ARCO · INCOIS and Ifremer ERDDAP · OGC WMS · an LLM that can only reach the data
    through our own API</p>
  </div>
</div>
""")

    # ============================================================ 4 feasibility
    page("body-feasibility", f"""
<div class="stats" style="grid-template-columns: repeat(4, 1fr); gap: 60px">
  <div class="stat"><b>{cat["variables"]}</b><span>variables, every day from {cat["first_day"]} to {cat["last_day"]}, forecast days labelled</span></div>
  <div class="stat"><b>{before["open_seconds_disk_cache"]} s</b><span>to open the Amphan cube from the disk cache ({before["payload_mb"]} MB to the browser)</span></div>
  <div class="stat"><b>{host["peak_mb"]} MB</b><span>peak memory over a full cold session: {host["requests_ok"]} of {host["requests"]} requests answered</span></div>
  <div class="stat"><b>{argo["profiles"]} + {glider["casts"]}</b><span>Argo profiles and glider casts co-located with the INCOIS model</span></div>
</div>
<div class="cols grow feas" style="grid-template-columns: 1.05fr 1fr; gap: 100px">
  <div class="col" style="gap:12px">
    <h2 style="margin:0">Measured finding: model error by depth</h2>
    {band_chart(bands, width=1900, height=1110)}
    <div class="legend"><i style="background:#A9B2BE"></i>Argo (the model already used them)
      <i style="background:#1F4E79"></i>Glider (independent)</div>
    <p style="font-size:37px" class="muted">Below 300 m the INCOIS model and the instruments agree.
    In the top 300 m, the warm layer a cyclone feeds on, the independent glider finds an error of
    <b class="red">{n2(shallow["glider"]["rmse"])} °C</b>. A single pooled number hides it; the 3D
    view shows it.</p>
  </div>
  <div class="col" style="gap:12px">
    <h2 style="margin:0">Risks we hit, and what we did</h2>
    <table class="risks">
      <tr><td>The brief's data links are dead</td><td class="why">Both are <span class="mono">ftp://</span> and blocked; replaced with tested HTTPS sources.</td></tr>
      <tr><td>The model fails QC too</td><td class="why">{rng["failed"]} INCOIS cells read above 40 °C at depth; masked and counted, reported.</td></tr>
      <tr><td>Bad float readings</td><td class="why">{argo["levels_rejected"]} of {argo["levels"]:,} levels fail QC in the Bay; drawn red, never dropped.</td></tr>
      <tr><td>An AI that invents numbers</td><td class="why">It reaches data only through our API; an untraceable number is flagged on screen.</td></tr>
      <tr><td>A small host ran out of memory</td><td class="why">Shared S3 client and capped caches; we ask for 1 GB, measured {host["peak_mb"]} MB peak.</td></tr>
    </table>
    <figure class="shot"><img src="crop-residual.jpg" style="height:660px; object-fit:cover">
      <figcaption><b>Where the INCOIS model is wrong.</b> Each block is a place someone measured,
      coloured by measured minus model. Unmeasured water stays empty: {empty_pct}% of it.</figcaption></figure>
  </div>
</div>
""")

    # ============================================================ 5 impact
    page("body-impact", f"""
<div class="cols grow" style="grid-template-columns: 1.25fr 1fr 1fr 1fr; gap: 60px">
  <div class="col aud">
    <h2>Cyclone forecasters</h2>
    <div class="pair"><figure><img src="crop-before.jpg"><figcaption>{before["day"]}</figcaption></figure>
      <figure><img src="crop-after.jpg"><figcaption>{after["day"]}</figcaption></figure></div>
    <p class="cap"><b>Amphan's cold wake.</b> The same Bay, before and after landfall, on one
    28–31.5 °C bar: the surface mean fell {n2(v2["amphan_cooling_c"])} °C.</p>
    <ul class="points">
      <li><b>{signed(tg["mean_difference_kj_cm2"])} kJ/cm²</b><span>model minus measured cyclone heat potential on the independent glider track</span></li>
      <li><b>Forecast days, labelled</b><span>the cube runs to {cat["last_day"]}</span></li>
    </ul>
  </div>
  <div class="col aud">
    <h2>Fishermen</h2>
    <figure class="shot"><img src="crop-fishing.jpg" style="object-position: 0% 50%"></figure>
    <p class="cap"><b>INCOIS's own Potential Fishing Zone advisories</b>, read as published for all
    fourteen sectors, next to an indicative zone layer with today's sea state.</p>
    <ul class="points">
      <li><b>Official first</b><span>the indicator is labelled "not an advisory" everywhere</span></li>
    </ul>
  </div>
  <div class="col aud">
    <h2>Students</h2>
    <figure class="shot"><img src="crop-learn.jpg" style="object-position: 0% 100%"></figure>
    <p class="cap"><b>Six lessons for class 8–12</b> on real data: your nearest sea, the ocean's
    layers, the monsoon current, Amphan, Argo floats.</p>
    <ul class="points">
      <li><b>Answers from the cube on screen</b><span>quizzes are checked against the data, never by the language model</span></li>
    </ul>
  </div>
  <div class="col aud">
    <h2>Public and outreach</h2>
    <figure class="shot"><img src="crop-immersive.jpg"></figure>
    <p class="cap"><b>Immersive view and a cinematic tour</b>: the planet's currents and winds on
    one day, for exhibitions and awareness campaigns.</p>
    <ul class="points">
      <li><b>One link, no install</b><span>a school's browser is enough</span></li>
    </ul>
  </div>
</div>
<div class="next"><b>Next</b><span>CTD, moorings, HF radar and ADCP as parsers</span><span>machine-learning fields as more variables</span><span>class results for teachers</span><span>a copy on INCOIS servers</span></div>
""")

    # ============================================================ 6 references
    page("body-references", f"""
<div class="banner"><span>Source code, docs and every measured number:</span>
  <span class="mono">https://{REPO}</span>
  <span class="note">public repository · links below opened 2026-09-25</span></div>
<div class="cols grow refcols" style="grid-template-columns: 1fr 1fr 1fr; gap: 70px">
  <div class="col" style="gap:8px">
    <h2 style="margin:0">Data, each source probed</h2>
    <ol class="refs">
      <li>Copernicus Marine GLORYS12 reanalysis and global analysis &amp; forecast, physics and PISCES biogeochemistry, read as ARCO stores. <span class="why">The cube.</span><span class="url">data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_PHY_001_030</span></li>
      <li>INCOIS ERDDAP, Argo 10-day variational analysis with per-cell error. <span class="why">The Bay volume.</span><span class="url">erddap.incois.gov.in/erddap</span></li>
      <li>Ifremer Argo ERDDAP, core and synthetic BGC floats. <span class="why">Floats anywhere.</span><span class="url">erddap.ifremer.fr/erddap</span></li>
      <li>Argo GDAC, HTTPS mirror. <span class="why">Float files, QC flags, data mode.</span><span class="url">data-argo.ifremer.fr</span></li>
      <li>U.S. IOOS Glider DAC, Rutgers <i>ru29</i>. <span class="why">The independent check.</span><span class="url">gliders.ioos.us/erddap</span></li>
      <li>INCOIS Potential Fishing Zone advisories. <span class="why">Read as published.</span><span class="url">incois.gov.in/MarineFisheries/TextDataHome?mfid=1</span></li>
      <li>NCEP GFS 10 m wind via UCAR THREDDS. <span class="why">Wind forecast.</span><span class="url">thredds.ucar.edu</span></li>
      <li>NASA GIBS Blue Marble relief. <span class="why">Land.</span><span class="url">gibs.earthdata.nasa.gov</span></li>
      <li>The brief's two <span class="mono">ftp.ifremer.fr</span> links. <span class="why">Do not connect; replaced by 3 and 4.</span></li>
    </ol>
  </div>
  <div class="col" style="gap:8px">
    <h2 style="margin:0">Standards and methods</h2>
    <ol class="refs" style="counter-reset: ref 9">
      <li>Wong et al., Argo Quality Control Manual. <span class="why">QC flags, range test.</span><span class="url">doi.org/10.13155/33951</span></li>
      <li>U.S. IOOS QARTOD manuals. <span class="why">Glider QC.</span><span class="url">ioos.noaa.gov/project/qartod</span></li>
      <li>CF Conventions for NetCDF. <span class="why">Read defensively.</span><span class="url">cfconventions.org</span></li>
      <li>OGC Web Map Service 1.3.0. <span class="why">The WMS endpoint.</span><span class="url">ogc.org/standards/wms</span></li>
      <li>IOC, SCOR, IAPSO (2010), TEOS-10. <span class="why">Density, sound speed.</span><span class="url">teos-10.org</span></li>
      <li>Leipper &amp; Volgenau (1972), J. Phys. Oceanogr. 2. <span class="why">Heat above 26 °C.</span><span class="url">doi.org/10.1175/1520-0485(1972)002&lt;0218:HHPOTG&gt;2.0.CO;2</span></li>
      <li>Thyng et al. (2016), Oceanography 29(3). <span class="why">cmocean palettes.</span><span class="url">doi.org/10.5670/oceanog.2016.66</span></li>
      <li>CesiumJS. <span class="why">The globe and renderer.</span><span class="url">cesium.com/platform/cesiumjs</span></li>
    </ol>
  </div>
  <div class="col" style="gap:8px">
    <h2 style="margin:0">What the course cites</h2>
    <ol class="refs" style="counter-reset: ref 17">
      <li>Gray (1968), Mon. Weather Rev. 96, 669–700. <span class="why">Cyclones need water above ~26 °C.</span></li>
      <li>Price (1981), J. Phys. Oceanogr. 11, 153–175. <span class="why">A cyclone cools the sea.</span></li>
      <li>Schott &amp; McCreary (2001), Prog. Oceanogr. 51, 1–123. <span class="why">The monsoon current reverses.</span></li>
      <li>India Meteorological Department, report on Super Cyclonic Storm Amphan (2020). <span class="why">Landfall, 20 May.</span></li>
      <li>WMO Guide to Wave Analysis and Forecasting (WMO-No. 702). <span class="why">Wind makes waves.</span></li>
      <li>Argo Program, "How Argo floats work". <span class="why">Floats.</span><span class="url">argo.ucsd.edu</span></li>
      <li>SIH 2026 problem statement 26067, quoted verbatim. <span class="url">{REPO}/blob/main/docs/01-problem-statement.md</span></li>
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
