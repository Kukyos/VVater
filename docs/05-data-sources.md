# Data sources — verified, not assumed

Everything here was probed from this machine on **2026-09-22**. Nothing in this file is
quoted from documentation. Where a probe failed, it says so. Re-run the probes in
`server/tools/probe_sources.py` before quoting any of it in a deck.

---

## The headline

**The problem statement's own dataset links do not work.** Both Argo and Glider links are
`ftp://`, and port 21 is blocked — `ftp.ifremer.fr` fails to connect at all. Every source
below is an HTTPS path we found and tested ourselves.

This is worth saying out loud in the proposal. A platform that ingests what INCOIS
actually serves is worth more than one built against a link that times out.

---

## 1 · Model / gridded fields

### 1.1 INCOIS ERDDAP — primary. No credentials. (**verified working**)

`https://erddap.incois.gov.in/erddap/`

INCOIS runs a public ERDDAP with **15 gridded datasets and 2 tabular ones**, all with
WMS endpoints. Two of them are genuinely 4D and are what this platform renders:

| Dataset ID | Method | Variables |
|---|---|---|
| `incois_argo_10d_VAM` | Variational Analysis | `TEMP`, `SAL`, **`TERR`**, **`SERR`** (per-cell error) |
| `incois_argo_10day_McCreary` | Kessler–McCreary | `T_ANALYZED`, `S_ANALYZED`, `*_STDEV`, `*_RMSE`, `*_ROIOBS`, `*_BOXOBS` |

Monthly equivalents exist (`incois_argo_mnt_VAM`, `incois_argo_mnt_McCreary`).

**Grid, measured from a real fetch:**

```
time       813 steps, ~10-day cadence, 2004 → 2026-07-30
ZAX         24 levels, 5 – 2000 m, non-uniform (5,10,20,30,50,75,100,125,150,200,
                                                250,300,400,500,600,700,800,900,
                                                1000,1200,1400,1600,1800,2000)
latitude    60 @ 1.0°   (29.5°S – 29.5°N)
longitude   90 @ 1.0°   (30.5°E – 119.5°E)
```

**Measured Bay of Bengal subset** (78–100°E, 5–23°N, 10 timesteps, 3 variables):
`10 × 24 × 19 × 23` → **1.26 MB in 0.86 s**, opens clean in xarray, `Conventions =
CF-1.6, COARDS, ACDD-1.3`, values 2.57 – 31.85 °C, ~50 % finite (the rest is land and
bathymetry mask, correct for a box containing India and Myanmar).

Subset URL shape — this is the whole ingestion API:

```
/erddap/griddap/incois_argo_10d_VAM.nc
  ?TEMP[(2026-05-01):1:(2026-07-30)][(5.0):1:(2000.0)][(5.0):1:(23.0)][(78.0):1:(100.0)]
```

**Why this is primary and not the fallback:** it is INCOIS's own product, served by
INCOIS, needing no account, and it ships **per-cell error fields**. A platform that can
render the analysis *and* its uncertainty is doing something the problem statement did
not think to ask for.

**CF messiness to handle, found in the real file:** `TEMP` has `units = "degs"` (not a
UDUNITS string), no `standard_name`, and `ZAX` carries no `positive` attribute. The
ingest layer normalises these and records that it did. Do not assume CF compliance just
because the global attribute claims it.

### 1.2 Copernicus GLORYS12 — secondary, high resolution (**verified working**)

`cmems_mod_glo_phy_my_0.083deg_P1D-m` via the `copernicusmarine` toolbox 2.4.1.
Credentials are in `.env` and `login()` succeeds.

**Measured subset** (Bay of Bengal box, one day, `thetao`/`so`/`uo`/`vo`):

```
time 1 x depth 50 x latitude 217 x longitude 265
23.04 MB on disk, 92 MB in memory, 39.9 s to fetch
depth 0.494 - 5727.9 m      CF-1.4, positive=down, proper standard_names
```

