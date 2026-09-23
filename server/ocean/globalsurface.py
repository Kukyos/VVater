"""Global surface fields: the whole-Earth layers behind the Globe and the Simple view.

The volume, the observations and the residual are all Bay of Bengal. Doing them for the
whole ocean is a different project (tiling, streaming, a global Argo index). What a
globe needs is much smaller: the ocean's surface state on each date the Bay's timeline
steps through, so the region sits inside the world and the Simple view can animate it.

Source: Copernicus GLOBAL_MULTIYEAR_PHY_ENS_001_031, dataset
`cmems_mod_glo_phy-all_my_0.25deg_P1D-m`, the `_glor` members (GLORYS12 regridded to
1/4 deg by Mercator). Native 1/4 deg: nothing here is resampled. One file per date holds
every variable at the top level (0.49 m), 27.5 MB, about 16 s to fetch, then cached.

    python -m server.ocean.globalsurface          # self-check, no network
    python -m server.ocean.globalsurface --warm   # fetch every timeline date once

Surface only, and every layer says so: nothing here is a volume, and none of it is
compared against observations.
"""

from __future__ import annotations

import os
import sys
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache"
DATASET = "cmems_mod_glo_phy-all_my_0.25deg_P1D-m"
LAT_RANGE = (-80.0, 90.0)  # the product stops at 80 S
VARIABLES = ["thetao_glor", "so_glor", "uo_glor", "vo_glor", "siconc_glor", "zos_glor",
             "mlotst_glor"]


@dataclass(frozen=True)
class Layer:
    key: str
    title: str
    units: str
    palette: str
    source: str  # variable name(s) in the file
    signed: bool = False  # symmetric colour range about zero
    note: str = ""


LAYERS = {
    "temperature": Layer("temperature", "Sea surface temperature", "°C", "thermal", "thetao_glor"),
    "salinity": Layer("salinity", "Sea surface salinity", "PSU", "haline", "so_glor"),
    "currents": Layer("currents", "Surface current speed", "m/s", "viridis", "uo_glor,vo_glor",
                      note="speed only, sqrt(u² + v²); direction is in the Bay's streamlines"),
    "sea_level": Layer("sea_level", "Sea surface height", "m", "balance", "zos_glor", signed=True,
                       note="relative to the model's geoid; the global mean is not zero"),
    "mixed_layer": Layer("mixed_layer", "Mixed layer depth", "m", "viridis", "mlotst_glor",
                         note="depth of the well-mixed surface layer"),
    "sea_ice": Layer("sea_ice", "Sea ice concentration", "fraction", "grey", "siconc_glor"),
}

_fetch_lock = threading.Lock()


def days() -> list[str]:
    """The timeline: the dates of the Bay analysis steps, so both views step together."""
    from . import api  # the analysis times are read once there

    return [t[:10] for t in api.meta()["times"]]


def path_for(day: str) -> Path:
    return CACHE / f"global025_surface_{day}.nc"


def fetch(day: str) -> Path:
    path = path_for(day)
    if path.exists() and path.stat().st_size > 0:
        return path
    # One download per day even when the viewer asks for several layers of it at once.
    with _fetch_lock:
        if path.exists() and path.stat().st_size > 0:
            return path
        if not os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME"):
            raise RuntimeError("the global layers come from Copernicus and need the credentials "
                               "in .env; run `python -m server.ocean.globalsurface --warm` once "
                               "where they are available")
        import copernicusmarine

        CACHE.mkdir(parents=True, exist_ok=True)
        copernicusmarine.subset(
            dataset_id=DATASET, variables=VARIABLES,
            minimum_longitude=-180, maximum_longitude=180,
            minimum_latitude=LAT_RANGE[0], maximum_latitude=LAT_RANGE[1],
            minimum_depth=0, maximum_depth=1,
            start_datetime=day, end_datetime=day,
            output_directory=str(CACHE), output_filename=path.name, overwrite=True,
            disable_progress_bar=True,
        )
    return path


