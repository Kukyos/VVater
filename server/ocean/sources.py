"""Gridded-field ingestion. One function per format, dispatched from a dict.

This dict *is* the extensibility mechanism the brief asks for (L11). Adding a source
is: write a `_fetch_*` function, add a line to `PARSERS`, add a `Source` entry in
`config.py`. No plugin framework, no registry class, no entry points — those would be
more code to do the same thing, and the same thing is a dict lookup.
"""

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
    raise NotImplementedError(
        "Copernicus needs COPERNICUSMARINE_SERVICE_USERNAME/PASSWORD in .env. "
        "See docs/05-data-sources.md 1.2 — the INCOIS sources need no credentials."
    )


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
