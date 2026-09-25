# Deck v2 — plan

**Built 2026-09-25.** The deck as built is described in `16-submission.md`. How it
differs from this plan:
- No QR code on slide 6: not wanted.
- S5 (Fly) and S11 (the whole interface) were captured but left off the slides; Fly over
  land showed no ocean, and slide 3's table carries the controls.
- The globe shot is the Gulf Stream in winter, not the Bay: in May the Bay is 30 °C wall to
  wall and the planet reads as one colour.
- The assistant capture exposed a bug: asked for an oxygen cube, it built temperature and
  said oxygen, because `make_cube` dropped a loosely named variable. Fixed in
  `viewer/src/main.ts`: the variable is matched by key or title, an unknown one is refused,
  and the depth snaps to the next listed depth.

The current deck (`submission/sih/final/`) shows v1: Simple mode (deleted), the Region 3D
voxel box, Groq (replaced by AIRouter). None of the v2 work is in it: the Ocean Cube, floats
inside the model, the whole-ocean layer, winds and waves, the fishing panel, the course,
immersive and Fly with terrain.

Assumption: the evaluator never opens the live site. The slides have to show the product
on their own, so **every slide carries at least one real capture**. Images do not fill every
slide, though: slides 3, 4 and 6 are mostly diagrams and measured numbers.

## Fixed constraints

- **Six slides including the title**, on the portal template (`16-submission.md`).
- **Every number comes from `data/eval-latest.json`** (hard rule 1). The harness has no v2
  numbers yet (see *Numbers* below).
- **A float in a picture shows its QC legend**, or the panel with QC flag, data mode and
  file (hard rule 2). Forecast days and the indicative fishing zones keep their labels in
  the shot (rule 6 in spirit).
- No frame rates on any slide.
- The layout grammar stays the same: one hero per slide, captions that say what the
  picture proves, and short text: points, not paragraphs.

## Slide by slide

### 1 · Title

Kept as it is: the template fields, the team ID and the logo. No image, because the template
leaves no room for one.

### 2 · The solution: one picture of the product

| Area | Content |
|---|---|
| Top line | "Cut a block out of the ocean anywhere on Earth, on any day, and look at it from the side, with the real floats standing inside it." |
| Hero, about 60% | **S1**: the cube cut open, with Argo sticks, a pinned probe column and the depth ticks |
| Right column | The problem in three lines, each taken from a gap the brief names: flat 2D tools; model and instruments in separate programs; no fast 3D understanding for decisions |
| Bottom strip, 4 tiles | The four novelties, each with a small shot and one line: **Ocean Cube** (S1 crop / chunk icon), **Floats inside the model** (S2), **One colour bar for the planet** (S3), **Ask it, and it drives the viewer** (S4) |

### 3 · How it works: the technical slide

| Area | Content |
|---|---|
| Left, a diagram | **The cube generator.** Globe → box, day, variable → the catalogue picks the dataset for that day (reanalysis, or analysis & forecast) → only the ARCO zarr chunks inside the box are read, with a disk cache → native levels only, range test, TEOS-10 derived fields → float32 cube → six painted faces in Cesium. Two side lanes: Ifremer ERDDAP Argo (QC, data mode, potential temperature, co-location) and INCOIS ERDDAP (the Bay voxel volume). |
| Right | **The brief, line by line.** Each requirement from `01-problem-statement.md` with a tick and where it is built. The table below this one gives the rows. |
| Foot | The stack in one line: CesiumJS · TypeScript + Vite · FastAPI + xarray · Copernicus ARCO · INCOIS / Ifremer ERDDAP · OGC WMS · AIRouter |

The brief-coverage rows, checked against the code before they go on the slide:

| Brief asks | Built as | State |
|---|---|---|
| 3D volumetric rendering, depth slices, time-step animation | Cube faces as sections, cut planes, day timeline; Bay voxel volume | ✓ |
| Isosurface extraction | 20 °C isotherm, **Bay volume only** (the cube has none) | ✓, and the slide says Bay volume |
| Argo, glider, CTD, BGC overlay, click for a profile | Argo core and BGC sticks, glider, CSV casts, profile panel | ✓ Argo, BGC, glider. CTD only through CSV: say so |
| NetCDF and delimited-text parsers, modular | xarray, `textcast.py`, `sources.PARSERS` | ✓ |
| Colour bar editor: palette, min/max, log/linear | `colorbar.ts` | ✓ |
| Opacity, vertical exaggeration | cube opacity slider, height ×N | ✓ |
| REST API, no client install | FastAPI, browser only | ✓ |
| OGC WMS/WCS, CF | WMS ✓; WCS deliberately not built | say so |
| Plugin-style extension | one parser function + one config line | ✓ |
| Outreach, e-learning | the Learn course, immersive, cinematic | ✓ |