Two things follow. **It carries `uo`/`vo`, so currents exist only here** — the INCOIS
Argo analyses have none. And **it is where the volume budget in L1 actually bites**: one
day of four variables is 23 MB against the INCOIS field's 0.55 MB for thirteen timesteps.
A 30-day animation is ~700 MB, which is the LRU cache's whole reason for existing.

**Global surface layers, current** (`globalsurface.py`): dataset
`cmems_mod_glo_phy-all_my_0.25deg_P1D-m` (product GLOBAL_MULTIYEAR_PHY_ENS_001_031), the
`_glor` members of `thetao so uo vo siconc zos mlotst`, depth 0–1 m, 180 W–180 E, 80 S–90 N,
one file per analysis date. Measured 2026-09-23: **27.5 MB and ~16 s per date**, 1440 x 681,
native 1/4°, nothing resampled. All 13 dates fetched by `--warm`: ~360 MB in `data/cache`.
Sea level, mixed layer depth and ice have no depth axis. This replaced the block-meaned
1/12° subset below.

**Global surface subset, superseded** (the first version of the context layer):
`thetao`, depth 0-1 m (one level, 0.494 m), 180 W-180 E, 80 S-90 N, one day. Measured
2026-09-23: **16.84 MB** download, ~25 s cold, cached as
`data/cache/global_thetao_surface_2018-08-25.nc`; served as a 3x3 block mean, 1440 x 680.

NOAA OISST v2.1 on the CoastWatch ERDDAP (`ncdcOisst21Agg_LonPM180`) was probed first for
the same layer, because it needs no credentials: both it and NCEI's THREDDS timed out from
this network on 2026-09-23 (curl exit 28, no TCP connection). GLORYS12 was already wired
in, so the layer uses it and adds no new source.

Unlike the INCOIS product it is properly CF-compliant — `positive="down"` is present, the
units are UDUNITS, the standard names are real. The defensive normalisation in `cf.py`
exists for the INCOIS path, not this one.

### 1.3 INCOIS LAS — reachable, lower priority

`https://las.incois.gov.in/las/` responds. It exposes a JSON API (`getCategories.do`,
`getDatasets.do` — the latter returns 17 MB of dataset metadata) and a THREDDS catalog
at `/thredds/catalog.xml`. ERDDAP gives us the same data in a far easier form, so LAS is
a documented alternative rather than a build target.

### 1.4 Copernicus ARCO stores — the whole ocean, any day (**verified working, 2026-09-24**)

Every Copernicus dataset is also published as a Zarr store on public S3 ("ARCO",
analysis-ready cloud-optimised). This is what makes the v2 cube global: no download of a
subset file per request, just the chunks a box touches. `server/ocean/arco.py`.

**How it is opened.** The toolbox's `open_dataset` builds a catalogue query and a dask
graph per call; opening a whole dataset that way had not finished after ten minutes. So
the toolbox is used only to look up the store URL (cached in
`data/cache/arco/store_urls.json`), and the store is opened with the toolbox's own S3
store class and `xarray.open_zarr(chunks=None)`: lazy indexing, no dask.

**Measured** on `cmems_mod_glo_phy_my_0.083deg_P1D-m` (`timeChunked.zarr`):

| Operation | Time |
|---|---:|
| open the store (once per process) | 3.6–6.8 s |
| one day, 15° × 15°, all 50 levels, cold | 5–9 s |
| the same, from the chunk cache | 0.4 s |
| one day, the whole globe, one level, native 1/12° | 0.6 s |

A chunk is one depth level of one day, 512 × 2048 cells (about 42° × 170°), 0.78 MB
compressed on average. Cold reads run at about 13 MB/s from this network, so cost scales
with **how many chunks a box touches**, not with its area: a basin-sized box costs about
what a small one crossing a chunk edge costs. Chunks are cached on disk.

**Time coverage, read from each store's own time axis** (the catalogue reads it again every
day; nothing below is hardcoded):

