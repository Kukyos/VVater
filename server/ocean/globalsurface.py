"""Global sea-surface temperature: the context layer behind the Globe view.

The volume, the observations and the residual are all Bay of Bengal. Doing them for the
whole ocean is a different project (tiling, streaming, a global Argo index). What the
Globe view needs is much smaller: the surface temperature of every ocean on the same
day, so the region sits inside the Indian Ocean warm pool instead of on a bare globe.

One variable, one day, one level: GLORYS12 `thetao` at its top level (0.49 m), the same
reanalysis the currents come from, so the layer needs no new source or credential. The
subset is ~35 MB once, then cached. For display it is block-averaged k x k (k = 3 takes
1/12 deg to 1/4 deg, 1440 x 681 cells) -- a horizontal mean, never an upsample, and the
factor travels with the data (hard rule 5). Surface only: nothing here is a volume, and
the viewer labels it that way.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

from . import config

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache"
LAT_RANGE = (-80.0, 90.0)  # GLORYS12 stops at 80 S
BLOCK = 3


@dataclass
class Surface:
    values: np.ndarray  # (ny, nx) float32, north row first, NaN over land
    lon_range: tuple[float, float]
    lat_range: tuple[float, float]
    provenance: dict

    def meta(self) -> dict:
        finite = self.values[np.isfinite(self.values)]
        ny, nx = self.values.shape
        return {
            "dimensions": [nx, ny],
            "lonRange": list(self.lon_range),
            "latRange": list(self.lat_range),
            "valueRange": [round(float(finite.min()), 2), round(float(finite.max()), 2)],
            "provenance": self.provenance,
        }


def _fetch(day: str) -> Path:
    source = config.SOURCES["glorys12"]
    name = f"global_{source.variables['temperature']}_surface_{day}.nc"
    path = CACHE / name
    if path.exists() and path.stat().st_size > 0:
        return path
    if not os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME"):
        raise RuntimeError("the global surface layer is GLORYS12 and needs the Copernicus "
                           "credentials in .env")
    import copernicusmarine

    CACHE.mkdir(parents=True, exist_ok=True)
    copernicusmarine.subset(
        dataset_id=source.id,
        variables=[source.variables["temperature"]],
        minimum_longitude=-180, maximum_longitude=180,
        minimum_latitude=LAT_RANGE[0], maximum_latitude=LAT_RANGE[1],
        minimum_depth=0, maximum_depth=1,
        start_datetime=day, end_datetime=day,
        output_directory=str(CACHE), output_filename=name, overwrite=True,
    )
    return path


def block_mean(field: np.ndarray, k: int) -> np.ndarray:
    """k x k mean ignoring NaN; a block that is all land stays NaN."""
    ny, nx = (field.shape[0] // k) * k, (field.shape[1] // k) * k
    blocks = field[:ny, :nx].reshape(ny // k, k, nx // k, k)
    count = np.isfinite(blocks).sum(axis=(1, 3))
    total = np.nansum(blocks, axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(count > 0, total / count, np.nan).astype(np.float32)


@lru_cache(maxsize=2)
def surface(day: str | None = None) -> Surface:
    import xarray as xr

    day = day or config.DEMO_DATE.isoformat()
    path = _fetch(day)
    with xr.open_dataset(path) as ds:
        var = ds[config.SOURCES["glorys12"].variables["temperature"]]
        field = var.isel(time=0, depth=0).values.astype(np.float32)
        lats = ds["latitude"].values
        lons = ds["longitude"].values
        depth = float(ds["depth"].values[0])
    if lats[0] < lats[-1]:  # the viewer wants north first
        field = field[::-1]
        lats = lats[::-1]
    coarse = block_mean(field, BLOCK)
    return Surface(
        values=coarse,
        lon_range=(float(lons.min()), float(lons.max())),
        lat_range=(float(lats.min()), float(lats.max())),
        provenance={
            "source": "Copernicus GLORYS12 reanalysis (cmems_mod_glo_phy_my_0.083deg_P1D-m)",
            "variable": "thetao, sea_water_potential_temperature, degC",
            "level_m": round(depth, 2),
            "day": day,
            "horizontal_block": BLOCK,
            "note": "surface only; a context layer, not part of the volume or any comparison",
        },
    )


def demo() -> None:
    field = np.array([[1, 3, np.nan, np.nan], [5, 7, np.nan, 2]], dtype=np.float32)
    out = block_mean(field, 2)
    assert out.shape == (1, 2)
    assert out[0, 0] == 4.0          # plain mean
    assert out[0, 1] == 2.0          # NaN ignored, not counted as zero
    assert np.isnan(block_mean(np.full((2, 2), np.nan, np.float32), 2)[0, 0])  # land stays land
    print("globalsurface demo ok")


if __name__ == "__main__":
    demo()
