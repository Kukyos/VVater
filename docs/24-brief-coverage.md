# Brief coverage: every requirement, where it is built, where the deck shows it

Checked 2026-09-30 against `01-problem-statement.md`, branch `v2` at `94fc0af` (same as
`origin/main`). The deck is `submission/sih/final/VVater-SIH2026-final.pptx`, submitted
27 Sept 2026. Checks run for this pass: `pytest server/tests` 12 passed (fixtures fetched,
none skipped); `server.ocean.instruments`, `insitu` and `textcast` self-checks ok;
`tsc --noEmit` clean in `viewer/`.

State: **Built** (in the running build, checked), **Partial** (built with a logged limit),
**Not built** (logged, not claimed).

## Key gaps (Background)

| Gap in the brief | State | Where | Deck |
|---|---|---|---|
| Web 3D, depth-resolved volumetric views of T, S, currents | Built | `cube/`, `cube.py`, `voxels.ts` | 2 |
| Argo and glider profiles (lat, lon, depth, time, T, S, chl) beside model fields | Built. Chlorophyll and oxygen come from BGC floats (`argo_global.py`) | `argo_global.py`, `glider.py`, `profile.ts` | 2 |
| Controls for variable, depth slice, time-step animation, colour bars | Built | `main.ts`, `colorbar.ts`, `cube/controller.ts` | 2 |
| New streams or variables without re-engineering | Built, three registries (L11) | `sources.PARSERS`, `catalog.VARIABLES`, `instruments.INSTRUMENTS` | 2 (catalogue and CSV only) |
| Tools for rapid understanding and decisions | Built: assistant, 20 °C isotherm, TCHP, residual, fishing zones | `assistant.py`, `heat.py`, `residual.py`, `pfz.py` | 2, 4, 5 |

## Core functional requirements

| Requirement | State | Where | Deck |
|---|---|---|---|
| 3D volume, full water column | Built. Native levels only, surface to the sea floor | `cube.py`, `cube/scene.ts` | 2 |
| Depth-slice views | Built. Cut any face; Map 2D shows the slice (D-24) | `cube/controller.ts`, `section.ts` | 2 |
| Isosurface extraction | Partial. A shader shell in the INCOIS Bay volume, with a 20 °C preset. The Copernicus cube shows contours on its faces, not an isosurface | `voxels.ts`, `main.ts` | 2 ("Bay volume") |
| Time-step animation | Built. Play steps the cube one day at a time and prefetches the next day | `main.ts` (time animation) | 2 says "timeline", not "Play" |
| Current vectors | Partial. Particles and server-integrated streamlines at any native depth, drawn on a 2D overlay, not inside the 3D scene (D-36). Instantaneous, not trajectories (D-13) | `flow.ts`, `currents.py`, `streamlines.ts` | 2, 3 |
| WebGL / Cesium.js | Built. CesiumJS, `@cesium/engine` pinned | `viewer/` | 3 |
| Argo overlay, geospatially accurate | Built. Every level keeps its QC flag, data mode and file | `argo_global.py`, `cube/casts.ts` | 2 |
| Glider overlay | Built. IOOS Glider DAC `ru29`, 98 casts (L9, resolved) | `glider.py` | 2, 4 |
| CTD | Built. CSV/TSV through the text reader in the viewer; TAC CTD NetCDF reader checked on a Bay cruise; none registered near the demo date | `textcast.py`, `insitu.py` | **"CTD" is not on the deck**; slide 2 says "your own CSV casts" |
| BGC | Built. BGC floats for chlorophyll and oxygen; PISCES variables in the cube | `argo_global.py`, `catalog.py` | 2 |
| Click a float or glider for a depth-vs-variable chart with timestamps | Built. Model co-located on the cast's own day | `profile.ts`, `/api/profile`, `/api/cube/profile` | 2 (picture) |
| NetCDF parser (xarray; PyNIO is archived) | Built | `sources.py`, `cf.py` | 2 |
| Delimited text parser | Built. Checked against the NetCDF path: 222 casts and 24,611 levels, identical | `textcast.py` | 2 |
| Modular, minimal code change to add a source | Built | `23-extending.md` | 2 |
| Colour bar editor: palette, min/max, log/linear | Built. cmocean palettes | `colorbar.ts` | 2 |
| Variable selector | Built. 26 variables (23 at submission, plus 3 ML) | `catalog.py` | 2 says **23** |
| Layer opacity | Built. Cube and Bay volume | `cube/controller.ts`, `voxels.ts` | 2 |
| Vertical exaggeration | Built | `cube/scene.ts`, `voxels.ts` | 2 |
| Modern JS frontend, no client-side install | Built. TypeScript and Vite, a static site | `viewer/` | 3 |
| REST / OPeNDAP backend | REST built (FastAPI). OPeNDAP is consumed, not served. The brief says "REST/OPeNDAP"; REST meets it | `api.py` | 3 |
| Deployable on INCOIS infrastructure | Built. One server and a static site; host needs measured in `18-deploy.md`. The live backend is currently a laptop (D-41) | `18-deploy.md` | 3, 4 |
| Plugin-style sensors: CTD, moorings, HF-radar, ADCP | Moorings are live (RAMA, one on the demo date, D-49). ADCP and HF-radar readers are checked on real files, but there is no Bay data (D-50, D-51) | `insitu.py`, `instruments.py` | **Not on the deck** |
| New model variables | Built. One catalogue line each | `catalog.py` | 2 |
| Machine-learning derived products | Built. Three MULTIOBS neural-network fields as cube variables, weekly, ending 2023 (D-53) | `catalog.py`, `cube.py` | **Slide 4 roadmap says "12 MO … ML"** |
| OGC WMS | Built. `GetCapabilities` and `GetMap` | `wms.py` | 2 |
| OGC WCS | Not built, deliberately (D-05) | — | Not claimed. Correct |
| CF Conventions | Built. Read defensively, with every normalisation recorded | `cf.py` | 6 |

