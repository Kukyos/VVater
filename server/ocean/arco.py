"""Copernicus Marine ARCO stores: the whole ocean, any day, read lazily and cached by chunk.

Every Copernicus dataset is also published as an "analysis-ready, cloud-optimised" Zarr
store on public S3. Opened directly, a store costs a few seconds once per process and then
indexes like an in-memory array: only the chunks a request touches are fetched. Measured
2026-09-24 on GLORYS12 (`cmems_mod_glo_phy_my_0.083deg_P1D-m`, docs/05-data-sources.md):

    open the store                             3.6 s   once per process
    one day, 15 x 15 deg, all 50 levels        3-7 s   cold
    one day, the whole globe, one level        0.6 s   native 1/12 deg

The toolbox's `open_dataset` does the same thing behind a catalogue query and a dask graph
per call; opening a whole dataset that way did not finish in ten minutes. So this module
asks the toolbox only for the store URL, and opens the store itself.

The map-shaped store (`timeChunked.zarr`, the toolbox's "arco-geo-series") holds one depth
level of one day per chunk, 512 x 2048 cells. That makes the chunk the natural cache unit:
a second box anywhere in the same 40 x 170 deg tile of the same day and level is free.

    data/cache/arco/<bucket>/<store>/<key>

Chunks are immutable in the reanalyses, so they are kept. Two things are not:

  * metadata and coordinate arrays (the time axis grows as new days are published), kept
    for METADATA_TTL_S;
  * everything in an analysis-forecast store, where the forecast for a day is rewritten
    by each new run until the day becomes an analysis, kept for FORECAST_TTL_S.

Uses the toolbox's own S3 store (`CustomS3StoreZarrV3`) rather than fsspec, because the
toolbox is already a dependency and fsspec's HTTP backend would add aiohttp. That class is
internal to copernicusmarine 2.4.1, which is pinned exactly in requirements.txt.

    python -m server.ocean.arco          # self-check, no network
    python -m server.ocean.arco --probe  # open one store and time one read
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache" / "arco"
URLS_FILE = CACHE / "store_urls.json"

METADATA_TTL_S = 24 * 3600
FORECAST_TTL_S = 6 * 3600
# How long a resolved store URL is trusted. A new product version changes the URL.
URL_TTL_S = 7 * 24 * 3600

# Parallel chunk reads. Zarr issues the chunk gets of one read concurrently; each get runs
# in a thread (the toolbox store wraps a blocking boto3 call), so this is the thread count.
ZARR_CONCURRENCY = 32

_url_lock = threading.Lock()


# ------------------------------------------------------------------ store URLs

def _describe_url(dataset_id: str, service: str, part_name: str | None) -> str:
    """Ask the Copernicus catalogue for one dataset's store URL (the latest version).

    Static datasets are split into parts ("bathy", "coords", "mdt") with a
    "static-arco" service each; daily datasets have one part, "default"."""
    import copernicusmarine

    catalogue = copernicusmarine.describe(dataset_id=dataset_id, disable_progress_bar=True)
    for product in catalogue.products:
        for dataset in product.datasets:
            if dataset.dataset_id != dataset_id:
                continue
            version = dataset.versions[-1]
            for part in version.parts:
                if part_name and part.name != part_name:
                    continue
                for s in part.services:
                    if str(s.service_name) == service:
                        return s.uri
    raise LookupError(f"{dataset_id} has no {service} store"
                      f"{f' in part {part_name!r}' if part_name else ''} in the catalogue")


def store_url(dataset_id: str, service: str = "arco-geo-series",
              part: str | None = None) -> str:
    """The Zarr URL for a dataset, from a small JSON cache in front of the catalogue."""
    key = f"{dataset_id}|{service}|{part or ''}"
    with _url_lock:
        known = json.loads(URLS_FILE.read_text()) if URLS_FILE.exists() else {}
        entry = known.get(key)
        if entry and time.time() - entry["at"] < URL_TTL_S:
            return entry["url"]
        url = _describe_url(dataset_id, service, part)
        known[key] = {"url": url, "at": time.time()}
        CACHE.mkdir(parents=True, exist_ok=True)
        URLS_FILE.write_text(json.dumps(known, indent=1))
        return url


# ------------------------------------------------------------------ the cached store

def _is_metadata(key: str) -> bool:
    """Zarr v2 metadata files, and every chunk of a coordinate array. The time axis is
    a coordinate, and it is what grows when a new day is published."""
    name = key.rsplit("/", 1)[-1]
    if name.startswith(".z"):
        return True
    array = key.split("/", 1)[0]
    return array in {"time", "depth", "elevation", "latitude", "longitude"}


def _ttl_for(key: str, forecast: bool) -> float | None:
    """Seconds a cached key stays valid; None means forever."""
    if forecast:
        return FORECAST_TTL_S
    return METADATA_TTL_S if _is_metadata(key) else None


def _fresh(path: Path, ttl: float | None) -> bool:
    if not path.exists():
        return False
    return ttl is None or time.time() - path.stat().st_mtime < ttl


def _make_store_class():
    """Built lazily so importing this module does not import zarr or boto3."""
    from copernicusmarine.core_functions.custom_s3_store_zarr_v3 import CustomS3StoreZarrV3

    class CachedStore(CustomS3StoreZarrV3):
        """The toolbox's read-only S3 store with a disk cache in front of every get."""

        def __init__(self, *args, cache_dir: Path, forecast: bool, **kwargs):
            super().__init__(*args, **kwargs)
            self._cache_dir = cache_dir
            self._forecast = forecast

        async def get(self, key, prototype, byte_range=None):
            # Byte-range reads are not used by these stores (every chunk is read whole);
            # passing one through uncached keeps the cache simple and never wrong.
            if byte_range is not None:
                return await super().get(key, prototype, byte_range)
            path = self._cache_dir / key
            if _fresh(path, _ttl_for(key, self._forecast)):
                return prototype.buffer.from_bytes(path.read_bytes())
            buffer = await super().get(key, prototype, byte_range)
            if buffer is not None:
                path.parent.mkdir(parents=True, exist_ok=True)
                # Written aside and renamed, so a crash mid-write never leaves a
                # truncated chunk that later decodes as garbage.
                partial = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.part")
                partial.write_bytes(buffer.to_bytes())
                partial.replace(path)
            return buffer

    return CachedStore


