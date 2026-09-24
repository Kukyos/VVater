"""Wind and waves: the weather at the sea surface, for the animation and for fishermen.

Two Copernicus Marine ARCO stores, read the same way as the ocean model (arco.py), probed
2026-09-24 (docs/05-data-sources.md 1.6):

  * **Wind** `cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H` (WIND_GLO_PHY_L4_NRT_012_004):
    10 m *stress-equivalent* wind, hourly, 1/8 deg, 2020-07-01 to yesterday. It is
    scatterometer observations blended with ECMWF, not a forecast: there is no wind for
    today or later. One global hour reads in about 4 s cold. Before July 2020 the
    reprocessed twin `cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H` (WIND_GLO_PHY_L4_MY_012_006,
    2007-01-11 onward, same variables and grid) is read instead, and the response names it.
  * **Wind forecast** for the days the observations have not reached (today and up to about
    two weeks ahead): NCEP GFS 0.25 deg, 10 m u and v, from UCAR's THREDDS "Best" GFS
    collection through its NetCDF subset service -- no credentials, NetCDF back, so xarray
    reads it with nothing new installed. One global field at 1/2 deg is 1.5 MB, about 4 s.
    It is a *model forecast*, not stress-equivalent wind, and every response says so.
  * **Waves** `cmems_mod_glo_wav_anfc_0.083deg_PT3H-i` (GLOBAL_ANALYSISFORECAST_WAV_001_027):
    significant wave height `VHM0`, 3-hourly instants, 1/12 deg, 2022-11 to ten days
    ahead. A forecast, which is what anyone deciding whether to go out needs.

Each day is read at one fixed hour, 12:00 UTC, and every response says so: a day's wind
is not one number, and quoting the noon field as "the day's wind" without saying which
hour would be a normalisation nobody could see (hard rule 5).

    python -m server.ocean.marine           # self-check, no network
    python -m server.ocean.marine --live    # one real global wind field, one wave box
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import numpy as np

from . import arco, cube

WIND_DATASET = "cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H"
WIND_DATASET_MY = "cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H"
WAVE_DATASET = "cmems_mod_glo_wav_anfc_0.083deg_PT3H-i"
HOUR = "12:00"
# Display grid of the global wind animation: 1/8 deg averaged 4:1 to 1/2 deg (720 x 360,
# 2 MB for u and v). Particles are drawn a few pixels long; finer adds bytes, not detail.
WIND_BLOCK = 4
GFS_URL = "https://thredds.ucar.edu/thredds/ncss/grid/grib/NCEP/GFS/Global_0p25deg/Best"
GFS_VARS = ("u-component_of_wind_height_above_ground", "v-component_of_wind_height_above_ground")
GFS_NAME = "NCEP GFS 0.25 deg (UCAR THREDDS, Best collection), 10 m wind"
# Beyond any recorded 10 m wind; a cell past it is a bad value, masked and counted.
WIND_LIMIT_MS = 120.0


def _instant(store: arco.OpenStore, day: str) -> str:
    first, last = store.coverage()
    if not first <= day <= last:
        raise LookupError(f"{store.dataset_id} covers {first} to {last}; {day} is outside it")
    return f"{day}T{HOUR}"


def _wind_store(day: str) -> tuple[arco.OpenStore, str]:
    """The near-real-time wind if it has the day, else the reprocessed record."""
    nrt = arco.open_store(WIND_DATASET)
    if day >= nrt.coverage()[0]:
        return nrt, _instant(nrt, day)
    my = arco.open_store(WIND_DATASET_MY)
    return my, _instant(my, day)


def _provenance(store: arco.OpenStore, when: str, variable: str, note: str) -> dict:
    return {"dataset": store.dataset_id, "time_utc": when, "variable": variable,
            "fixed_hour_note": f"the field at {HOUR} UTC stands for the day", "note": note}


def _observed_until() -> str:
    return arco.open_store(WIND_DATASET).coverage()[1]


def _gfs(day: str, box: "cube.Box | None" = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, str]:
    """GFS 10 m u, v at 12:00 UTC: globally at 1/2 deg, or over a box at 1/4 deg.
    Returned south row first, longitudes ascending in -180..180 (or past 180 for a box
    across the date line, as cube.Box keeps them)."""
    import io

    import requests
    import xarray as xr

    when = f"{day}T{HOUR}:00Z"
    pieces = [(None, None, 0.0)] if box is None else box.pieces()
    us, vs, lon_parts, lats = [], [], [], None
    for lo, hi, shift in pieces:
        q = {"var": list(GFS_VARS), "time": when, "vertCoord": 10, "accept": "netcdf4"}
        if box is None:
            q["horizStride"] = 2
        else:
            q.update(west=lo, east=hi, south=box.lat0, north=box.lat1)
        r = requests.get(GFS_URL, params=q, timeout=120)
        if r.status_code == 400:
            raise LookupError(f"GFS forecast has no {when}: {r.text[:160]}")
        r.raise_for_status()
        ds = xr.open_dataset(io.BytesIO(r.content))
        u = np.asarray(ds[GFS_VARS[0]].values, dtype=np.float32).squeeze()
        v = np.asarray(ds[GFS_VARS[1]].values, dtype=np.float32).squeeze()
        la = np.asarray(ds["latitude"].values, dtype=float)
        lo_ = np.asarray(ds["longitude"].values, dtype=float)
        if la[0] > la[-1]:  # GFS is north row first
            u, v, la = u[::-1], v[::-1], la[::-1]
        # GFS longitudes are 0..360; bring them into this piece's own range (-180.. for
        # the globe), so 180 on the east edge of a piece is not read as -180.
        start = -180.0 if lo is None else lo
        lo_ = (lo_ - start) % 360 + start
        if lo is not None:
            lo_ = np.where((lo_ > hi) & np.isclose(lo_ - 360, lo), lo_ - 360, lo_)
        order = np.argsort(lo_)
        lo_ = lo_[order] + shift
        keep = lo_ > lon_parts[-1][-1] if lon_parts else np.ones(lo_.size, bool)  # 180 once
        us.append(u[:, order][:, keep]); vs.append(v[:, order][:, keep])
        lon_parts.append(lo_[keep]); lats = la
    return (np.concatenate(us, axis=1), np.concatenate(vs, axis=1),
            np.concatenate(lon_parts), lats, when)


def _gfs_provenance(when: str, variable: str) -> dict:
    return {"dataset": GFS_NAME, "time_utc": when[:16], "variable": variable, "forecast": True,
            "fixed_hour_note": f"the field at {HOUR} UTC stands for the day",
            "note": "NCEP GFS model forecast of 10 m wind; the observed record ends "
                    f"{_observed_until()}"}


@lru_cache(maxsize=6)
def wind(day: str) -> dict:
    """u and v worldwide at 1/2 deg, for the particles. Only the reduced arrays are kept."""
    if day > _observed_until():
        u, v, lons, lats, when = _gfs(day)
        bad = ~(np.abs(u) <= WIND_LIMIT_MS) | ~(np.abs(v) <= WIND_LIMIT_MS)
        ny, nx = u.shape
        return {"u": np.nan_to_num(np.where(bad, 0, u)).astype(np.float32),
                "v": np.nan_to_num(np.where(bad, 0, v)).astype(np.float32),
                "meta": {"dimensions": [int(nx), int(ny)],
                         "lonRange": [float(lons[0]), float(lons[-1])],
                         "latRange": [float(lats[0]), float(lats[-1])], "levelM": 10.0,
                         "provenance": {**_gfs_provenance(when, "u, v 10 m"),
                                        "display_step_deg": 0.5,
                                        "range_test": {"limit_ms": WIND_LIMIT_MS,
                                                       "masked_cells": int(bad.sum())}}}}
    store, when = _wind_store(day)
    at = store.ds.sel(time=when)
    with ThreadPoolExecutor(max_workers=2) as pool:
        u, v = pool.map(lambda n: np.asarray(at[n].values, dtype=np.float32),
                        ("eastward_wind", "northward_wind"))
    bad = ~(np.abs(u) <= WIND_LIMIT_MS) | ~(np.abs(v) <= WIND_LIMIT_MS)
    masked = int((bad & np.isfinite(u) & np.isfinite(v)).sum())
    u = cube._block_mean(np.where(bad, np.nan, u), WIND_BLOCK)
    v = cube._block_mean(np.where(bad, np.nan, v), WIND_BLOCK)
    lats = cube._axis_mean(np.asarray(store.ds["latitude"].values), WIND_BLOCK)
    lons = cube._axis_mean(np.asarray(store.ds["longitude"].values), WIND_BLOCK)
    ny, nx = u.shape
    return {"u": np.nan_to_num(u).astype(np.float32), "v": np.nan_to_num(v).astype(np.float32),
            "meta": {"dimensions": [int(nx), int(ny)],
                     "lonRange": [float(lons[0]), float(lons[-1])],
                     "latRange": [float(lats[0]), float(lats[-1])],
                     "levelM": 10.0,
                     "provenance": {**_provenance(
                         store, when, "eastward_wind, northward_wind",
                         "10 m stress-equivalent wind: satellite scatterometers blended with "
                         "ECMWF, an observation product, not a forecast"),
                         "display_step_deg": 0.125 * WIND_BLOCK,
                         "range_test": {"limit_ms": WIND_LIMIT_MS, "masked_cells": masked}}}}


def _box(store: arco.OpenStore, name: str, when: str, box: cube.Box) -> tuple:
    """One field over a box at native resolution, stitched across the date line."""
    parts, lon_parts = [], []
    for lo, hi, shift in box.pieces():
        sub = store.ds[name].sel(time=when, latitude=slice(box.lat0, box.lat1),
                                 longitude=slice(lo, hi))
        parts.append(np.asarray(sub.values, dtype=np.float32))
        lon_parts.append(np.asarray(sub["longitude"].values, dtype=float) + shift)
    return (np.concatenate(parts, axis=1), np.concatenate(lon_parts),
            np.asarray(sub["latitude"].values, dtype=float))


def wind_speed_box(box: cube.Box, day: str) -> dict:
    if day > _observed_until():
        u, v, lons, lats, when = _gfs(day, box)
        speed = np.hypot(u, v)
        speed[~(speed <= WIND_LIMIT_MS)] = np.nan
        return {"values": speed, "lons": lons, "lats": lats,
                "provenance": _gfs_provenance(when, "wind speed from u, v at 10 m")}
    store, when = _wind_store(day)
    u, lons, lats = _box(store, "eastward_wind", when, box)
    v, _, _ = _box(store, "northward_wind", when, box)
    speed = np.hypot(u, v)
    speed[~(speed <= WIND_LIMIT_MS)] = np.nan
    return {"values": speed, "lons": lons, "lats": lats,
            "provenance": _provenance(store, when, "wind speed from eastward/northward_wind",
                                      "10 m stress-equivalent wind, observation product")}


def wave_height_box(box: cube.Box, day: str) -> dict:
    store = arco.open_store(WAVE_DATASET)
    when = _instant(store, day)
    h, lons, lats = _box(store, "VHM0", when, box)
    h[~((h >= 0) & (h <= 30))] = np.nan  # beyond any recorded significant wave height
    return {"values": h, "lons": lons, "lats": lats,
            "provenance": _provenance(store, when, "VHM0 sea_surface_wave_significant_height",
                                      "model analysis and forecast")}


def demo() -> None:
    class Fake:
        dataset_id = "x"

        @staticmethod
        def coverage():
            return "2020-07-01", "2026-09-23"
    assert _instant(Fake, "2026-09-01") == "2026-09-01T12:00"
    try:
        _instant(Fake, "2026-09-24")
    except LookupError as exc:
        assert "outside" in str(exc)
    else:
        raise AssertionError("a day past the wind record must be refused, not guessed")
    lon = np.array([170.0, 175.0, 180.0])
    start = 170.0
    assert ((lon - start) % 360 + start).tolist() == [170, 175, 180], "180 stays east"
    print("marine ok: fixed hour stated, days outside the record refused, date line kept")


def live() -> None:
    import time

    import truststore
    truststore.inject_into_ssl()
    t = time.time()
    w = wind("2026-09-20")
    speed = np.hypot(w["u"], w["v"])
    print(f"wind {w['u'].shape} in {time.time() - t:.1f} s, max {speed.max():.1f} m/s")
    assert 5 < speed.max() < 80
    t = time.time()
    h = wave_height_box(cube.Box.parse(80, 95, 5, 20), "2026-09-25")
    print(f"waves {h['values'].shape} in {time.time() - t:.1f} s, "
          f"max {np.nanmax(h['values']):.1f} m")


if __name__ == "__main__":
    live() if "--live" in sys.argv else demo()
