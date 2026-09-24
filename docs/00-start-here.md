# SIH 2026 · PS 26067 — 3D Ocean Data Visualization Platform

INCOIS / Ministry of Earth Sciences. Theme: Disaster Management.

## The 30-second version

A browser-native 3D platform where you **cut a block out of the ocean anywhere on Earth,
on any day from 1993 to nine days ahead, and look at it from the side**: temperature,
salinity, density, sound speed, currents, oxygen, chlorophyll, nutrients, pH and carbon,
coloured at every depth on the model's own levels. Real Argo floats stand inside the
block as sticks coloured by what they measured, so where the model and the ocean disagree
is a different colour on the same wall. The rest of the planet is painted with the same
variable and colour bar, with that day's currents flowing over it.

Stack: **CesiumJS** on a **FastAPI** backend, reading the **Copernicus Marine ARCO
stores** directly, **INCOIS ERDDAP** for the Bay of Bengal analyses, and **Ifremer's Argo
ERDDAP** for floats anywhere.

## The files

| File | What's in it | When to read |
|---|---|---|
| `01-problem-statement.md` | The official text, verbatim. Source of truth. | First, and whenever there's an argument about scope. |
| `03-limitations.md` | **The structural limits, each with the constraint it forces.** L13 covers the cube's faces. | Before designing anything. This is the most important file here. |
| `05-data-sources.md` | Every source, probed rather than assumed. §1.4 the ARCO stores, §2.4 global Argo. | Before writing an ingest path or quoting a dataset. |
| `13-eval-results.md` | Generated numbers. Never hand-edited. | Whenever anyone questions an accuracy claim. |
| `10-unsourced.md` | Everything we could not source, and where the real thing comes from. | Before quoting any value. |
| `11-deferred.md` | Everything knowingly incomplete, with what it blocks. | This is the live status doc. |
| `14-novelties.md` | What this does that the brief did not ask for. | When a new feature idea shows up, and before a pitch. |
| `16-submission.md` | How the idea deck is built from the template, the harness and real screenshots. | Before touching the deck. |
| `17-user-guide.md` | Every control and every word on screen, for people. The assistant reads it too. | Before a demo. |
| `18-deploy.md` | Vercel and Render. v2 runs locally for now. | Before deploying. |

## What is built, as of 2026-09-24 (branch `v2`)

```
python -m server.tools.fetch_fixtures         # real files the tests run against
python -m pytest server/tests -q              # 7 passed
python -m server.eval.run_eval --json         # numbers table + data/eval-latest.json
python -m server.tools.warm_scenarios         # pre-fetch the nine scenarios (a few GB, once)

python -m uvicorn server.ocean.api:app --port 8011     # the API
cd viewer && npm install && npm run dev                # the viewer, on :5173
```

Every server module has a self-check (`python -m server.ocean.<module>`), and the ones that
touch the network have a `--live` check: `cube --live` pins the depth sign with physics
and proves the chunk cache byte-identical to S3; `argo_global --live`, `surface --live`.

**The Ocean Cube** (`viewer/src/cube/`, `server/ocean/cube.py`). Any box up to 100° × 80°,
any day, any catalogue variable, from the surface to a chosen depth or the sea floor.
- Sent on the dataset's **native levels only** (hard rule 3), block-averaged horizontally
  to 160 cells a side for display, range-tested at native resolution first.
- It **stands on the sea surface** over its own footprint; every height maps back to a
  depth (`CubeScene.depthOf`), every tick is computed from metres (hard rule 4).
- Its six faces are **sections painted from the data**: contours, solid land, rock below
  the sea floor with the floor edged in light, a sea-floor mesh from GLORYS bathymetry.
- **Cut & look**: move any side, the top or the bottom inwards and the faces become
  sections through the inside. Stretched (√depth) or linear depth axis; *Native levels
  only* shows the data as bands with no interpolation (L13).
- **Probe**: hover for the value at any point on the cube; click to pin that place's column.
- Nine **scenarios** (`config.SCENARIOS`), including Cyclone Amphan before and after; your
  own box with *Draw a box*; the URL carries the whole view.
- The timeline steps the cube **one day at a time** across the variable's whole coverage.

**Data anywhere** (`server/ocean/arco.py`, `catalog.py`). 23 variables across physics
(1/12°, 50 levels to 5,728 m) and biogeochemistry (1/4°), each resolved per day to the
reanalysis where it exists and the analysis & forecast after it; forecast days are labelled
forecast everywhere. Density and sound speed are derived with TEOS-10 and say so. Stores are
read chunk by chunk and cached on disk; a warmed cube opens in under half a second.

**Floats anywhere** (`server/ocean/argo_global.py`, `cubecasts.py`, `viewer/src/cube/casts.ts`).
Core and BGC Argo by box and ±2 days, adjusted values first, every level kept with its QC
flag, data mode and its own GDAC file name. Temperature is converted to potential
temperature and oxygen to mmol/m³ before being drawn against the model, and the conversion
is recorded. Clicking a stick co-locates it against the cube's model on the float's own day
through the same tested `colocate.py` the Bay uses.

