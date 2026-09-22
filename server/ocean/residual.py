"""Where the analysis disagrees with reality, as a volume.

`docs/13-eval-results.md` established the finding this module exists to show: the INCOIS
analysis and an independent glider agree below 300 m (0.35 vs 0.31 degC RMSE) and
disagree badly above it (1.26 vs 2.89, with a -2.25 degC bias). That is the mixed layer
and the thermocline -- the part that decides cyclone intensity -- and it is **invisible
in any pooled statistic**.

So: co-locate every cast in the window, bin the residuals onto the model grid, and render
observed-minus-modelled as a volume. The disagreement becomes the first thing on screen
instead of a row in a table.

Two things this deliberately does NOT do:

  * **It does not interpolate into empty cells.** Most of the grid has no observation in
    any given window, and those cells stay NaN. A smooth residual field would imply we
    know the error everywhere, which is the opposite of the point. You can only verify
    where somebody measured.
  * **It does not average across depth.** Binning is per (lon, lat, depth) cell, because
    the entire finding is that the error is depth-dependent.
"""

from dataclasses import dataclass

import numpy as np
import xarray as xr

from . import cf, colocate, config, regrid
from .volume import Volume, _flatten


@dataclass
class ResidualStats:
    """What went into the volume, so the picture can be defended."""

    casts: int
    levels_binned: int
    cells_filled: int
    cells_total: int
    bias: float
    rmse: float

    def as_dict(self) -> dict:
        return {
            "casts": self.casts,
            "levels_binned": self.levels_binned,
            "cells_filled": self.cells_filled,
            "cells_total": self.cells_total,
            "coverage_percent": round(100 * self.cells_filled / max(self.cells_total, 1), 2),
            "bias": round(self.bias, 4),
            "rmse": round(self.rmse, 4),
        }


def _nearest(values: np.ndarray, target: float) -> int:
    return int(np.abs(values - target).argmin())


def build(ds: xr.Dataset, value_name: str, profiles, time_index: int,
          source_key: str = config.DEFAULT_SOURCE,
          canonical: str = "temperature") -> tuple[Volume, ResidualStats]:
    """Bin observed-minus-modelled onto the model grid as a renderable volume."""
    source = config.SOURCES[source_key]

    z_name = "ZAX" if "ZAX" in ds.coords else "depth"
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"

    lons = np.asarray(ds[lon_name].values, dtype=float)
    lats = np.asarray(ds[lat_name].values, dtype=float)
    native = np.asarray(ds[z_name].values, dtype=float)
    grid = regrid.build_grid(native, source.native_levels)

    shape = (grid.n, lats.size, lons.size)
    total = np.zeros(shape)
    count = np.zeros(shape, dtype=int)

    all_residuals: list[np.ndarray] = []
    used_casts = 0

    for profile in profiles:
        if not profile.accepted.any():
            continue
        comparison = colocate.colocate(profile, ds, value_name, canonical=canonical)
        residual = comparison.observed - comparison.modelled
        usable = profile.accepted & np.isfinite(residual)
        if not usable.any():
            continue

        used_casts += 1
        all_residuals.append(residual[usable])

        j = _nearest(lats, profile.lat)
        i = _nearest(lons, profile.lon)
        for depth, value in zip(profile.depth[usable], residual[usable]):
            k = _nearest(grid.depths, float(depth))
            total[k, j, i] += float(value)
            count[k, j, i] += 1

    with np.errstate(invalid="ignore"):
        binned = np.where(count > 0, total / np.maximum(count, 1), np.nan)

    pooled = np.concatenate(all_residuals) if all_residuals else np.array([])
    stats = ResidualStats(
        casts=used_casts,
        levels_binned=int(count.sum()),
        cells_filled=int((count > 0).sum()),
        cells_total=int(count.size),
        bias=float(pooled.mean()) if pooled.size else float("nan"),
        rmse=float(np.sqrt((pooled ** 2).mean())) if pooled.size else float("nan"),
    )

    finite = binned[np.isfinite(binned)]
    # A residual has a sign, so the colour range is forced symmetric about zero. Letting
    # it run min..max would put zero somewhere arbitrary on a diverging palette and make
    # a +0.1 degC cell look like a different colour from a -0.1 degC one.
    extent = float(np.abs(finite).max()) if finite.size else 1.0
    extent = max(extent, 0.1)

    report = cf.normalise_variable(ds[value_name], canonical)

    provenance = {
        "source": f"{source.title} minus in-situ observations",
        "variable": f"{value_name} residual",
        "standard_name": f"{report.standard_name}_residual",
        "units": report.display_units,
        "time": str(ds.time.values[time_index])[:19],
        "depth_grid": grid.provenance(),
        "range_test": {"checked": False, "reason": "a residual has no physical range"},
        "masked_cells": 0,
        "residual": stats.as_dict(),
        "cf_assumptions": [
            "observed minus modelled, binned to the nearest grid cell, no smoothing",
            "cells with no observation in this window stay empty rather than interpolated",
            f"colour range forced symmetric about zero at +/-{extent:.2f}",
        ],
    }

    volume = Volume(
        values=_flatten(binned),
        errors=None,
        dimensions=(lons.size, lats.size, grid.n),
        lon_range=(float(lons.min()), float(lons.max())),
        lat_range=(float(lats.min()), float(lats.max())),
        depth_range=(grid.z_min, grid.z_max),
        value_range=(-extent, extent),
        provenance=provenance,
    )
    return volume, stats
