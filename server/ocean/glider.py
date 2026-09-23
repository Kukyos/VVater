"""Glider ingestion.

The problem statement points at `ftp://ftp.ifremer.fr/ifremer/glider/v2/`, which does not
resolve — port 21 is blocked and the host does not answer. Two live HTTPS replacements
were found instead (`docs/05-data-sources.md` 2.3):

  * **IOOS Glider DAC** (`gliders.ioos.us/erddap`) — tabledap, no credentials, queryable
    by bounding box. This is what we read.
  * **EGO/Coriolis glider GDAC** (`tds0.ifremer.fr/thredds/.../CORIOLIS-GLIDERS-GDAC-OBS`)
    — 184 gliders over THREDDS/OPeNDAP. This is literally the archive the dead FTP link
    served. Not yet wired: its catalogue is per-glider with no spatial index, so finding
    Indian Ocean deployments means walking 184 catalogues (`11-deferred.md` D-02).

A glider is a moving platform flying a sawtooth, so one deployment is a *sequence* of
profiles at drifting positions — structurally a superset of the Argo case. We split on
`profile_id` and emit the same `argo.Profile` objects, so everything downstream
(co-location, QC, provenance, the profile chart) works unchanged.

Depth arrives already in metres here rather than as pressure, so there is no TEOS-10 step.
"""

from datetime import date, timedelta
from pathlib import Path

import numpy as np
import requests
import xarray as xr

from . import config
from .argo import Profile

IOOS_BASE = "https://gliders.ioos.us/erddap/tabledap"

# Fields we ask for. `profile_id` is what turns a trajectory back into casts.
FIELDS = ["time", "latitude", "longitude", "depth", "temperature", "salinity",
          "profile_id", "qartod_temperature_primary_flag", "qartod_salinity_primary_flag"]

VARIABLE_COLUMN = {"temperature": "temperature", "salinity": "salinity"}

# The aggregate QARTOD flag per variable. This DAC runs the full QARTOD battery
# (gross range, spike, rate of change, flat line, climatological) and publishes both the
# individual test flags and this roll-up.
QC_COLUMN = {"temperature": "qartod_temperature_primary_flag",
             "salinity": "qartod_salinity_primary_flag"}

# QARTOD numbering is NOT Argo numbering, and conflating them is a real trap:
#   QARTOD  1 pass   2 not evaluated   3 suspect   4 fail   9 missing
#   Argo    1 good   2 probably good   3 probably bad   4 bad
# A QARTOD 2 means nobody checked, not "probably good", so accepting it is a decision
# rather than a reading. We accept 1 and 2 and record that 2 means unevaluated.
QARTOD_ACCEPT = frozenset({1, 2})
QARTOD_NOTE = ("QARTOD aggregate flag; accepted {1 pass, 2 not evaluated}. "
               "QARTOD 2 means unevaluated, not 'probably good' as in Argo.")
UNEVALUATED_NOTE = ("QARTOD columns are declared but empty for this deployment, so no "
                    "quality control has been applied to these levels. Reported as "
                    "data_mode 'U' (unevaluated), never as passing.")


