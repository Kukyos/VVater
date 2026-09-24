# Novelties — what this does that the brief did not ask for

The rule for this file: an idea earns a place only if the **data already supports it**.
Anything needing a source we do not have goes to `10-unsourced.md` instead.

Thirteen are built; N10 to N13 arrived with v2 (branch `v2`, 2026-09-24). Every number here comes from `13-eval-results.md`.

---

## Built

### N1 · Uncertainty is rendered, not discarded

`incois_argo_10d_VAM` ships `TERR` and `SERR` — per-cell relative error — and the
McCreary variant ships `*_STDEV` and `*_RMSE`. Every platform we looked at throws these
away and draws the analysis as if it were measurement.

Here the error is a **second voxel channel**, and the shader modulates per-step alpha by
it. Low-confidence water renders faint. Cost: one extra `Float32Array` on the wire and
four lines of GLSL. A forecaster sees where the field is guessing without being told.

### N2 · The model gets quality control, not just the observations

The brief treats model output as ground truth and QC as a thing you do to instruments.
It is not. The INCOIS analysis contains **24 cells reading 36–44 °C at 75–100 m depth**
on one step — impossible at that depth in this basin.

`cf.global_range_check` applies the **published Argo global range test** to the model
field, masks failures from the render, and reports the count in the provenance panel.
Six of the 24 fail that test; the rest need a depth-aware range we have no published
source for, so it is logged unsourced rather than invented. Worth reporting to INCOIS.

### N3 · Observation density as a volume

The McCreary product ships `T_BOXOBS`: how many profiles fell inside each 1° cell. It is
not a physical field, so nobody renders it. Exposed as a selectable variable it answers
the question a forecaster actually has — *how much of what I am looking at is
measurement?*

Over the Bay of Bengal it runs **0 to 2 profiles per cell**. That number is the argument
for the whole platform, and it took one line in `config.py` to surface.

### N4 · The residual volume

`13-eval-results.md` established that the analysis and an independent glider agree below
300 m (0.35 vs 0.31 °C RMSE) and **disagree badly above it** (1.26 vs 2.89, with a
−2.25 °C bias). That is the mixed layer and thermocline — the part that decides cyclone
intensity — and it is **invisible in any pooled statistic**.

So every cast in the window is co-located and **observed − modelled is binned onto the
grid and rendered as a volume**. Where the analysis is wrong becomes the first thing on
screen instead of a table in an appendix.

Measured: **127 casts, 21,629 levels, 510 of 10,488 cells — 4.86 %**, pooled bias −0.442,
RMSE 1.278 °C.

Three deliberate refusals:

- **Empty cells stay empty.** A smooth residual field would imply we know the error
  everywhere. You can only verify where somebody measured, and that is one cell in twenty.
- **No averaging across depth**, because the entire finding is that the error is
  depth-dependent.
- **No timestep.** A ±5-day window over a 10-day cadence spans two analysis steps
  (2018-08-20 and 2018-08-30). The first version took a `time_index`, used it only for the
  label, and produced a byte-identical volume carrying whichever date the slider sat on.

It uses the `balance` diverging palette on a range forced symmetric about zero: a residual
has a sign, and a sequential ramp on signed data is how residual plots get misread.

### N6 · The 20 °C isotherm

The isosurface control was generic. Under a Disaster Management theme in the Bay of
Bengal it has one obvious worked example — the depth of the **20 °C isotherm**, the
standard proxy for the heat available to a tropical cyclone. A deeper D20 means more fuel.

It ships as a named preset that sets the threshold and the shell width and says what it
is, so the first thing anyone sees the isosurface do is the thing the theme is about.

### N7 · Streamlines integrated on the server

A novelty of method rather than idea. The two usual ways to draw currents are decimated
glyphs (thousands of primitives, still ugly) and GPU particle advection (a shader project
with its own silent failure modes). Integrating **RK2 streamlines in numpy** and sending
polylines is cheaper than both — 397 lines, 386 ms — and, the actual reason, it is
**testable**.