**The whole ocean** (`server/ocean/surface.py`, `viewer/src/ocean.ts`, `flow.ts`). The globe
is painted with the cube's variable at the cube's top depth, on the cube's colour bar, at
1/4°. That day's currents are animated as particle trails worldwide and, at the cube's own
resolution, on its top face. A picture of one day's flow, not trajectories (D-13, D-36).

**Views** (keys `1`–`4`): Region 3D orbits the cube; Map 2D shows the cube's top section
flat; Globe; Fly.

**Winds and waves** (`server/ocean/marine.py`). 10 m wind animated in amber over the
currents: observed (Copernicus L4, reprocessed before July 2020, near-real-time to
yesterday), then the NCEP GFS forecast through UCAR THREDDS, with a labelled stand-in when
UCAR is slow. Wave height from the Copernicus forecast, ten days ahead.

**For fishermen** (`server/ocean/fishing.py`, `pfz.py`, `viewer/src/fishing.ts`). INCOIS's
own Potential Fishing Zone advisories for all fourteen sectors, read as published (clouded-out
sectors say so), as green points; and an indicative zone layer anywhere (strongest SST
fronts with chlorophyll) with a sea state from waves and wind. The indicator is labelled
not-an-advisory everywhere.

**Immersive** (key `I`, `?immersive=1`). The globe, its currents and winds, nothing else;
*Cinematic* (key `C`) is a five-shot camera tour with the real dawn sun.

**The assistant drives the viewer**: builds cubes anywhere, sets any listed control, presses
buttons, rings a control in orange for five seconds to show where it is, answers fishing
questions from INCOIS's advisories first (`server/ocean/assistant.py` `CONTROLS`).

**Land**: NASA GIBS Blue Marble relief (grey or colour) over the offline Natural Earth base;
optional Cesium World Terrain in Fly and immersive when `VITE_CESIUM_ION_TOKEN` is set.

**The INCOIS Bay volume is opt-in.** Nothing of v1 loads, draws or shows its controls until
*INCOIS Bay volume* is ticked.

## The Bay of Bengal flagship: the INCOIS volume

The v1 viewer is still here under *INCOIS Bay volume*: the INCOIS analysis drawn as a true
voxel volume in place under the sea, with its uncertainty, observation density, residual,
glider and the measured results below. Everything in this section is about that view.

**Assistant** (`server/ocean/assistant.py`, `viewer/src/chat.ts`): questions about the data
or the viewer, answered by a Groq-hosted model that can only reach the data through tools
wrapping the API's own functions (an analysis value at a place and depth, the observation
list, one cast against the analysis, the harness numbers, a global surface value, the user
guide). Every number in a reply is checked against the tool results and the question;
anything untraceable is flagged on screen. It may propose view changes (set a depth, open a
profile, switch view), whitelisted and clamped on the server and again in the
browser. The key stays on the server. `docs/17-user-guide.md` is what it reads for the
interface, and is written for people.

**Cameras** (`viewer/src/camera.ts`): Region 3D uses our own orbit camera (drag to orbit,
Shift- or right-drag to pan, wheel to zoom; **W A S D** pan, **Q E** turn, **R F** zoom,
arrows tilt) with the range held between 90 km and 3,600 km and the target near the box.
Cesium's controller zoomed by distance to a picked point, which on a translucent globe was
unreliable: one zoom-out and zooming back in barely moved. **Fly** (key `4`) is a
great-circle flight at a fixed altitude (8–250 km, changed only by R/F), so nobody climbs
into space. Markers sit on the sea surface with depth testing off.

**Quality:** motion renders at the tuned tier; 350 ms after the scene stops, one frame is
drawn at full device resolution (up to 2x) and stays until the next change.