def fetch_deployment(dataset_id: str, cache_dir: Path, fmt: str = "nc") -> Path:
    """Download one deployment, already clipped to the configured region.

    `fmt="csv"` fetches the same rows as delimited text, which is what textcast.demo()
    checks the text parser against."""
    lon0, lon1 = config.REGION["lon"]
    lat0, lat1 = config.REGION["lat"]
    path = cache_dir / f"glider_{dataset_id}_bob.{fmt}"
    if path.exists():
        return path

    cache_dir.mkdir(parents=True, exist_ok=True)
    query = (
        f"{','.join(FIELDS)}"
        f"&latitude>={lat0}&latitude<={lat1}"
        f"&longitude>={lon0}&longitude<={lon1}"
    )
    resp = requests.get(f"{IOOS_BASE}/{dataset_id}.{fmt}?{query}", timeout=config.HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(f"IOOS {resp.status_code} for {dataset_id}: {resp.text[:300]}")
    path.write_bytes(resp.content)
    return path


def read_profiles(path: Path, variable: str = "temperature",
                  centre: date | None = None, days: float | None = None) -> list[Profile]:
    """Split a deployment into casts, optionally limited to a time window.

    Per-level QC comes from the DAC's aggregate QARTOD flag where it exists.

    For `ru29-20180812T0220` it does not: the columns are declared and **entirely empty**.
    The dataset's own history says the QARTOD flag standard changed in 2022, and this is a
    2018 deployment, so the battery was never run on it.

    That makes "rejected by QC" and "QC never run" two different things, and collapsing
    them would be a lie in either direction — rejecting everything throws away good data,
    accepting silently claims a check that never happened. So:

        data_mode 'Q'  flags present, QARTOD applied, rejections are real
        data_mode 'U'  flags absent, every level unevaluated and marked as such

    Argo's R/A/D vocabulary is deliberately not reused; it does not apply to this archive.
    """
    column = VARIABLE_COLUMN[variable]
    qc_column = QC_COLUMN[variable]
    days = config.FLOAT_PAIRING_DAYS if days is None else days

    out: list[Profile] = []
    with xr.open_dataset(path) as ds:
        times = ds.time.values
        if centre is not None:
            lo = np.datetime64(centre - timedelta(days=days))
            hi = np.datetime64(centre + timedelta(days=days))
            window = (times >= lo) & (times <= hi)
        else:
            window = np.ones(times.shape, dtype=bool)

        ids = ds.profile_id.values
        depth = ds.depth.values.astype(float)
        value = ds[column].values.astype(float)
        flags = (ds[qc_column].values.astype(float) if qc_column in ds
                 else np.full(value.shape, np.nan))
        # Declared-but-empty is the common case for pre-2022 deployments.
        evaluated = bool(np.isfinite(flags).any())
        lat = ds.latitude.values.astype(float)
        lon = ds.longitude.values.astype(float)
        name = path.stem.replace("glider_", "").replace("_bob", "")

        for pid in np.unique(ids[window]):
            sel = window & (ids == pid)
            good = sel & np.isfinite(depth) & np.isfinite(value)
            if good.sum() < 2:
                continue
            order = np.argsort(depth[good])
            cast_flags = flags[good][order]
            qc_chars = np.array(
                [str(int(f)) if np.isfinite(f) else " " for f in cast_flags], dtype="<U1"
            )
            if evaluated:
                accepted = np.array(
                    [bool(np.isfinite(f) and int(f) in QARTOD_ACCEPT) for f in cast_flags]
                )
            else:
                # Unevaluated, not good. Carried through as data_mode 'U' so the viewer
                # and every provenance record say so.
                accepted = np.ones(cast_flags.shape, dtype=bool)
            out.append(
                Profile(
                    platform=f"{name}#{int(pid)}",
                    lat=float(np.nanmean(lat[good])),
                    lon=float(np.nanmean(lon[good])),
                    time=times[good][0],
                    depth=depth[good][order],
                    value=value[good][order],
                    qc=qc_chars,
                    accepted=accepted,
                    data_mode="Q" if evaluated else "U",
                    field_used=column,
                    source_file=path.name,
                )
            )
    return out


def load_window(centre: date, variable: str = "temperature", days: float | None = None,
                cache_dir: Path | None = None) -> list[Profile]:
    """Every glider cast in the region within the window, across known deployments."""
    cache_dir = cache_dir or Path(__file__).resolve().parents[2] / "data" / "cache"
    profiles: list[Profile] = []
    for dataset_id in config.GLIDER_DEPLOYMENTS:
        path = fetch_deployment(dataset_id, cache_dir)
        profiles.extend(read_profiles(path, variable, centre, days))
    return profiles