A wrong integrator draws a picture that looks entirely fine. `currents.demo()` checks it
against solid-body rotation, where every streamline is a known circle: **0.04 % radius
drift over 120 steps**, where plain Euler visibly spirals outward. This region is full of
eddies, so that difference is the whole ballgame.

The honesty cost ships in the API response and on screen: streamlines are the
instantaneous flow pattern, not particle trajectories through time.

### N8 · The residual in kilojoules per square centimetre

N4 says where the analysis is wrong in degrees. A cyclone forecaster does not consume
degrees; they consume **tropical cyclone heat potential** — the heat above the 26 °C
isotherm (Leipper and Volgenau 1972), in kJ/cm². So every co-located pair is also
integrated into TCHP, on the same levels on both sides (`server/ocean/heat.py`), and the
clicked cast's panel shows observed against analysis.

The harness result (`13-eval-results.md`): against the assimilated floats the analysis is
close on average; along the independent glider track it holds **more heat than was
measured**, in the same direction as the upper-300 m temperature bias. One deployment, so
a finding about that water — but it is the first number in this project stated in the
unit of the Disaster Management theme.

Two refusals: a cast that never cools to 26 °C has **unknown** TCHP, not zero and not a
lower bound; and the constants are a TEOS-10 value and a stated reference density, both
in `10-unsourced.md`, because operational products disagree on them.

### N9 · Two ingest paths, one answer

The brief asks for delimited-text parsers as well as NetCDF. `server/ocean/textcast.py`
reads CSV, TSV, semicolon or whitespace tables, units rows, depth or pressure. The novelty
is the check: the same glider deployment downloaded **as NetCDF and as CSV** must produce
identical casts through the two parsers — 222 casts, 24,611 levels, asserted equal. And one
Argo float exported as CSV from a different server co-locates to the same bias and RMSE as
the NetCDF path, to seven decimal places.

Uploading a file drops its casts onto the globe next to the floats, co-located on click.
Every one is labelled unevaluated, because a text file carries no QC anyone agreed on.

---

### N5 · Vertical exaggeration as a teaching control

The ocean in this box is 2,000 m of water under roughly 2,400 km of sea; at true scale
the Bay of Bengal is a film. Exaggeration is free here — it is the ratio of the voxel
shape's height bounds, not a mesh transform — so it ships as a labelled pair: **True
scale** and **Readable (40x)**, each with an on-screen line computed from the volume
actually drawn ("1 part in N"). The first version of that line said "4 km deep and
2000 km wide"; neither number was what was on screen, so it is computed now.

---

## v2

### N10 · The ocean as a block you can cut

Every ocean viewer we looked at, including Copernicus's own, shows the ocean as a map: a
surface, or one depth at a time. The brief asks for depth-resolved volumes. The v2 cube
lifts a block of any size out of the planet, anywhere, on any day, and sets it on the sea
surface so it can be looked at **from the side**, which is the one direction a map can
never show. Its faces are sections painted from the model's native levels; any side can
be moved inwards to look inside. The thermocline, an oxygen-poor layer, the shape of the
sea floor and the edge of a current become things you see rather than infer from a stack
of maps.

### N11 · Observations stand inside the model

Argo floats are not dots on a surface here: each is a vertical stick in the cube, coloured
level by level through the same colour bar as the water around it. Where the model and
the float disagree, the stick is a different colour from the wall beside it, so a
misfit is visible before anyone opens a chart. QC failures are drawn in their own colour,
never dropped; one click co-locates the float against the same model.

### N12 · Any day, any variable, no archive to build

The platform holds no copy of the ocean. It reads the Copernicus ARCO stores chunk by chunk
(`server/ocean/arco.py`), so every day from 1993 to the forecast horizon, 23 variables,
physics and biogeochemistry, is one request away, and a day already looked at is cached.
Which model a day comes from is decided per day and written on screen; a forecast is always
labelled a forecast.

### N13 · One colour bar for the cube and the planet

The globe around the cube is painted with the cube's own variable at the cube's top depth,
on the cube's colour bar, with that day's currents flowing over both. A colour means the
same value inside and outside the block, so the block reads as a piece of the ocean around
it rather than a separate chart.

