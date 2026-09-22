# Novelties — what this does that the brief did not ask for

The rule for this file: an idea earns a place only if the **data already supports it**.
Anything needing a source we do not have goes to `10-unsourced.md` instead.

Three are built. Two are designed and not built. One is named because it is the
Disaster-Management answer and currently sits behind a generic slider.

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

**Built.** 

`docs/13-eval-results.md` established that the analysis and an independent glider agree
below 300 m (0.35 vs 0.31 °C RMSE) and **disagree badly above it** (1.26 vs 2.89, with a
−2.25 °C bias). That is the mixed layer and thermocline — the part that matters for
cyclone intensity — and it is **invisible in any pooled statistic**.

Co-locate every float and glider cast in the window onto the grid and render
**observed − modelled as a volume**. Where the analysis is wrong becomes the first thing
on screen instead of a table in an appendix.

Measured: **127 casts, 21,629 levels, 510 of 10,488 cells (4.86 %)**, pooled bias −0.442
and RMSE 1.278 °C. Empty cells stay empty — a smooth residual field would imply we know
the error everywhere, which is the opposite of the point.

It uses the `balance` diverging palette on a range forced symmetric about zero, because a
residual has a sign and a sequential ramp on signed data is how residual plots get
misread.

**It is a window aggregate, not a timestep**, and it says so: a ±5-day window over a
10-day cadence spans two analysis steps. The first version took a timestep it did not
use, which put a date on the picture that the picture did not come from.

---

## Designed, not built

### N5 · Vertical exaggeration as a teaching control

**Partly built** — a "true scale" preset exists. What is still missing is the second
labelled stop and the on-screen line explaining what the comparison means.

The ocean is 4 km deep and 2000 km wide; at true scale the Bay of Bengal is a film of
water. Exaggeration is already free here (it is the ratio of the voxel shape's height
bounds, not a mesh transform), so the control exists — but it is presented as a number.

For the outreach mandate it should have **two labelled stops**: "true scale" and
"readable", with the on-screen depth labels continuing to read true metres through the
`sqrt(depth)` stretch. The lesson — *this is how thin the layer we depend on actually
is* — is the whole public-communication argument, and it is currently a slider at 40x.

### N6 · The 20 °C isotherm

**Built.** The isosurface control was generic; under a Disaster Management theme in the
Bay of Bengal it has one obvious worked example — the depth of the **20 °C isotherm**,
the standard proxy for the heat available to a tropical cyclone. A deeper D20 means more
fuel.

It now ships as a named preset that sets the threshold and shell width and says what it
is, so the first thing anyone sees the isosurface do is the thing the theme is about.

---

## N7 · Streamlines integrated on the server

Not a novelty of idea but of method. The two usual ways to draw currents are decimated
glyphs (thousands of primitives, still ugly) and GPU particle advection (a shader project
with its own silent failure modes). Integrating **RK2 streamlines in numpy** and sending
polylines is cheaper than both, and — the actual reason — it is **testable**: a wrong
integrator draws a picture that looks fine. `currents.demo()` checks it against
solid-body rotation where every streamline is a known circle, and gets 0.04 % radius
drift over 120 steps where plain Euler visibly spirals.

The honesty cost is stated in the API response and on screen: streamlines are the
instantaneous flow pattern, not particle trajectories through time.
