# The limitations map

Written before any code, because each item here fixes a number everything downstream
depends on. Revised 2026-09-22 after the source probes in `05-data-sources.md` — three
items changed once real data was in hand, and those changes are marked.

---

## L1 · Data volume — not the constraint people assume

Bay of Bengal (78–100°E, 5–23°N) on the INCOIS 1° grid: `23 lon × 19 lat × 24 depth =
10,488 voxels`. That is **42 KB as float32**. Even Copernicus GLORYS12 at 1/12° and 50
levels is `264 × 216 × 50 = 2.85 M voxels` — 11.4 MB float32, 2.85 MB as uint8.

A single volume is nothing. **The cliff is time × variables, not one volume.**

> **Constraint:** one variable, one timestep resident at full resolution. Time animation
> streams and evicts through an LRU cache with prefetch-ahead. Multi-variable comparison
> is two volumes maximum.

At INCOIS resolution the whole 813-step time series for one variable is ~34 MB, so the
demo can hold the entire archive in memory. That headroom is spent on Copernicus later,
not on widening the region now.

## L2 · The vertical axis — revised

> **This was wrong in the first draft and is corrected here.**

The original scheme was 64 bins uniform in `sqrt(depth)`. That was written against
GLORYS12's ~50 levels with ~1 m surface spacing. The primary source has **24 levels,
5–2000 m**. Resampling 24 native levels up to 64 bins invents structure that is not in
the data — in the thermocline, which is exactly where an oceanographer looks hardest.

> **Constraint:** `regrid.py` **never produces more output levels than the source has
> native levels.** Assert it. The bin count is a per-source value in `config.py`, not a
> global constant. For INCOIS it is 24; for Copernicus it will be its own native count.

Cesium voxel grids are uniform along each axis and the native levels are not
(5, 10, 20, 30, 50, 75, 100, …, 2000). So the stretch remains — uniform in
`sqrt(depth)` — but it is used **only to make an existing level set renderable on a
uniform grid, never to add levels**. The stretch function goes in the provenance record
and every depth label in the viewer is computed back through it. A raw voxel index is
never shown as a depth.

There is no `positive` attribute on `ZAX` in the real file, so the depth sign is an
assumption our ingest layer makes. See V3 for the test that pins it.

**Vertical exaggeration** (a problem-statement requirement) is therefore free: it is the
ratio of the voxel shape's height bounds, not a mesh transform.

## L3 · Volumetric rendering — solved, in exactly one way

CesiumJS ships the raymarcher. `VoxelPrimitive` accepts a `customShader` whose fragment
function **runs at every step along the ray**, alpha-composited to the final pixel. A
custom `VoxelProvider.requestData()` returning `VoxelContent.fromMetadataArray([...])`
streams typed arrays straight from the API — no 3D Tiles tileset on disk.

The ceiling: `VoxelPrimitive` is `@experimental` in Cesium and takes breaking changes
without deprecation. **Pin the Cesium version exactly** and log it in `11-deferred.md`.

## L4 · Current vectors — naive glyphs do not survive

At Copernicus resolution a full-column glyph field is 2.85 M arrows. Cesium will not draw
that.

> **Constraint:** two paths. (a) instanced, decimated glyphs on the active depth slice,
> adaptive to camera distance — what a forecaster reads values off. (b) GPU particle
> advection on a slice texture — cheaper to render than the glyphs and the best-looking
> thing in the demo.

Note the INCOIS Argo analyses carry **no current vectors**. Currents arrive with
Copernicus, so this whole item is gated on credentials.

## L5 · Argo is much messier than the problem statement implies

The brief lists "latitude, longitude, depth, time, temperature, salinity, chlorophyll" as
if it were a CSV. Measured from one real day-file:

- **`DATA_MODE` was 62 A / 35 R.** Most profiles have an adjusted field, so
  `TEMP_ADJUSTED` is the default and `TEMP` the fallback — not the other way round.
- **QC flags are real and non-empty**: `1` x 65,728, `3` x 4, `4` x 72. Bad data is rare
  but present. A pipeline that ignores QC will render it.
- Argo reports **pressure, not depth**. `gsw.z_from_p` needs latitude.
- **Chlorophyll is not in these files** — BGC lives in separate `Sprof` files.

> **Hard rule:** no observation is displayed without its QC flag, its data mode (R/A/D)
> and its source file recorded. A profile failing QC is shown as rejected, never silently
> dropped.

## L6 · Float coverage is thin — new, from measurement

Of 97 Indian Ocean profiles on 2026-07-15, **2 fell inside the Bay of Bengal box.** One
day of floats is not a visualisation.

The gridded analysis runs on a 10-day cadence, which suggests a 10-day float window. But
the McCreary product's own `T_BOXOBS` field counts **28–30 profiles per analysis step**
over the same box, against ~20 for a strict 10-day bucket — so **the analysis assimilates
a window wider than its cadence.**

> **Constraint:** floats are paired to an analysis step by **±5 days centred on the
> timestamp**, and the provenance record states that the analysis's own window is wider
> than the display window, with the measured counts. We show the pairing we can defend,
> and we say what we do not know.

**Measured afterwards, and the estimate above was low.** A ±5-day window actually yields
**42 profile-instances, 38 usable** — floats revisit the box inside the window. That sits
neatly against the analysis's own `T_BOXOBS` of 28–30 per step, so ±5 days turns out to
be well matched to what the analysis assimilates. The rule stands; the guess behind it
did not. See `13-eval-results.md`.

