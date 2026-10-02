# Extending the platform — sensors, variables, ML products

The brief's *Extensible Design* item asks for a plugin-style module
for future sensors (CTDs, moorings, HF-radar, ADCP), new ocean model variables, and
machine-learning derived products. This document is that module's manual: where each kind
of addition goes, which files it touches, and what has actually been done with it.

There is no plugin framework. There are **three dicts**, each the single place its kind of
thing is registered. The API, the viewer's markers and legend, and the assistant read the
dict rather than naming what is in it; the deliberate exceptions are listed in
`03-limitations.md` L11, which also explains why a dict and not a framework. An instrument
whose source cannot be reached is reported as unavailable in the legend and the others
still draw.

| Extension point | What goes in it | File |
|---|---|---|
| `instruments.INSTRUMENTS` | An in-situ instrument: a loader returning casts, the variables it measures, its marker colour and QC vocabulary | `server/ocean/instruments.py` |
| `catalog.VARIABLES` | A gridded variable anywhere on Earth: physics, biogeochemistry, derived, or machine-learning | `server/ocean/catalog.py` |
| `sources.PARSERS` + `config.SOURCES` | A gridded provider for the Bay volume, by protocol | `server/ocean/sources.py`, `config.py` |

Every instrument emits the same `argo.Profile`: position, time, depth, values, per-level QC
flags, data mode, source file. Co-location against the model, the profile chart, the QC
display and the assistant's tools all take a `Profile`, so a new instrument inherits them.

## What the brief names, and where each stands

| Brief item | State | Where |
|---|---|---|
| CTDs | **Two readers, checked on real files.** Any CTD table as CSV/TSV via *Add casts from a text file* (`textcast.py`, live in the viewer). CTDs in the Copernicus In Situ TAC format (`*_PR_CT_*`) through `insitu.py` with no new code: checked on a Bay of Bengal cruise (R/V Shinyo Maru, 1990). None in the TAC falls near the demo date, so no CTD instrument is registered yet. | `textcast.py`, `insitu.py` |
| Moorings | **Live in the Bay.** RAMA moorings (15N, 12N, 8N 90°E) from the Copernicus In Situ TAC, drawn as markers, clicked for a profile co-located with the INCOIS analysis. | `insitu.py`, `config.INSITU_PLATFORMS`, `instruments.py` |
| ADCP | **Reader built and checked on a real file; no Bay data.** `insitu.read_profiles(..., "u")` reads TAC ADCP files, pressure converted with TEOS-10. No public ADCP falls in the Bay near the demo date. | `insitu.py`; `11-deferred.md` D-50 |
| HF-radar | **Reader built and checked on a real file; no public Indian coverage.** `insitu.read_surface_currents` reads a TAC total-vector map with its QC. Every network in the Copernicus archive is European or American. | `insitu.py`; `11-deferred.md` D-51 |
| New ocean model variables | **Live.** A variable is one entry in `catalog.VARIABLES`; every variable the cube offers was added this way, and the cube, colour bar and assistant pick each up from `/api/catalog`. | `catalog.py` |
| Machine-learning derived products | **Live.** Three neural-network products (chlorophyll, particle backscatter, particulate organic carbon, 3D to 1000 m) as cube variables, with the method on every provenance record. | `catalog.py`; `cube.py` for the weekly step |

Measured results for all of the above are in `13-eval-results.md`, *Extensible design*.

## Worked cases

Each lists the files touched. "Config line" means one entry in a list or dict, no logic.

### A mooring, CTD or ADCP already in the Copernicus In Situ TAC

The TAC publishes every platform type in one NetCDF layout; the file name says what it is
(`GL_TS_MO_…` mooring, `GL_PR_CT_…` CTD, `GL_PR_AD_…` ADCP). Find the file in the TAC's
`index_history.txt` (filter the bounding-box columns to the region), then:

- **Another mooring:** one line in `config.INSITU_PLATFORMS["mooring"]`. Nothing else.
- **A CTD set:** add `"ctd": [...]` to `config.INSITU_PLATFORMS` and one `Instrument` entry
  in `instruments.py` (copy the mooring entry, including its `notes`; drop `nearest_only`,
  since each CTD cast is its own station). The viewer's markers, legend and counts come
  from the registry, and `notes` carries the reader's assumptions (pressure to depth, the
  QC scale) to the profile panel.
- **An ADCP:** as the CTD, with `variables={"u", "v"}`. Drawing and clicking work. The
  comparison needs a model with currents in `config.SOURCES`; the INCOIS analyses have
  none, so `/api/profile` answers 422 with that reason rather than a wrong chart (D-50).

What the reader already handles, because real files needed it: depth that varies per
record, a repeated depth axis, surface-only records sharing the time axis, pressure
instead of depth, float QC with gaps, and flag 0 meaning "never checked".

### A sensor in a new file format

Write one reader module that returns `list[argo.Profile]`, with a `demo()` against a real
file, and register it in `instruments.py`. `glider.py` (IOOS ERDDAP, QARTOD flags) is the
worked example: it was the second instrument and needed no change downstream. Keep the
source's own QC vocabulary; do not map it onto Argo's (`glider.py` explains why QARTOD 2
is not Argo 2).

### A sensor that is not a profile

A surface-current grid (HF-radar) or a time series at a point (a mooring's record over
months) is not a `Profile`. `insitu.read_surface_currents` shows the pattern for a grid:
its own small dataclass carrying QC and provenance. Drawing it would be a surface layer,
not a marker; that viewer layer is D-51. A mooring's time-series view is D-52.

### A new model variable

One `Variable` in `catalog.VARIABLES`: the Copernicus dataset and its variable name per
era, units, a palette id from `viewer/src/colorbar.ts`, and a group. Derived variables
(density, sound speed) name their inputs and formula instead. `catalog.demo()` checks that
every entry has a title, a native level count and a source.

### A machine-learning derived product

The same as a model variable, in group `"ml"`, with two extra fields:

- `method` — how the values were made, with the reference. It travels in every
  provenance record, the catalogue and the viewer's provenance panel, so an estimate is
  never mistaken for a measurement or a model run. `catalog.demo()` fails if an `ml`
  variable has none.
- `step_days` on its `Era`, when the product is not daily. The cube then takes the nearest
  step within half a period and records which step and how far away (`cube._open`).

The three live ones are `MULTIOBS_GLO_BIO_BGC_3D_REP_015_010` (Sauzède et al. 2016, SOCA):
a neural network estimating vertical chlorophyll and backscatter from surface ocean colour
and hydrography, trained on BGC-Argo floats. Set beside the PISCES model's chlorophyll,
it gives two independent estimates of the same water.

### A gridded provider for the Bay volume

A `_fetch_*` function, a line in `sources.PARSERS`, a `Source` in `config.py`. The
Copernicus path (`_fetch_copernicus`) was added this way after INCOIS ERDDAP.

## Checks left behind

    python -m server.ocean.instruments   # the registry asks each instrument only for what it measures
    python -m server.ocean.insitu        # mooring, ADCP and HF-radar readers on real files
    python -m server.ocean.catalog       # every variable sourced; every ML product labelled
    python -m server.eval.run_eval --extensible   # the numbers in 13-eval-results.md
    python -m pytest server/tests        # all of the above, via test_extensible.py

`python -m server.tools.fetch_fixtures` pulls the real files they run against.
