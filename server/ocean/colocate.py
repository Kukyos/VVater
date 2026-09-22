"""Put a gridded analysis and a float profile on the same axes.

This is the problem statement's actual promise — "rapidly correlate model predictions
with observational evidence" — and the one place where being quietly wrong is worse than
being visibly broken. An inverted depth axis or a transposed dimension produces a chart
that looks entirely plausible and says the opposite of the truth.

So: this is its own module, the interpolation records what it did, and the tests in
`server/tests/test_colocate.py` pin the depth sign with physics rather than metadata
(L7, V3, V4).
"""

from dataclasses import dataclass

import numpy as np
import xarray as xr

from . import cf, config


@dataclass
class Comparison:
    """A float profile and the analysis interpolated onto it."""

    depth: np.ndarray            # metres, positive down
    observed: np.ndarray
    modelled: np.ndarray
    accepted: np.ndarray         # QC mask from the float
    error: np.ndarray | None     # analysis uncertainty at those points, when available
    provenance: dict

    @property
    def residual(self) -> np.ndarray:
        """Observed minus modelled, over QC-accepted levels only."""
        out = np.full_like(self.observed, np.nan)
        out[self.accepted] = self.observed[self.accepted] - self.modelled[self.accepted]
        return out

    def summary(self) -> dict:
        r = self.residual[np.isfinite(self.residual)]
        return {
            "levels": int(self.depth.size),
            "levels_compared": int(r.size),
            "bias": float(r.mean()) if r.size else float("nan"),
            "rmse": float(np.sqrt((r**2).mean())) if r.size else float("nan"),
            **self.provenance,
        }


def _coord(ds: xr.Dataset, *candidates: str) -> str:
    for name in candidates:
        if name in ds.coords or name in ds.dims:
            return name
    raise KeyError(f"none of {candidates} in {list(ds.coords)}")


def colocate(profile, ds: xr.Dataset, value_name: str,
             error_name: str | None = None) -> Comparison:
    """Interpolate `ds[value_name]` onto one float profile.

    Nearest neighbour in time (the analysis is 10-daily and the float is instantaneous;
    pretending otherwise by interpolating between analysis steps would invent a
    timeseries the product does not have), linear in space and depth.
    """
    z = _coord(ds, "ZAX", "depth", "LEV")
    lat = _coord(ds, "latitude", "lat")
    lon = _coord(ds, "longitude", "lon")

    positive_down, depth_note = cf.depth_sign_assumption(ds[z])
    if not positive_down:
        raise NotImplementedError(
            f"{z} is positive-up; every source measured so far is positive-down "
            "(docs/03-limitations.md L2)"
        )

    report = cf.normalise_variable(ds[value_name], "temperature")

    field = ds[value_name].sel({"time": profile.time}, method="nearest")
    picked_time = field["time"].values
    dt_days = float(
        (np.datetime64(picked_time) - np.datetime64(profile.time))
        / np.timedelta64(1, "D")
    )

    interpolated = field.interp(
        {z: ("points", profile.depth),
         lat: ("points", np.full(profile.depth.shape, profile.lat)),
         lon: ("points", np.full(profile.depth.shape, profile.lon))},
        method="linear",
    )
    modelled = np.asarray(interpolated.values, dtype=float)

    error = None
    if error_name and error_name in ds:
        error = np.asarray(
            ds[error_name]
            .sel({"time": profile.time}, method="nearest")
            .interp(
                {z: ("points", profile.depth),
                 lat: ("points", np.full(profile.depth.shape, profile.lat)),
                 lon: ("points", np.full(profile.depth.shape, profile.lon))},
                method="linear",
            )
            .values,
            dtype=float,
        )

    # How far the nearest grid cell actually is, so nobody has to guess.
    d_lat = float(np.min(np.abs(np.asarray(ds[lat].values) - profile.lat)))
    d_lon = float(np.min(np.abs(np.asarray(ds[lon].values) - profile.lon)))

    assumptions = list(report.assumptions)
    if depth_note:
        assumptions.append(depth_note)

    provenance = {
        "method": "nearest in time, linear in lat/lon/depth (xarray.interp)",
        "variable": value_name,
        "standard_name": report.standard_name,
        "units": report.display_units,
        "analysis_time": str(picked_time)[:19],
        "time_offset_days": round(dt_days, 3),
        "grid_offset_deg": {"lat": round(d_lat, 4), "lon": round(d_lon, 4)},
        "pairing_window_days": config.FLOAT_PAIRING_DAYS,
        "pairing_note": config.FLOAT_PAIRING_NOTE,
        "cf_assumptions": assumptions,
        **profile.provenance(),
    }

    return Comparison(
        depth=profile.depth,
        observed=profile.value,
        modelled=modelled,
        accepted=profile.accepted,
        error=error,
        provenance=provenance,
    )


# Depth bands used for the matched comparison. A single pooled RMSE hides the fact that
# a 1-degree analysis is excellent below the thermocline and poor above it, and it lets
# two instruments with different depth coverage look like they have different skill when
# they are really sampling different parts of the column (docs/13-eval-results.md).
BANDS = [("0-300 m", 0.0, 300.0), ("300-950 m", 300.0, 950.0),
         ("950-2000 m", 950.0, 2000.0), ("50-950 m (matched)", 50.0, 950.0)]


def pooled_residuals(profiles, ds, value_name, lo=None, hi=None):
    """Bias and RMSE over every accepted level in `profiles`, optionally one depth band.

    Pools levels rather than averaging per-profile statistics, so a 500-level cast is not
    given the same weight as a 45-level one.
    """
    import numpy as np

    chunks = []
    for profile in profiles:
        if not profile.accepted.any():
            continue
        comparison = colocate(profile, ds, value_name)
        mask = (profile.accepted
                & np.isfinite(comparison.modelled)
                & np.isfinite(comparison.observed))
        if lo is not None:
            mask &= (profile.depth >= lo) & (profile.depth <= hi)
        if mask.any():
            chunks.append(comparison.observed[mask] - comparison.modelled[mask])

    if not chunks:
        return {"levels": 0, "bias": float("nan"), "rmse": float("nan")}
    residual = np.concatenate(chunks)
    return {"levels": int(residual.size),
            "bias": round(float(residual.mean()), 4),
            "rmse": round(float(np.sqrt((residual ** 2).mean())), 4)}
