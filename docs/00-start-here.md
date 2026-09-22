# SIH 2026 · PS 26067 — 3D Ocean Data Visualization Platform

INCOIS / Ministry of Earth Sciences. Theme: Disaster Management.

## The 30-second version

A browser-native 3D platform that renders INCOIS ocean model fields as a **volume** —
temperature and salinity through the whole water column — and draws **Argo float
profiles** into the same scene, so a forecaster can see the prediction and the
observation together instead of alternating between two desktop tools.

Region is the **Bay of Bengal**. Stack is **CesiumJS** on a **FastAPI** backend.

## The files

| File | What's in it | When to read |
|---|---|---|
| `01-problem-statement.md` | The official text, verbatim. Source of truth. | First, and whenever there's an argument about scope. |
| `03-limitations.md` | **The structural limits, each with the constraint it forces.** | Before designing anything. This is the most important file here. |
| `05-data-sources.md` | Every source, probed rather than assumed, with what worked and what didn't. | Before writing an ingest path or quoting a dataset. |
| `13-eval-results.md` | Generated numbers. Never hand-edited. | Whenever anyone questions an accuracy claim. |
| `10-unsourced.md` | Everything we could not source, and where the real thing comes from. | Before quoting any value. |
| `11-deferred.md` | Everything knowingly incomplete, with what it blocks. | This is the live status doc. |
| `14-novelties.md` | What this does that the brief did not ask for, and what is designed but unbuilt. | When a new feature idea shows up, and before a pitch. |

## What is built, as of 2026-09-22

The **spine and the viewer**. Ingestion, QC, regrid and co-location are measured; the
water column renders as a true volume and clicking a float draws it against the analysis.

```
python -m server.tools.fetch_fixtures         # real files the tests run against
python -m pytest server/tests -q              # 4 passed
python -m server.eval.run_eval --json         # numbers table + data/eval-latest.json

python -m uvicorn server.ocean.api:app --port 8011     # the API
cd viewer && npm install && npm run dev                # the viewer, on :5173
```

**Viewer:** CesiumJS voxel volume with an offline Natural Earth basemap (no Ion token,
no network at demo time). Colourbar editor (palette, min/max, log/linear), opacity,
sea-surface translucency, isosurface, vertical exaggeration, time animation with
prefetch, current streamlines on a depth slice, Argo and glider markers, and a
depth-vs-variable chart per cast with QC and provenance.

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

Both external blockers are cleared. **Phase 2 — the Cesium volume — is next, and nothing
is in its way.**
