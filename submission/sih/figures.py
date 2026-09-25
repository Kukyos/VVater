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
    W, H = 2260, 1560
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

    # ---- the cube lane (server)
    L, BW = 0, 900
    cx = L + BW / 2
    box(L, 0, BW, 170, "1  You ask: box · day · variable",
        [f"anywhere; {cat['variables']} variables, {cat['from_first_day']} of them from {cat['first_day'][:4]}",
         "by hand, by a named scenario, or by the assistant"])
    arrow([(cx, 170), (cx, 214)])
    diamond(cx, 306, 560, 184, ["Reanalysis covers", "that day?"])
    arrow([(cx + 280, 306), (BW + 50, 306)], "no", (cx + 300, 292), "#B9770E")
    box(BW + 50, 238, 560, 136, "Analysis & forecast", ["labelled forecast on screen"],
        fill="#FEF5E7", edge="#B9770E")
    # the forecast branch rejoins: the same chunk reader serves both stores
    arrow([(BW + 330, 374), (BW + 330, 420), (cx + 60, 420), (cx + 60, 446)])
    arrow([(cx, 398), (cx, 446)], "yes", (cx - 80, 432))
    box(L, 446, BW, 210, "2  Read only the chunks the box touches",
        ["Copernicus ARCO zarr stores on S3,", "cached on disk: no copy of the ocean,",
         "a day seen once opens from the cache"])
    # the chunk idea, drawn: the store's grid, the box, the chunks actually read
    gx, gy, cs = BW + 70, 470, 40
    for i in range(10):
        for j in range(5):
            hit = 3 <= i <= 6 and 1 <= j <= 3
            s.append(f'<rect x="{gx + i * cs}" y="{gy + j * cs}" width="{cs - 4}" height="{cs - 4}" '
                     f'fill="{"#2E86C1" if hit else "#E6ECF3"}"/>')
    s.append(f'<rect x="{gx + 3 * cs + 16}" y="{gy + cs + 10}" width="{3 * cs + 6}" height="{2 * cs + 12}" '
             f'fill="none" stroke="#C0392B" stroke-width="5"/>')
    s.append(f'<text x="{gx}" y="{gy + 5 * cs + 34}" font-size="32" fill="#4F5B69">'
             f'<tspan fill="#C0392B" font-weight="600">box</tspan> · '
             f'<tspan fill="#2E86C1" font-weight="600">chunks read</tspan></text>')
    arrow([(cx, 656), (cx, 700)])
    diamond(cx, 792, 560, 184, ["Published range", "for this variable?"])
    arrow([(cx + 280, 792), (BW + 50, 792)], "fails", (cx + 296, 778), "#C0392B")
    box(BW + 50, 724, 560, 136, "Masked and counted", ["in the provenance panel"],
        fill="#FDEDEC", edge="#C0392B")
    arrow([(cx, 884), (cx, 928)], "passes, or none published", (cx + 16, 914))
    box(L, 928, BW, 210, "3  Native depth levels, never more",
        [f"block-averaged across to ≤160 cells a side;", "TEOS-10 density and speed of sound;",
         "sent as raw float32"])
    arrow([(cx, 1138), (cx, 1182)])
    box(L, 1182, BW, 124, "4  Browser: CesiumJS paints six faces", [])
    s.append(f'<text x="{L + 30}" y="{1182 + 96}" font-size="34" fill="#4F5B69">each face a section; cut any side inwards</text>')

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
    box(R, 700, RW, 210, "Stick in the cube", ["on the cube's colour bar;",
                                                "click: compared with the", "model on its own day"],
        fill="#EAF2FB", edge="#2E86C1")
    arrow([(rcx, 910), (rcx, 1182), (L + BW + 8, 1244)])

    # ---- what the browser then offers
    y = 1440
    box(0, y, W, 110, "", [], fill="#1F4E79", edge="#1F4E79")
    s.append(f'<text x="30" y="{y + 70}" font-size="40" font-weight="600" fill="#FFFFFF">5  On screen'
             f'<tspan font-weight="400" fill="#CFE3F5">   Region 3D · Map 2D · Globe · Fly · Immersive · Learn · Assistant</tspan></text>')
    arrow([(cx, 1306), (cx, y)])
    s.append("</svg>")
    return "".join(s)