## L7 · Model–observation co-location is the actual scientific claim

The brief's central promise is to correlate model predictions with observational
evidence. That means interpolating the gridded field onto a float's lat/lon/time/depth
across mismatched grids and vertical coordinates. Get it wrong and the headline feature
is quietly, invisibly wrong.

> **Constraint:** co-location is its own module with its own tests, not a viewer
> convenience. `xarray.Dataset.interp()` does the work in a few lines; **the tests are
> the deliverable.** Every comparison carries the interpolation method and the
> model–float separation in space and time.

## L8 · OGC compliance is a claim a judge can check

THREDDS and ncWMS exist. We will not out-build them.

- **CF conventions — honoured properly, and defensively.** The real file claims
  `Conventions = CF-1.6` and then gives `TEMP` a `units` of `"degs"`, no `standard_name`,
  and no `positive` on the depth axis. The ingest layer normalises and **records that it
  normalised**. Never trust the global attribute.
- **WMS — minimal and real.** `GetCapabilities` + `GetMap` over the same subsetter that
  makes the 2D slices. Demonstrable in QGIS on stage. Note INCOIS ERDDAP already serves
  WMS for these datasets, so ours is about proving the pattern, not replacing theirs.
- **WCS — deferred, and logged as deferred.** Claiming it unbuilt loses more than it
  gains.

## L9 · Gliders may simply not be obtainable

FTP is dead and no HTTPS mirror was found (`05-data-sources.md` §2.3). The overlay is
built against the schema — a glider is a moving platform emitting a sawtooth of profiles,
a superset of the Argo case — and shares the Argo code path. **No real glider file has
been ingested.** Stays in `10-unsourced.md` until one is. No synthetic glider track
appears anywhere without being labelled synthetic.

## L10 · Uncertainty is available and most platforms throw it away

`incois_argo_10d_VAM` ships `TERR` and `SERR` — per-cell relative error — and the
McCreary variant ships `*_STDEV`, `*_RMSE` and per-cell observation counts.

> **Constraint (opportunity, really):** the error field is a second metadata channel in
> `VoxelContent.fromMetadataArray([value, error])`, and the shader modulates per-step
> alpha by it. Low-confidence water renders faint. This costs a few lines of GLSL and
> shows a forecaster something the brief did not think to ask for.

## L11 · "Plugin-style extensible module" is an over-engineering trap

The brief asks for new sources "with minimal code change." A **dict of parsers keyed by
format**, in one file, satisfies that completely. No plugin framework for two parsers.
Documented as a judgement call so it does not read as laziness.

## L13 · Faces of the Ocean Cube — a display interpolation, logged (v2, 2026-09-24)

The v2 cube (`viewer/src/cube/`) is sent on the dataset's **native levels only**
(`server/ocean/cube.py`), so the data obeys L2 exactly. Its faces are images, and an image
has more rows than the ocean has levels: a 512-row wall over 40 native levels has to put
something in the rows between them.

> **Decision:** by default a face is **interpolated linearly between native levels and
> bilinearly between cells**, which is how oceanographic sections are conventionally
> drawn. This is a display choice over the same native values, never a new level in the
> data, and every provenance panel says so. **"Native levels only"** switches every face
> to the level whose cell contains each depth, nearest grid cell horizontally: the data as
> it is, in bands.

Two refusals, both in `cube/data.ts`: nothing is drawn below the deepest native level
with water (between the last water level and the next it holds to the midpoint, then the
sea floor begins), and a coastal pixel takes its nearest water neighbour rather than
blending towards land.

**The depth axis** of a face is linear or `sqrt(depth)`-stretched (default, so the upper
few hundred metres are readable). Every tick, slider label and probe readout is computed
from metres through that mapping and back (`depthToT` / `tToDepth`), never from a pixel or
voxel index — hard rule 4.

**The cube stands on the sea surface** rather than sitting below it where the water is.
Below the surface it needed a translucent globe, disabled collision detection and a
clipped translucency rectangle, and at glancing angles it turned to haze. The footprint is
exactly the box's; only the vertical is re-placed, and `CubeScene.depthOf` maps every
height back to a depth.

## L12 · Python 3.14 — resolved, not a limitation

Probed: `copernicusmarine 2.4.1`, `xarray 2026.7.0`, `netCDF4 1.7.4`, `gsw 3.6.23`,
`h5netcdf`, `zarr 3.4.0`, `dask` all install clean on 3.14.3. **Staying on 3.14.** The
pinned-3.12 fallback is dropped.

---

## Verification these imply

- **V1** — `regrid.py` asserts output levels never exceed native levels (L2).
- **V2** — QC filtering tested against the measured flag counts in L5.
- **V3** — **the one test that is not self-consistency.** `ZAX` has no `positive`
  attribute, so the depth sign is our assumption. The co-location fixture pins it with
  physics, not metadata: a surface value must be warm (~28–30 °C in the Bay of Bengal)
  and a 2000 m value must be cold (~2–4 °C). Measured range from the real subset is
  2.57 – 31.85 °C. An inverted depth axis fails this instantly and passes every
  self-consistency check ever written.
- **V4** — co-location checked against a hand-computed nearest-neighbour value read
  straight from the raw NetCDF at that lat/lon/time, to catch a transposed dimension.