| Dataset | Variables | From | To |
|---|---|---|---|
| `cmems_mod_glo_phy_my_0.083deg_P1D-m` (reanalysis + interim) | thetao so uo vo zos mlotst bottomT siconc sithick | 1993-01-01 | 2026-06-23 |
| `cmems_mod_glo_phy-{thetao,so,cur,wcur}_anfc_0.083deg_P1D-m` | thetao so uo vo wo | 2022-06-01 | 2026-10-03 |
| `cmems_mod_glo_phy_anfc_0.083deg_P1D-m` | zos mlotst tob siconc … | 2022-06-01 | 2026-10-03 |
| `cmems_mod_glo_bgc_my_0.25deg_P1D-m` | chl no3 nppv o2 po4 si | 1993-01-01 | 2026-05-31 |
| `cmems_mod_glo_bgc-{pft,bio,nut,car}_anfc_0.25deg_P1D-m` | chl phyc o2 nppv no3 po4 si fe ph dissic talk | 2021-11-01 | 2026-10-03 |

The eras overlap by years, so there is **no gap** from 1993 to nine days ahead of today.
The reanalysis is preferred wherever it covers (`catalog.resolve`); days after today are a
**forecast** and are labelled so in every response.

**Vertical axis.** Physics: 50 levels, 0.494 m to 5,727.9 m. BGC reanalysis: 75 levels.
BGC analysis-forecast: 50. The stores name the axis `elevation` and hold **negative**
metres, while its attributes still say `standard_name=depth`, `positive=down`. The data
and the metadata disagree. We read `depth = -elevation`, record that assumption in every
cube's provenance, and pin it with physics (`python -m server.ocean.cube --live`: North
Atlantic, August, surface 27.9 °C, 1,942 m 3.8 °C).

**Bathymetry** is `deptho` in the static dataset `cmems_mod_glo_phy_my_0.083deg_static`,
part `bathy`, service `static-arco` (not `arco-geo-series`, which the static dataset does
not have).

**Credentials.** The stores read anonymously; the toolbox login is only used for the
catalogue lookup of the URL.

### 1.5 Wind and waves — Copernicus Marine ARCO (**verified working, 2026-09-24**)

Read by `server/ocean/marine.py` through the same store reader as §1.4. Each day is read
at **12:00 UTC**, and every response says so.

| Dataset | Variables | From | To | One read, cold |
|---|---|---|---|---|
| `cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H` (WIND_GLO_PHY_L4_NRT_012_004) | `eastward_wind`, `northward_wind` (10 m stress-equivalent, m s-1) | 2020-07-01 | yesterday (2026-09-23 when probed) | open 3-6 s, one global hour 4.1-4.4 s (1440 x 2880) |
| `cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H` (WIND_GLO_PHY_L4_MY_012_006) | the same | 2007-01-11 | 2026-05-21 | open 6.0 s, one global hour 3.1 s |
| `cmems_mod_glo_wav_anfc_0.083deg_PT3H-i` (GLOBAL_ANALYSISFORECAST_WAV_001_027) | `VHM0` significant wave height, m | 2022-11-01 | ten days ahead (2026-10-04 when probed) | open 3.2 s, one global instant 3.7 s (2041 x 4320) |

The wind is an **observation** product (scatterometers blended with ECMWF), so it has no
wind for today or later. Days before July 2020 are read from the reprocessed store.

**Wind forecast: NCEP GFS 0.25 deg through UCAR THREDDS** (**verified working,
2026-09-24**). For days after the observed record ends:

    https://thredds.ucar.edu/thredds/ncss/grid/grib/NCEP/GFS/Global_0p25deg/Best
      ?var=u-component_of_wind_height_above_ground&var=v-component_of_wind_height_above_ground
      &time=2026-09-27T12:00:00Z&vertCoord=10&accept=netcdf4[&horizStride=2 | &west=..&east=..&south=..&north=..]