def architecture(host: dict) -> str:
    """The build, three tiers: what runs in the browser, on our one server, and at the
    data's owners. Versions are the pinned ones (viewer/package.json,
    server/requirements.txt)."""
    W, H = 1430, 1560
    s = [f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         '<defs><marker id="b" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
         '<path d="M0 0L10 5L0 10z" fill="#4F5B69"/></marker></defs>']

    def tier(y, h, title, sub, items, fill, edge):
        s.append(f'<rect x="0" y="{y}" width="{W}" height="{h}" fill="{fill}" stroke="{edge}" stroke-width="3"/>')
        s.append(f'<rect x="0" y="{y}" width="12" height="{h}" fill="{edge}"/>')
        s.append(f'<text x="36" y="{y + 54}" font-size="42" font-weight="600" fill="#16202B">{title}'
                 f'<tspan font-size="33" font-weight="400" fill="#4F5B69">  {sub}</tspan></text>')
        for i, (name, what) in enumerate(items):
            yy = y + 116 + i * 60
            s.append(f'<text x="36" y="{yy}" font-size="37" fill="#4F5B69"><tspan font-weight="600" fill="#1F4E79">{name}</tspan>  {what}</text>')

    def link(y, label):
        s.append(f'<line x1="120" x2="120" y1="{y}" y2="{y + 86}" stroke="#4F5B69" stroke-width="4" '
                 f'marker-start="url(#b)" marker-end="url(#b)"/>')
        s.append(f'<text x="160" y="{y + 54}" font-size="33" font-weight="600" fill="#4F5B69">{label}</text>')

    tier(0, 400, "Browser", "any modern browser, nothing installed", [
        ("CesiumJS 26", "3D globe, voxel volume, the cube's faces"),
        ("TypeScript 5.9 + Vite 7", "the viewer, no UI framework"),
        ("Canvas 2D overlay", "currents and winds as moving particles"),
        ("Cesium ion (optional)", "world terrain and imagery for Fly"),
        ("Static files", "served from any web host (Vercel today)"),
    ], "#EAF2FB", "#2E86C1")
    link(406, "REST: JSON, raw float32 volumes, OGC WMS (Bay layers)")
    tier(498, 560, "API server", "one Python 3.14 process", [
        ("FastAPI + Uvicorn", "cubes, floats, surface, wind, fishing, chat"),
        ("xarray · netCDF4 · dask", "NetCDF and zarr, read lazily"),
        ("numpy · scipy · gsw", "regrid, streamlines, TEOS-10 seawater"),
        ("Copernicus toolbox + S3", "only the chunks a request needs"),
        ("Disk chunk cache", f"measured {host['peak_mb']} MB peak RAM; ask for 1 GB"),
        ("LLM via AIRouter", "tools call our own API, nothing else"),
        ("truststore", "TLS always verified, against the OS store"),
    ], "#F1F4F8", "#1F4E79")
    link(1064, "HTTPS only, no credentials for the defaults")
    tier(1156, 404, "Data, fetched on demand", "nothing copied in advance", [
        ("Copernicus Marine", "ARCO zarr on S3: physics, biogeochemistry, waves"),
        ("ERDDAP", "INCOIS analysis · Ifremer Argo · IOOS gliders"),
        ("INCOIS PFZ", "fishing advisories, as published"),
        ("UCAR THREDDS · NASA GIBS", "GFS wind forecast · land relief"),
        ("Open-Meteo", "place names for the course"),
    ], "#FEF5E7", "#B9770E")
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
    rng, tchp, coloc = e["field_range_test"], e["tchp"], e["colocation"]
    ta, tg = tchp["argo"], tchp["glider"]
    v2 = e["v2"]
    cat, host = v2["catalog"], v2["hosting"]
    before, after, casts = v2["amphan_before"], v2["amphan_after"], v2["amphan_before_casts"]
    empty_pct = f"{100 - float(res['coverage_percent']):.0f}"

    # ============================================================ 2 solution
    # The template's pointers for this slide are the headings: proposed solution,
    # detailed explanation, how it addresses the problem, innovation and uniqueness.
    gaps = [
        ("No browser-based 3D, depth-resolved view of model fields",
         "a block of any box and day, cut open, in any browser; the INCOIS analysis as a true 3D volume"),
        ("Argo and glider profiles not shown alongside model fields",
         "floats stand inside the model as sticks; click one for its profile against the model"),
        ("No controls for variable, depth slice, time step, colour bar",
         f"{cat['variables']} variables, cut planes, a day-by-day timeline, palette, range and log scale"),
        ("New data streams need re-engineering",
         "a new variable is one catalogue line; CSV casts drop onto the globe"),
        ("No tools for rapid understanding and decisions",
         "an assistant that builds the view you ask for; fishing advisories; cyclone heat"),
    ]
    rows = "".join(f'<li><b>{g}</b><span>{a}</span></li>' for g, a in gaps)
    page("body-solution", f"""
<div class="cols grow" style="grid-template-columns: 1560px 1180px 1fr; gap: 70px">
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Proposed solution</h2>
    <p class="pitch">A browser platform that cuts a <b>3D block out of the ocean model, anywhere,
    on any day from {cat["first_day"][:4]} to the forecast</b>, and stands the real Argo floats inside it.</p>
    <figure class="shot"><img src="crop-hero.jpg" style="height:820px; object-fit:cover">
      <figcaption><b>Working prototype, captured.</b> The Bay of Bengal on {before["day"]}, before
      Cyclone Amphan, cut open to 1,000 m on the model's {v2["hero"]["levels"]} native depth levels; each
      dashed stick is one of {casts["found"]} Argo floats within two days.</figcaption></figure>
    <h3 class="sub">In detail</h3>
    <ul class="points tight">
      <li><b>Model:</b> Copernicus GLORYS12 and PISCES, read from the cloud; the INCOIS Argo analysis for the Bay</li>
      <li><b>Instruments:</b> Argo core and BGC floats, gliders, your own CSV casts, each with its QC state and source file</li>
      <li><b>Views:</b> Region 3D, Map 2D, Globe, Fly, immersive; winds, waves, currents, fishing zones</li>
    </ul>
  </div>
  <div class="col" style="gap:14px">
    <h2 style="margin:0">How it addresses the problem</h2>
    <p class="muted" style="font-size:34px">The five gaps the problem statement lists, and our answer to each.</p>
    <ul class="points gaps">{rows}</ul>
    <div class="card grey" style="margin-top:auto"><h3>Also asked for by name, and built</h3><p>Isosurface
      (the 20 °C isotherm, Bay volume) · layer opacity · vertical exaggeration · NetCDF and text
      parsers · REST API · OGC WMS for the Bay layers</p></div>
  </div>
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Innovation and uniqueness</h2>
    <ul class="points tight inno">
      <li><b>Floats inside the model</b><span>where model and float disagree, the colours differ on the same wall</span></li>
      <li><b>No archive to build</b><span>reads only the chunks a box needs from Copernicus's cloud stores</span></li>
      <li><b>The model is checked too</b><span>impossible values masked and counted; INCOIS error drawn faint</span></li>
      <li><b>An assistant that acts</b><span>builds cubes and sets controls; numbers it cannot trace are flagged</span></li>
      <li><b>A course on live data</b><span>six lessons whose quiz answers are read from the cube on screen</span></li>
    </ul>
    <div class="pair2">
      <figure><img src="crop-floats.jpg"><figcaption>a float's profile vs model</figcaption></figure>
      <figure><img src="crop-assistant.jpg"><figcaption>asked, the assistant built it</figcaption></figure>
    </div>
  </div>
</div>
""")

    # ============================================================ 3 technical
    page("body-technical", f"""
<div class="cols grow" style="grid-template-columns: 2260px 1fr; gap: 90px">
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Methodology and process: how a cube is made</h2>
    {flowchart(v2)}
  </div>
  <div class="col" style="gap:14px">
    <h2 style="margin:0">Technologies to be used</h2>
    {architecture(host)}
  </div>
</div>
""")

    # ============================================================ 4 feasibility
    page("body-feasibility", f"""
<h2 style="margin:0">Analysis of feasibility: it is built, and measured</h2>
<div class="stats" style="grid-template-columns: repeat(4, 1fr); gap: 60px">
  <div class="stat"><b>{cat["variables"]}</b><span>variables to {cat["last_day"]}, forecast days labelled; {cat["from_first_day"]} of them every day from {cat["first_day"][:4]}</span></div>
  <div class="stat"><b>{before["open_seconds_disk_cache"]} s</b><span>to open the Amphan cube from the disk cache ({before["payload_mb"]} MB to the browser)</span></div>
  <div class="stat"><b>{host["peak_mb"]} MB</b><span>peak memory over a full cold session: {host["requests_ok"]} of {host["requests"]} requests answered</span></div>
  <div class="stat"><b>{coloc["profiles_compared"]} + {coloc["glider_casts_compared"]}</b><span>Argo profiles and glider casts co-located with the INCOIS model, level by level</span></div>
</div>
<div class="cols grow feas" style="grid-template-columns: 1.05fr 1fr; gap: 100px">
  <div class="col" style="gap:12px">
    <h3 class="sub" style="margin:0">What the platform found: INCOIS model error by depth</h3>
    {band_chart(bands, width=1900, height=1010)}
    <div class="legend"><i style="background:#A9B2BE"></i>Argo (the model already used them)
      <i style="background:#1F4E79"></i>Glider (independent)</div>
    <p style="font-size:37px" class="muted">Below 300 m the INCOIS model and the instruments agree.
    In the top 300 m, the warm layer a cyclone feeds on, the independent glider finds an error of
    <b class="red">{n2(shallow["glider"]["rmse"])} °C</b>. A single pooled number hides it; the 3D
    view shows it.</p>
  </div>
  <div class="col" style="gap:12px">
    <h2 style="margin:0">Challenges and risks, and our strategies</h2>
    <table class="risks">
      <tr><th>Challenge or risk</th><th>Strategy, already in the build</th></tr>
      <tr><td>The problem statement's data links are dead</td><td class="why">Both are <span class="mono">ftp://</span> and blocked; replaced with tested HTTPS sources.</td></tr>
      <tr><td>The model fails QC too</td><td class="why">{rng["failed"]} INCOIS cells read above 40 °C at depth; masked, counted in the provenance panel.</td></tr>
      <tr><td>Bad float readings</td><td class="why">{argo["levels_rejected"]} of {argo["levels"]:,} levels fail QC in the Bay; drawn red, never dropped.</td></tr>
      <tr><td>An assistant could invent numbers</td><td class="why">It reaches data only through our API; an untraceable number is flagged on screen.</td></tr>
      <tr><td>A small host ran out of memory</td><td class="why">Shared S3 client and capped caches; we ask for 1 GB, measured {host["peak_mb"]} MB peak.</td></tr>
    </table>
    <figure class="shot"><img src="crop-residual.jpg" style="height:410px; object-fit:cover">
      <figcaption><b>Where the INCOIS model is wrong.</b> Each block is a place someone measured,
      coloured by measured minus model. Unmeasured water stays empty: {empty_pct}% of it.</figcaption></figure>
  </div>
</div>
""")

    # ============================================================ 5 impact
    # The template's pointers: impact on the target audience; benefits (social,
    # economic, environmental).
    page("body-impact", f"""
<h2 style="margin:0">Potential impact on the target audience</h2>
<div class="cols" style="grid-template-columns: 1.25fr 1fr 1fr 1fr; gap: 60px">
  <div class="col aud">
    <h3 class="aud-h">INCOIS forecasters</h3>
    <div class="pair"><figure><img src="crop-before.jpg"><figcaption>{before["day"]}</figcaption></figure>
      <figure><img src="crop-after.jpg"><figcaption>{after["day"]}</figcaption></figure></div>
    <p class="cap"><b>Before and after Cyclone Amphan</b>, one 28–31.5 °C bar: the cold wake shows;
    the box's mean surface temperature is {n2(v2["amphan_cooling_c"])} °C lower after.</p>
  </div>
  <div class="col aud">
    <h3 class="aud-h">Fishermen</h3>
    <figure class="shot"><img src="crop-fishing.jpg" style="object-position: 0% 50%"></figure>
    <p class="cap"><b>INCOIS's own fishing-zone advisories</b>, all fourteen sectors as
    published, beside today's waves and wind. Our indicator says "not an advisory".</p>
  </div>
  <div class="col aud">
    <h3 class="aud-h">Students</h3>
    <figure class="shot"><img src="crop-learn.jpg" style="object-position: 0% 100%"></figure>
    <p class="cap"><b>Six lessons for class 8–12</b> on real data; quiz answers are read from
    the cube on screen, never from the language model.</p>
  </div>
  <div class="col aud">
    <h3 class="aud-h">Public and policymakers</h3>
    <figure class="shot"><img src="crop-immersive.jpg"></figure>
    <p class="cap"><b>Immersive view and cinematic tour</b>: one day of the planet's currents
    and winds, for exhibitions and awareness campaigns.</p>
  </div>
</div>
<h2 style="margin:6px 0 0">Benefits</h2>
<div class="benefits">
  <div class="card"><h3>Social</h3><ul>
    <li>Disaster preparedness: the warm layer a cyclone feeds on, seen in 3D, with cyclone heat potential per float</li>
    <li>Safety at sea: the official advisory first, with the sea state beside it</li>
    <li>Ocean literacy: a course in any school browser, on the same data forecasters use</li></ul></div>
  <div class="card"><h3>Economic</h3><ul>
    <li>Open source, no licences; a static site and one server (1 GB of memory measured enough)</li>
    <li>No archive to buy or store: public data is read where it lives, a day at a time</li>
    <li>Fishing advisories exist to cut search time at sea; here they sit where boats plan</li></ul></div>
  <div class="card"><h3>Environmental</h3><ul>
    <li>Climate monitoring: every day since {cat["first_day"][:4]} for {cat["from_first_day"]} variables, in one view</li>
    <li>Oxygen-poor layers, chlorophyll and nutrients as 3D blocks, not flat maps</li>
    <li>Where the model is uncertain or unmeasured is shown, so decisions know the limits</li></ul></div>
</div>
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
      <li>Copernicus Marine GLORYS12 and global analysis &amp; forecast, physics and biogeochemistry, as ARCO stores. <span class="why">The cube.</span><span class="url">data.marine.copernicus.eu/product/GLOBAL_MULTIYEAR_PHY_001_030</span></li>
      <li>INCOIS ERDDAP, Argo 10-day variational analysis with per-cell error. <span class="why">The Bay volume.</span><span class="url">erddap.incois.gov.in/erddap</span></li>
      <li>Ifremer Argo ERDDAP, core and synthetic BGC floats. <span class="why">Floats anywhere.</span><span class="url">erddap.ifremer.fr/erddap</span></li>
      <li>Argo GDAC, HTTPS mirror. <span class="why">Float files, QC flags, data mode.</span><span class="url">data-argo.ifremer.fr</span></li>
      <li>U.S. IOOS Glider DAC, Rutgers <i>ru29</i>. <span class="why">The independent check.</span><span class="url">gliders.ioos.us/erddap</span></li>
      <li>INCOIS Potential Fishing Zone advisories. <span class="why">Read as published.</span><span class="url">incois.gov.in/MarineFisheries/TextDataHome?mfid=1</span></li>
      <li>NCEP GFS 10 m wind via UCAR THREDDS. <span class="why">Wind forecast.</span><span class="url">thredds.ucar.edu</span></li>
      <li>NASA GIBS Blue Marble relief. <span class="why">Land.</span><span class="url">gibs.earthdata.nasa.gov</span></li>
      <li>The problem statement's two FTP links. <span class="why">Dead; replaced by 3, 4.</span></li>
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
    <div class="card grey" style="margin-top:auto"><h3>How the links were checked</h3><p>Every URL
      here was opened on 2026-09-25 with a browser user agent and answered, except the two FTP
      links (listed as dead). Every number in this deck is in the repository's
      <span class="mono">docs/13-eval-results.md</span>, produced by its evaluation script.</p></div>
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