@dataclass
class Surface:
    values: np.ndarray  # (ny, nx) float32, north row first, NaN over land
    lon_range: tuple[float, float]
    lat_range: tuple[float, float]
    layer: Layer
    day: str
    level_m: float | None  # None for fields with no depth axis (sea level, MLD, ice)

    def meta(self) -> dict:
        ny, nx = self.values.shape
        lo, hi = display_range(self.layer.key)
        return {
            "layer": self.layer.key,
            "title": self.layer.title,
            "units": self.layer.units,
            "palette": self.layer.palette,
            "dimensions": [nx, ny],
            "lonRange": list(self.lon_range),
            "latRange": list(self.lat_range),
            "valueRange": [lo, hi],
            "provenance": {
                "source": f"Copernicus {DATASET} (GLORYS12 member, 1/4 deg)",
                "variable": self.layer.source,
                "level_m": None if self.level_m is None else round(self.level_m, 2),
                "day": self.day,
                "display_range": f"2nd-98th percentile on {reference_day()}, held fixed across the "
                                 "timeline so a colour means the same value on every day",
                "note": ("surface only; " + self.layer.note).rstrip("; "),
            },
        }


def speed(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return np.hypot(u, v).astype(np.float32)


@lru_cache(maxsize=24)  # 24 x 3.9 MB; all 13 days x 6 layers would be ~300 MB
def surface(day: str, layer_key: str) -> Surface:
    import xarray as xr

    layer = LAYERS[layer_key]
    with xr.open_dataset(fetch(day)) as ds:
        def pick(name: str) -> np.ndarray:
            # Sea level, mixed layer depth and ice are 2D fields: no depth axis to select.
            var = ds[name].isel(time=0)
            return (var.isel(depth=0) if "depth" in var.dims else var).values.astype(np.float32)

        if layer_key == "currents":
            field = speed(pick("uo_glor"), pick("vo_glor"))
        else:
            field = pick(layer.source)
        lats = ds["latitude"].values
        lons = ds["longitude"].values
        first = ds[layer.source.split(",")[0]]
        level = float(ds["depth"].values[0]) if "depth" in first.dims else None
    if lats[0] < lats[-1]:  # the viewer wants north first
        field = field[::-1]
        lats = lats[::-1]
    return Surface(np.ascontiguousarray(field), (float(lons.min()), float(lons.max())),
                   (float(lats.min()), float(lats.max())), layer, day, level)


def reference_day() -> str:
    """The first timeline date on or after the demo date: where both views open."""
    demo = config.DEMO_DATE.isoformat()
    return next((d for d in days() if d >= demo), days()[-1])


@lru_cache(maxsize=None)
def display_range(layer_key: str) -> tuple[float, float]:
    """Fixed per layer: the 2nd-98th percentile of the reference date, symmetric if signed."""
    values = surface(reference_day(), layer_key).values
    finite = values[np.isfinite(values)]
    lo, hi = (float(v) for v in np.percentile(finite, [2, 98]))
    if LAYERS[layer_key].signed:
        extent = max(abs(lo), abs(hi))
        lo, hi = -extent, extent
    return round(lo, 3), round(hi, 3)


def warm() -> None:
    for day in days():
        path = fetch(day)
        print(f"{day}  {path.stat().st_size / 1e6:.1f} MB  {path.name}")


def demo() -> None:
    u = np.array([[3.0, np.nan]], np.float32)
    v = np.array([[4.0, 1.0]], np.float32)
    s = speed(u, v)
    assert s[0, 0] == 5.0, "speed is the magnitude of (u, v)"
    assert np.isnan(s[0, 1]), "land stays land"
    assert set(LAYERS) == {"temperature", "salinity", "currents", "sea_level", "mixed_layer",
                           "sea_ice"}
    for layer in LAYERS.values():
        for name in layer.source.split(","):
            assert name in VARIABLES, f"{layer.key} reads {name}, which is never downloaded"
    print("globalsurface demo ok")


if __name__ == "__main__":
    warm() if "--warm" in sys.argv else demo()
