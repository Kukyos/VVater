"""Gridded-field ingestion. One function per format, dispatched from a dict.

This dict *is* the extensibility mechanism the brief asks for (L11). Adding a source
is: write a `_fetch_*` function, add a line to `PARSERS`, add a `Source` entry in
`config.py`. No plugin framework, no registry class, no entry points — those would be
more code to do the same thing, and the same thing is a dict lookup.
"""

import os
import urllib.parse
from pathlib import Path

import requests
import xarray as xr

from . import config


def _erddap_url(source: config.Source, variables: list[str], t0: str, t1: str) -> str:
    """Build an ERDDAP griddap subset URL.

    griddap indexes by *value*, not position: [(start):stride:(stop)] per dimension,
    in the variable's own dimension order (time, depth, lat, lon for these datasets).
    """
    lon0, lon1 = config.REGION["lon"]
    lat0, lat1 = config.REGION["lat"]
    z0, z1 = config.DEPTH_RANGE
    span = (
        f"[({t0}):1:({t1})]"
        f"[({z0}):1:({z1})]"
        f"[({lat0}):1:({lat1})]"
        f"[({lon0}):1:({lon1})]"
    )
    query = ",".join(f"{v}{span}" for v in variables)
    return f"{config.ERDDAP_BASE}/griddap/{source.id}.nc?{urllib.parse.quote(query, safe='')}"


def _fetch_erddap(source: config.Source, variables: list[str], t0: str, t1: str,
                  cache_dir: Path) -> xr.Dataset:
    url = _erddap_url(source, variables, t0, t1)
    name = f"{source.id}_{'-'.join(variables)}_{t0}_{t1}.nc".replace(":", "")
    path = cache_dir / name
    if not path.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        resp = requests.get(url, timeout=config.HTTP_TIMEOUT)
        # ERDDAP reports query errors as a 404 with a text/plain body that explains
        # exactly what was wrong. Surfacing that beats a bare status code.
        if resp.status_code != 200:
            raise RuntimeError(
                f"ERDDAP {resp.status_code} for {source.id}: {resp.text[:400]}"
            )
        path.write_bytes(resp.content)
    return xr.open_dataset(path)


def _fetch_copernicus(source: config.Source, variables: list[str], t0: str, t1: str,
                      cache_dir: Path) -> xr.Dataset:
    """Subset GLORYS12 through the Copernicus toolbox.

    This is the only source with current vectors, and it is roughly forty times heavier
    than the INCOIS field: one day of four variables over this region measured 23 MB on
    disk and 92 MB in memory (docs/05-data-sources.md 1.2).

    So the window is **truncated**, not merely discouraged. The default window used by
    the rest of the API is four months, which is fine for a 0.55 MB INCOIS request and
    is roughly 1.8 GB here -- enough to hang a request until somebody kills the server,
    which is exactly what it did once. `config.COPERNICUS_MAX_DAYS` is the ceiling.
    """
    from datetime import date, timedelta

    if not os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME"):
        raise RuntimeError(
            "Copernicus needs COPERNICUSMARINE_SERVICE_USERNAME and "
            "COPERNICUSMARINE_SERVICE_PASSWORD in .env. The INCOIS sources need none."
        )

    import copernicusmarine

    lon0, lon1 = config.REGION["lon"]
    lat0, lat1 = config.REGION["lat"]
    z0, z1 = config.DEPTH_RANGE

    start = date.fromisoformat(t0[:10])
    end = min(date.fromisoformat(t1[:10]), start + timedelta(days=config.COPERNICUS_MAX_DAYS))
    t0, t1 = start.isoformat(), end.isoformat()

    name = f"{source.id}_{'-'.join(variables)}_{t0}_{t1}.nc".replace(":", "")
    path = cache_dir / name
    if not path.exists():
        cache_dir.mkdir(parents=True, exist_ok=True)
        copernicusmarine.subset(
            dataset_id=source.id,
            variables=list(variables),
            minimum_longitude=lon0, maximum_longitude=lon1,
            minimum_latitude=lat0, maximum_latitude=lat1,
            minimum_depth=z0, maximum_depth=z1,
            start_datetime=t0, end_datetime=t1,
            output_directory=str(cache_dir),
            output_filename=name,
            overwrite=True,
        )
    return xr.open_dataset(path)


PARSERS = {
    "erddap": _fetch_erddap,
    "copernicus": _fetch_copernicus,
}


def fetch(variable: str, t0: str, t1: str, source_key: str = config.DEFAULT_SOURCE,
          cache_dir: Path | None = None, with_error: bool = True) -> tuple[xr.Dataset, dict]:
    """Fetch one canonical variable (and its error field, when the source has one).

    Returns (dataset, name_map) where name_map tells the caller which source variable
    ended up being the value and which the uncertainty.
    """
    source = config.SOURCES[source_key]
    if variable not in source.variables:
        raise KeyError(
            f"{source_key} has no {variable!r}; it has {sorted(source.variables)}"
        )

    names = {"value": source.variables[variable]}
    wanted = [names["value"]]
    if with_error and variable in source.error_variables:
        names["error"] = source.error_variables[variable]
        wanted.append(names["error"])

    cache_dir = cache_dir or Path(__file__).resolve().parents[2] / "data" / "cache"
    ds = PARSERS[source.kind](source, wanted, t0, t1, cache_dir)
    return ds, names


def fetch_many(variables: list[str], t0: str, t1: str,
               source_key: str = config.DEFAULT_SOURCE,
               cache_dir: Path | None = None) -> tuple[xr.Dataset, dict]:
    """Several canonical variables in one file.

    Currents need u and v together: fetching them separately would mean two downloads of
    the same subset and, worse, two files that could in principle come from different
    cache states. One request, one file, one time axis.
    """
    source = config.SOURCES[source_key]
    missing = [v for v in variables if v not in source.variables]
    if missing:
        raise KeyError(f"{source_key} has no {missing}; it has {sorted(source.variables)}")

    names = {v: source.variables[v] for v in variables}
    cache_dir = cache_dir or Path(__file__).resolve().parents[2] / "data" / "cache"
    ds = PARSERS[source.kind](source, list(names.values()), t0, t1, cache_dir)
    return ds, names