@lru_cache(maxsize=1)
def _store_class():
    return _make_store_class()


@dataclass(frozen=True)
class OpenStore:
    """One opened dataset, plus what the rest of the system needs to know about it."""

    dataset_id: str
    url: str
    ds: object  # xarray.Dataset, lazily indexed (chunks=None: no dask)
    forecast: bool

    @property
    def times(self) -> np.ndarray:
        # Static stores (bathymetry) have no time axis; callers never ask them for one.
        return self.ds["time"].values

    def coverage(self) -> tuple[str, str]:
        t = self.times
        return str(t[0])[:10], str(t[-1])[:10]


def _cache_dir_for(url: str) -> Path:
    from copernicusmarine.core_functions.utils import parse_access_dataset_url

    _, bucket, root = parse_access_dataset_url(url)
    return CACHE / bucket / root.strip("/")


@lru_cache(maxsize=32)
def open_store(dataset_id: str, service: str = "arco-geo-series",
               part: str | None = None) -> OpenStore:
    """Open one dataset's store for the life of the process. Thread-safe to read from."""
    import xarray as xr
    import zarr
    from copernicusmarine.core_functions.utils import parse_access_dataset_url

    zarr.config.set({"async.concurrency": ZARR_CONCURRENCY,
                     "threading.max_workers": ZARR_CONCURRENCY})
    url = store_url(dataset_id, service, part)
    endpoint, bucket, root = parse_access_dataset_url(url)
    forecast = "_anfc_" in dataset_id
    store = _store_class()(endpoint=endpoint, bucket=bucket, root_path=root, read_only=True,
                           cache_dir=_cache_dir_for(url), forecast=forecast)
    ds = xr.open_zarr(store, decode_times=True, decode_timedelta=True, zarr_format=2,
                      chunks=None)
    return OpenStore(dataset_id, url, ds, forecast)


# ------------------------------------------------------------------ self-checks

def demo() -> None:
    """The cache rules, which are the part of this module that can be silently wrong."""
    assert _is_metadata(".zmetadata")
    assert _is_metadata("thetao/.zarray")
    assert _is_metadata("time/0"), "the time axis grows; it must expire"
    assert not _is_metadata("thetao/1234.49.2.1"), "a data chunk is not metadata"
    assert _ttl_for("thetao/1234.49.2.1", forecast=False) is None, "reanalysis chunks are kept"
    assert _ttl_for("time/0", forecast=False) == METADATA_TTL_S
    assert _ttl_for("thetao/1.0.0.0", forecast=True) == FORECAST_TTL_S, \
        "a forecast chunk is rewritten by the next run"
    print("arco ok: cache rules")


def probe() -> None:
    t = time.time()
    s = open_store("cmems_mod_glo_phy_my_0.083deg_P1D-m")
    print(f"open {time.time() - t:.1f} s, coverage {s.coverage()}")
    t = time.time()
    a = s.ds["thetao"].sel(time="2018-08-25", longitude=slice(80, 95),
                           latitude=slice(5, 20)).values
    print(f"read {a.shape} in {time.time() - t:.1f} s")


if __name__ == "__main__":
    probe() if "--probe" in sys.argv else demo()