No credentials; NetCDF back, read by xarray with nothing new installed. The "Best"
collection covered 2026-09-17 to 2026-10-10 when probed (a week back, about sixteen days
ahead). One global field at stride 2 (1/2 deg, 720 x 361) is 1.5 MB and took 3.6-4.4 s; a
17 x 15 deg box at 1/4 deg took 1.9 s. Latitude comes north row first and longitude 0-360;
both are normalised in `marine._gfs`, and a box across the date line is read in two pieces.
It is a model forecast of 10 m wind, not stress-equivalent wind, and every response says
which of the two it is.
The global wind for the animation is block-averaged 4:1 to 1/2 degree (720 x 360, 2 MB for
u and v); only the reduced arrays are cached.

---

## 2 · In-situ observations

### 2.1 Argo GDAC over HTTPS — (**verified working**)

`https://data-argo.ifremer.fr/` — the FTP host is dead, this mirror is not. Range
requests supported (HTTP 206).

**The ingestion unit** is the per-day, per-basin aggregate:

```
/geo/indian_ocean/YYYY/MM/YYYYMMDD_prof.nc
```

**Measured** (`20260715_prof.nc`): 8.7 MB, 3.7 s, `N_PROF = 97`, `N_LEVELS = 2001`.
Carries everything needed: `PLATFORM_NUMBER`, `LATITUDE`, `LONGITUDE`, `JULD`, `PRES`,
`TEMP`, `PSAL`, all three `*_ADJUSTED` counterparts, `DATA_MODE`, and per-level
`PRES_QC` / `TEMP_QC` / `PSAL_QC` / `POSITION_QC`.

Do **not** download `ar_index_global_prof.txt` — it is 317 MB.

**Measured facts that shape the design:**

- `DATA_MODE` on that day: **62 adjusted (A), 35 real-time (R)**. The majority of
  profiles have an adjusted field, so `TEMP_ADJUSTED` is the default and `TEMP` is the
  fallback — not the other way round.
- `TEMP_QC` flags present: `1` × 65,728 (good), `3` × 4 (probably bad), `4` × 72 (bad),
  remainder fill. So bad data is rare but **present**, and a pipeline that ignores QC
  will render it.
- **Coverage is the real constraint: only 2 of those 97 profiles fell inside the Bay of
  Bengal box.** One day of floats is not a visualisation. A 10-day window gives roughly
  20 profiles — and 10 days is exactly the cadence of the gridded product in §1.1.

> **Design consequence:** the float overlay and the gridded field share a 10-day window
> by default. That is not a convenience, it is what makes the co-location in
> `docs/03-requirements.md` §3.6 scientifically meaningful — the same water, the same
> ten days.

### 2.2 INCOIS ERDDAP `Indian_ARGO_Floats` — tabular, INCOIS-native

A tabledap dataset of Indian Argo floats. Worth ingesting as the INCOIS-native
observation path alongside the GDAC files.

### 2.3 Gliders — **found, after the brief's own link failed**

`ftp://ftp.ifremer.fr/ifremer/glider/v2/` is dead with the rest of FTP. Two live HTTPS
archives replace it:

**IOOS Glider DAC** — `https://gliders.ioos.us/erddap/` (**verified working, in use**)

ERDDAP tabledap, no credentials, queryable by bounding box. Filtering all **2,562**
datasets by bounding box gives exactly **two** that touch the Indian Ocean and **one**
that flies inside the Bay of Bengal:

| | |
|---|---|
| `ru29-20180812T0220` | Rutgers *Challenger* mission. 5.02–8.67°N, 80.10–82.98°E, 12 Aug – 1 Nov 2018 |
| `ru29-20161105T0131` | 84.67–115.17°E, 32.84°S–0.02°N — Indian Ocean crossing, south of our box |

Measured: `time,latitude,longitude,depth,temperature,salinity,profile_id` clipped to the
region is **1.06 MB in 5.4 s**, 26,189 rows, **224 casts**, depth 1.03–962.4 m,
temperature 6.57–29.15 °C, salinity 33.64–35.57 PSU.

Inside the region it flies **12 Aug – 2 Sep 2018** (then leaves and briefly returns in
late October). That window is what fixes the demo date.

**EGO / Coriolis glider GDAC** — `tds0.ifremer.fr/thredds/catalog/CORIOLIS-GLIDERS-GDAC-OBS/`
(**reachable, not yet wired**)

