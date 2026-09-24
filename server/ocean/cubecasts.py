"""Floats inside a cube, and one float against the cube's model.

`casts()` is what the viewer draws as sticks in the cube: every Argo cast in the box within
the pairing window, from `argo_global`. `compare()` is what the profile panel shows when
one is clicked: the cast against the same model the cube shows, through the same tested
`colocate.colocate` the Bay has always used — on a small native block of the ARCO store
read around the float, so nothing new does the interpolation.

**Pairing window.** The Bay's +/-5 days was measured against INCOIS's 10-day analysis
cadence (L6) and does not transfer to a daily model: a float five days from a daily field
is compared with water that has moved. The cube uses CAST_WINDOW_DAYS, and compares each
cast with the model on **its own UTC day**, not the cube's. The window is provisional until
the harness measures how the misfit grows with time separation (docs/11-deferred.md D-35).
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from . import argo_global, catalog, colocate, config, cube

CAST_WINDOW_DAYS = 2

# Levels per cast sent for drawing a stick. Accepted levels are thinned evenly beyond this;
# every rejected level is always kept, so a QC failure is never thinned out of sight.
STICK_LEVELS = 120


def _thin(p) -> np.ndarray:
    idx = np.arange(p.depth.size)
    if idx.size <= STICK_LEVELS:
        return idx
    rejected = idx[~p.accepted]
    accepted = idx[p.accepted]
    budget = max(STICK_LEVELS - rejected.size, 2)
    if accepted.size > budget:
        accepted = accepted[np.linspace(0, accepted.size - 1, budget).round().astype(int)]
    return np.union1d(accepted, rejected)


def _round(a: np.ndarray, digits: int = 3) -> list:
    return [None if not np.isfinite(v) else round(float(v), digits) for v in a]


def casts(variable: str, box: cube.Box, day: str, depth_max: float) -> dict:
    if not argo_global.available(variable):
        return {"variable": variable, "casts": [], "available": False,
                "note": f"no float measures {variable}; floats carry "
                        f"{', '.join(sorted(argo_global.FIELDS))}"}
    profiles, info = argo_global.load_box(variable, box.lon0, box.lon1, box.lat0, box.lat1,
                                          day, CAST_WINDOW_DAYS, depth_max)
    out = []
    for p in profiles:
        keep = _thin(p)
        keep = keep[p.depth[keep] <= depth_max * 1.03]
        out.append({
            "platform": p.platform, "cycle": getattr(p, "cycle", None),
            "lat": round(p.lat, 4), "lon": round(p.lon, 4), "time": str(p.time)[:19],
            "dataMode": p.data_mode, "sourceFile": p.source_file, "fieldUsed": p.field_used,
            "levels": int(p.depth.size), "levelsRejected": p.n_rejected,
            "notes": getattr(p, "notes", []),
            "depth": _round(p.depth[keep], 1), "value": _round(p.value[keep], 4),
            "accepted": [bool(v) for v in p.accepted[keep]],
            "qc": "".join(p.qc[keep]),
        })
    return {"variable": variable, "available": True, "casts": out,
            **{k: v for k, v in info.items() if k != "queries"},
            "pairing": (f"casts within +/-{CAST_WINDOW_DAYS} days of {day}; each is compared "
                        "with the model on its own day (provisional, D-35)"),
            "qcAccepted": sorted(config.QC_ACCEPT)}


def _block_around(variable: str, lat: float, lon: float, day: str, depth_max: float):
    """A small xarray Dataset of the model around one place on one day, native levels,
    shaped the way colocate.colocate expects (time, depth positive down, lat, lon).
    Returns the dataset, the opened source, and the float's longitude in the dataset's
    own longitude frame (continuous across the antimeridian)."""
    import xarray as xr

    lon = ((lon + 180.0) % 360.0) - 180.0
    lo, hi = lon - 0.5, lon + 0.5
    if lo < -180.0:
        lo += 360.0
    box = cube.Box.parse(lo, hi if hi <= 180.0 else hi - 360.0, lat - 0.5, lat + 0.5)
    src = cube._open(variable, box, day, depth_max)
    levels = np.stack([src.level(i) for i in range(src.n_levels)])
    ds = xr.Dataset(
        {src.resolved.era.var: (("time", "depth", "latitude", "longitude"), levels[None],
                                src.attrs)},
        coords={"time": [np.datetime64(day)],
                "depth": ("depth", src.depths, {"positive": "down", "units": "m"}),
                "latitude": src.lats, "longitude": src.lons},
    )
    return ds, src, (lon if lon >= src.lons.min() - 1e-9 else lon + 360.0)


def compare(variable: str, platform: str, cycle: int, box: cube.Box, day: str,
            depth_max: float) -> dict:
    profiles, info = argo_global.load_box(variable, box.lon0, box.lon1, box.lat0, box.lat1,
                                          day, CAST_WINDOW_DAYS, depth_max)
    found = next((p for p in profiles if p.platform == platform
                  and getattr(p, "cycle", None) == cycle), None)
    if found is None:
        raise LookupError(f"no cast {platform} cycle {cycle} near {day}")
    cast_day = str(found.time)[:10]
    # Deep enough to include the first native level below the cast's deepest one, or the
    # interpolation has nothing beneath its last levels (native spacing reaches ~200 m at
    # 1,000 m and ~450 m at 5,000 m).
    ds, src, lon_in_ds = _block_around(variable, found.lat, found.lon, cast_day,
                                       float(found.depth.max()) * 1.5 + 100)
    comparison = colocate.colocate(replace(found, lon=lon_in_ds), ds, src.resolved.era.var,
                                   canonical=catalog.VARIABLES[variable].canonical or variable)
    summary = {k: v for k, v in comparison.summary().items() if k != "per_profile"}
    # The Bay's pairing note describes INCOIS; this pairing is different and says so.
    summary["pairing_window_days"] = CAST_WINDOW_DAYS
    summary["pairing_note"] = ("the cast is compared with the daily model on its own UTC day; "
                               "linear in latitude, longitude and depth")
    summary["model"] = src.resolved.provenance()
    summary["cf_assumptions"] = sorted(set(summary.get("cf_assumptions", [])
                                           + src.assumptions))
    return {
        "platform": found.platform, "cycle": cycle, "lat": found.lat, "lon": found.lon,
        "time": str(found.time)[:19],
        "depth": _round(comparison.depth, 2), "observed": _round(comparison.observed, 4),
        "modelled": _round(comparison.modelled, 4),
        "accepted": [bool(v) for v in comparison.accepted], "qc": [str(v) for v in found.qc],
        "error": None, "summary": summary, "tchp": None,
        "assumptions": getattr(found, "notes", []),
        "modelTitle": catalog.TITLES.get(src.resolved.era.dataset, src.resolved.era.dataset),
    }


def demo() -> None:
    from .argo import Profile

    n = 300
    accepted = np.ones(n, bool)
    accepted[[5, 250]] = False
    p = Profile("1", 0.0, 0.0, np.datetime64("2019-01-01"), np.arange(n, dtype=float),
                np.zeros(n), np.array(["1"] * n), accepted, "D", "temp", "x")
    keep = _thin(p)
    assert keep.size <= STICK_LEVELS + 2 and {5, 250} <= set(keep.tolist()), \
        "thinning a stick must never drop a rejected level"
    print("cubecasts ok: rejected levels survive thinning")


if __name__ == "__main__":
    demo()
