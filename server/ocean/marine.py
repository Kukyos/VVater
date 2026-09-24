"""Wind and waves: the weather at the sea surface, for the animation and for fishermen.

Two Copernicus Marine ARCO stores, read the same way as the ocean model (arco.py), probed
2026-09-24 (docs/05-data-sources.md 1.6):

  * **Wind** `cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H` (WIND_GLO_PHY_L4_NRT_012_004):
    10 m *stress-equivalent* wind, hourly, 1/8 deg, 2020-07-01 to yesterday. It is
    scatterometer observations blended with ECMWF, not a forecast: there is no wind for
    today or later. One global hour reads in about 4 s cold. Before July 2020 the
    reprocessed twin `cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H` (WIND_GLO_PHY_L4_MY_012_006,
    2007-01-11 onward, same variables and grid) is read instead, and the response names it.
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


@lru_cache(maxsize=6)
def wind(day: str) -> dict:
    """u and v worldwide at 1/2 deg, for the particles. Only the reduced arrays are kept."""
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
    print("marine ok: fixed hour stated, days outside the record refused")


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