This is literally the archive the brief's dead FTP link served, alive over THREDDS with
OPeNDAP and direct file access. **184 gliders**, global, 0–2000 m, `TEMP`/`PSAL`/`DOXY`.
Its catalogue is per-glider with no spatial index, so finding Indian Ocean deployments
means walking 184 catalogues — logged as `11-deferred.md` D-02.

> **Finding worth stating in the proposal:** glider coverage in the Bay of Bengal is not
> thin, it is **nearly absent** — one deployment in 2,562. The brief presents gliders as
> a routine data stream alongside Argo. For this region, they are not.

### 2.4 Argo anywhere — Ifremer ERDDAP (**verified working, 2026-09-24; not yet wired**)

The GDAC day-files in §2.1 are per basin. For a cube anywhere on Earth the query has to be
by box and time. Ifremer's ERDDAP answers exactly that, no credentials:

| Dataset | Query (60° × 40° box, 10 days) | Response |
|---|---|---:|
| `ArgoFloats` (core) | `platform_number,cycle_number,time,latitude,longitude&time>=…&latitude>=…&distinct()` | 11 KB, 5.5 s |
| `ArgoFloats-synthetic-BGC` | same, over 40 days | 13 KB, 4.3 s |

The BGC set carries chlorophyll and oxygen from the floats themselves, which is the
in-situ chlorophyll the brief names (`11-deferred.md` D-04). Argovis
(`argovis-api.colorado.edu`) answers the same box query in 2.2 s and is the fallback.

### 2.5 What INCOIS itself publishes on ERDDAP (probed 2026-09-24)

`erddap.incois.gov.in` lists 17 datasets: the Argo 10-day and monthly analyses (VAM and
Kessler-McCreary), a weekly Argo SST, `Indian_ARGO_Floats`, Oceansat-2 and IRS chlorophyll,
and ASCAT, QuikSCAT, TMI, AMSR-E and AVHRR satellite products. **No INCOIS numerical ocean
model output is public there.** So the INCOIS analyses stay first-class where they cover,
and the global model field comes from Copernicus.

### 2.6 INCOIS Potential Fishing Zone advisories (**verified working, 2026-09-24**)

INCOIS publishes its PFZ advisories as HTML text, per coastal sector, on its Marine
Fisheries pages. There is no API and no feed; `server/ocean/pfz.py` reads the pages.

    https://incois.gov.in/MarineFisheries/TextDataHome?mfid=1&request_locale=en   (session cookie)
    https://incois.gov.in/MarineFisheries/TextData?secid=SEC001 ... SEC014

Fourteen sectors, Gujarat (SEC001) round to Lakshadweep (SEC014). A sector with an advisory
carries "SATELLITE DATA SHOWS LIKELY AVAILABILITY OF FISH STOCK TILL <date>" and one table:
*From the coast of, Direction, Bearing (deg), Distance (km) From-To, Depth (mtr) From-To,
Latitude (dms), Longitude (dms)*. A sector under cloud says "No data available for this
sector due to excessive cloud cover". On the probe day four sectors had advisories (Gujarat
110 points, Maharashtra 80, Andaman 20, Nicobar 24, valid till 25 Sep 2026) and ten were
clouded out: in the monsoon, satellite SST is often blind.

The page is meant for people, so the parser checks the table's headings exactly and fails
loudly if they change (`python -m server.ocean.pfz` runs against a saved, trimmed page in
`server/tests/fixtures/`). Advisories are fetched at most once an hour. The same pages sit
behind INCOIS's incomplete certificate chain as ERDDAP, handled as in D-06.

---

## 3 · Toolchain — resolved

Probed into a throwaway venv on **Python 3.14.3**. Everything installs clean:

```
copernicusmarine 2.4.1   xarray 2026.7.0   netCDF4 1.7.4   gsw 3.6.23
h5netcdf 1.8.1           zarr 3.4.0        dask 2026.8.0   pandas 3.0.6
```

**Decision: stay on Python 3.14.** The pinned-3.12 fallback in the build plan is not
needed and is dropped.