## Public outreach

| Ask | State | Where | Deck |
|---|---|---|---|
| Students | Built. Six-lesson course, class 8–12, quiz answers read from the cube | `learn/`, `19-course.md` | 5 |
| Public, exhibitions | Built. Immersive view and cinematic tour | `immersive.ts`, `learn/tour.ts` | 5 |
| Policymakers | Built. Before-and-after Amphan, benefits | scenarios in `config.py` | 5 |

## Beyond the brief

Built but not asked for (details in `14-novelties.md`):

- **N1**: model uncertainty rendered.
- **N2**: QC applied to the model.
- **N3**: observation density as a volume.
- **N4**: the residual volume.
- **N5**: exaggeration as a teaching control.
- **N6**: the 20 °C isotherm preset.
- **N7**: streamlines integrated on the server.
- **N8**: residual in kJ/cm².
- **N9**: two ingest paths with identical output.
- **N10**: the cube you can cut.
- **N11**: floats inside the model.
- **N12**: any day from 1993 to the forecast, anywhere.
- **N13**: one colour bar for the cube and the planet.

Also built and not asked for: the AI assistant that drives the viewer, the Fly view, Globe, INCOIS PFZ fishing advisories with sea state, NOAA GFS winds, cyclone heat potential per float, the course, the immersive view, and a measured test harness behind every number.

## Where the deck and the build disagree

The deck was right on 27 Sept for the first four rows below. The build has moved since. Rows 5 and 6 need correcting whatever else changes.

| # | Deck says | Build says | For the finals |
|---|---|---|---|
| 1 | Slide 4 roadmap: ML at 12 months | Three ML products are live (`13-eval-results.md`, *Extensible design*) | Move ML to "now, built" |
| 2 | Slide 2: 23 variables | 26 | Re-run `run_eval --json` and take the count from it |
| 3 | Slide 2: instruments are Argo, BGC, gliders and CSV | Adds RAMA moorings, the TAC CTD reader, and ADCP and HF-radar readers | Name CTD, moorings, ADCP, HF-radar and ML against the brief's *Extensible Design* line |
| 4 | Slide 2: "a day-by-day timeline" | Play animates it | Say "time-step animation (Play)" in the brief's words |
| 5 | Slide 3: "Open-source AI model, Llama 3.1 on Ollama, free, no API cost". Slide 4: "0 Rs running cost" | `assistant.py` calls AIRouter with `gpt-4.1-mini`, `gemini-2.5-flash` and `deepseek-v4-flash`, on a prepaid balance (D-26). There is no Ollama path in the repo | Either build the local-model path D-26 names, or change both slides |
| 6 | Slide 2, innovation: "where model and float disagree, the colours differ on the same wall" | D-46: in a closed cube every stick is drawn dashed white, so this is almost never seen | Fix D-46, or reword to "click a float for its profile against the model" |
| 7 | Slide 3: API "on Render" | The live backend is a laptop through ngrok (D-41) | Fine for the idea stage; the finals demo needs a host (`18-deploy.md`) |

## Repository hygiene

- Committed deck and proposal metadata: author is the team member, and there is no tool attribution.
- No tool attribution in tracked text files.
- The body of commit `7f56de0` in history names the local assistant instructions file. Removing it means rewriting public history; the team decides.