### 4 · Feasibility: it works, measured

| Area | Content |
|---|---|
| Stat tiles, 3–4 | v1: `35 + 112` casts, `4.86 %`. v2, if the harness is extended: variables, years covered, warm cube open time, hosting peak RAM |
| Chart, kept | Model error by depth (Argo vs glider, 0–300 / 300–950 / 950–2000 m). The strongest measured finding. |
| Small shot | **S10**: the residual blocks, where the model is wrong |
| Risks we actually hit | Brief's FTP links dead → tested HTTPS mirrors · INCOIS incomplete TLS chain → truststore, never verify=False · Render killed at 512 MB → one shared S3 client (numbers only if the harness produces them) · the model needs QC too (6 cells above 40 °C) · unknown GPUs → auto-tuner · an assistant can invent numbers → every number checked against tool results, flagged if untraceable |

### 5 · Impact: four audiences, four pictures

| Column | Shot | Lines |
|---|---|---|
| Cyclone forecaster | **S8**: Amphan before and after, same camera, one 28–31.5 °C bar | TCHP +16.0 kJ/cm² (harness), the 20 °C isotherm, forecast days labelled |
| Fishermen | **S7**: INCOIS PFZ points and sea state | official advisories first; the indicative layer labelled as not an advisory |
| Students | **S6**: a course card over the globe | six lessons for class 8–12; quiz answers computed from the cube on screen |
| Public and outreach | **S9**: an immersive or cinematic frame | exhibitions; one link, no install |

Footer strip: where it goes next (more sensors, ML products, class results).

### 6 · References

The existing 18 sources, plus the v2 sources: Copernicus ARCO, Ifremer Argo ERDDAP, UCAR
THREDDS GFS, NASA GIBS, Open-Meteo geocoder, INCOIS PFZ, and the course sources (Gray 1968,
Price 1981, Schott & McCreary 2001, the IMD Amphan report, Argo). The whole link check is
rerun. A **QR code** goes to the repository (and the live site, if it is up), because a
scanned code costs the evaluator less than typing a URL.

## Shot list

Every shot is captured headless at 1600×900, device scale 2, with Graphics forced to High,
the docks retracted unless the dock is the subject, and `warm_scenarios` run first.

| # | State | Used on |
|---|---|---|
| S1 | `amphan_before`, temperature, east side cut in, floats on, one column pinned, Region 3D | 2 (hero) |
| S2 | the same cube, a stick clicked, the profile panel open (QC, data mode, file) | 2 |
| S3 | Globe, the whole ocean painted, currents plus winds (`?air=1`), the cube on it | 2 |
| S4 | the assistant has just built the Arabian Sea oxygen cube, a control ringed in orange | 2 |
| S5 | Fly over the Bay with terrain and imagery (token present in `.env.local`) | 2 or 5, spare |
| S6 | Learn, lesson 4 card (Amphan) over the globe | 5 |
| S7 | the fishing panel: PFZ points on the east coast, sea state | 5 |
| S8 | `amphan_before` and `amphan_after`, same camera and bar | 5 |
| S9 | immersive or cinematic, dawn sun | 5 |
| S10 | INCOIS Bay volume ticked, the residual layer | 4 |
| S11 | a controls crop: variable, colour bar editor, opacity, height | 3, only if room |

That is about 10 pictures across 6 slides, and two slides (3 and 6) have none, or one.

## Numbers: the v2 gap

`server/eval/run_eval.py` covers only v1. Recommended: add a `v2` section that writes these
keys to `eval-latest.json`:

- catalogue variable count and the earliest day
- scenario count
- cold and warm open time of the `amphan_before` cube
- Argo casts in that cube
- lesson count
- the `measure_hosting` peak RAM, cores and bytes per visit (read from its output, not retyped)

`figures.py` reads those keys like any other, and crashes if one is missing.

## Build

Same pipeline as before (`16-submission.md`), with these changes:

1. Add `submission/sih/capture.mjs`: puppeteer-core with the installed Chrome, driven by URL
   parameters and `window.vvater`. It makes the shots reproducible instead of hand-taken.
2. `figures.py`: all five bodies rewritten. The v1 shots are dropped.
3. `render.py`, `figures.py --check`, `build.py`, `build_canva.py`, `topdf.ps1`.
4. Every rendered PNG is read by eye, because `--check` cannot see overflow.
5. `16-submission.md` gets the new slide and shot tables in the same pass.