**Four views** of the same data (keys `1`–`4`, *Reset camera* or `Home` returns to
each view's home camera):

- **Region 3D** — the oblique working view. Zoom-out is capped at 4,500 km, because there
  is nothing to see further out.
- **Map 2D** — Cesium's 2D mode. The voxel primitive is 3D-only, so the map shows the
  depth slice as a flat section, coloured by the same ramp from the values already in
  memory (`viewer/src/section.ts`).
- **Globe** — the whole Earth, region in the middle. Around the box, in every view, the **global sea-surface temperature** for the analysis date on the slider
  (Copernicus 1/4° GLORYS12 member, 0.51 m, native resolution;
  `server/ocean/globalsurface.py`), on the field's own colour scale, fading to nothing over
  5° before the box (1° on the map) so the surface gives way to the volume instead of
  meeting it at a hard line. Surface only, temperature and the analysis layer only, and
  labelled that way on screen. The sea surface is translucent only over the box.
- **Fly** — see *Cameras* above.

Streamlines are on by default at the opening slice (93 m), coloured light cyan to amber by
speed, with slow water fainter. Every async layer (volume, streamlines, profile, section,
global surface) takes a request ticket, so a slow response can never land on top of a newer
one.

**Graphics settings** (the *Graphics* button): four quality tiers, and on first load an
auto-tuner measures real rendered frames and picks the best tier that holds 60 fps. The
volume is fill-rate bound, so resolution is the lever; MSAA, sky and FXAA are the rest.
Render-on-demand means an idle globe draws nothing. Measured tiers and the levers that
did not work are in `viewer/src/settings.ts` and `11-deferred.md` D-16 to D-19.

**Delimited-text casts**: CSV, TSV or whitespace tables with lat, lon, time, depth or
pressure and temperature are parsed by `server/ocean/textcast.py` and can be dropped onto
the viewer (or added with *Add casts*). They are co-located like any float and always
labelled unevaluated.

**Cyclone heat potential** (heat above 26 °C, kJ/cm²) is computed for every co-located
pair and shown in the profile panel; the harness reports it by instrument.

**Depth slice** clips the volume at the chosen depth, so its top face is a horizontal
section — the brief asks for depth-slice views by name.

**Four things to look at**, all from the same voxel path:

1. **The field** — temperature or salinity through the water column.
2. **Its uncertainty** — the analysis ships a per-cell error field; low-confidence water
   renders faint instead of being drawn as if it were measurement.
3. **Observation density** — how many profiles actually informed each cell. Over this
   region: **0 to 2**.
4. **The residual** — observed minus modelled, binned onto the grid. Only **4.86 %** of
   cells contain an observation at all, and the empty ones stay empty.

**Also served:** a minimal OGC WMS (`/wms`, GetCapabilities + GetMap, nine layers,
EPSG:4326) so the same data opens in QGIS. WCS is deliberately not implemented.

**Two presets that name what the controls already did:** the **20 °C isotherm** (the
standard proxy for tropical cyclone heat potential) and **true vertical scale**.

Demo date is **2018-08-25** — the one date where the INCOIS analysis, Argo, a glider and
GLORYS12 are all present over this region at once.

Co-location against the analysis, RMSE by depth band — pooled levels:

| Band | Argo | Glider (independent) |
|---|---:|---:|
| **0–300 m** | 1.26 °C | **2.89 °C** |
| 300–950 m | 0.35 °C | 0.31 °C |
| 950–2000 m | 0.19 °C | 0.23 °C |

**Below 300 m the two instruments agree and the analysis is good. The entire disagreement
is in the upper 300 m — the mixed layer and thermocline — where the independent glider
shows more than twice the error the assimilated floats do.** That is the layer a cyclone
forecaster cares about, it is invisible in a single pooled number, and it is obvious the
moment you draw the column. Full reasoning in `13-eval-results.md`.

## The five things that decide this

1. **The problem statement's own dataset links do not work.** Both are `ftp://` and
   port 21 is blocked. Everything we use is an HTTPS path we found and tested.
2. **INCOIS serves its own data, and it is better for us than Copernicus** for the
   default path. A public ERDDAP with a 4D gridded Argo analysis, no credentials, **and
   per-cell error fields**. Copernicus GLORYS12 is wired in behind it for 1/12°
   resolution and currents.
3. **Volumetric rendering is solved, in exactly one way.** CesiumJS ships the raymarcher;
   `VoxelPrimitive` runs our fragment shader at every step along the ray. We write the
   transfer function, not the marcher.
4. **Co-location is the actual scientific claim**, and the only place where being quietly
   wrong is worse than being visibly broken. It has its own module and its own tests.
5. **Uncertainty is available and most platforms throw it away.** `TERR`/`SERR` become a
   second voxel channel, so low-confidence water renders faint.
6. **The model needs QC too.** The INCOIS analysis contains 24 cells reading 36–44 °C at
   75–100 m. The brief treats model output as ground truth; it is not.

## The one architectural rule

**Never report a number the eval harness did not produce.** Every figure in the deck, the
proposal and the film traces to `13-eval-results.md`, which traces to
`server/eval/run_eval.py`. If it isn't in there, it doesn't get said.

## Start here, today

**2026-09-24, evening.** `v2` was fast-forwarded into `main` (commit `206e864`) and both
hosts redeployed from it.

- **Vercel** (`v-vater.vercel.app`): built and serving the v2 viewer, pointed at
  `https://vvater-api.onrender.com` (checked in the bundle; no `127.0.0.1` left in it).
- **Render** (`vvater-api.onrender.com`): the v2 backend came up at 22:07 (`/api/pfz` 200 in
  about 1 s). About twenty minutes later **every route returned 502**, including ones that
  had answered: the process was down or restarting, not refusing the site. Not yet
  diagnosed. **First job next session: read the Render logs** (see `18-deploy.md`,
  "When the live site cannot reach the API").

Everything runs locally end to end. What is knowingly incomplete is in `11-deferred.md`.
The deck in `submission/sih/final/` still shows v1 and is rebuilt from `16-submission.md`
with v2 screenshots before submission.
