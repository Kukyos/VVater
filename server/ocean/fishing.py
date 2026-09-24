"""Where fish are likely to gather, and whether the sea is fit to go out: an indicator.

**What it is not.** INCOIS issues the official Potential Fishing Zone (PFZ) advisories for
Indian waters, from satellite sea-surface temperature and chlorophyll, checked by people,
and broadcast to fishing harbours in local languages. This module is not that and every
response says so. It borrows the published *idea* behind PFZ -- fish gather where warm
and cool water meet (a thermal front) and where there is food (chlorophyll) -- and applies
it to the model fields the viewer already shows, so a coast anywhere in the world gets
the same picture.

**The rule, and why it is relative.** A cell of the box is a likely zone when

  * its sea-surface temperature gradient is among the strongest 10 % in the box, and
  * its surface chlorophyll is at or above the box's median.

Both thresholds are ranks within the box, not absolute numbers, because an absolute front
strength or chlorophyll level that means "fish" is not something this project can source
for every sea on Earth (docs/10-unsourced.md, "Fishing zone rule"). A relative rule always finds the
strongest fronts in the water asked about; it cannot say whether they are strong enough.

**The sea state**, from the wave forecast and the observed wind (marine.py), on two sourced
scales -- the WMO sea state code for significant wave height and the Beaufort scale for
wind -- with the choice of where "caution" and "stay in" fall for a small boat logged as a
judgement (docs/10-unsourced.md, "Sea state for a small boat"):

    caution    waves >= 1.25 m (WMO 4, moderate)  or  wind >= 10.8 m/s (Beaufort 6)
    stay in    waves >= 2.5 m  (WMO 5, rough)     or  wind >= 13.9 m/s (Beaufort 7)

    python -m server.ocean.fishing           # self-check, no network
"""

from __future__ import annotations

import base64

import numpy as np

from . import cube, marine, surface

FRONT_PERCENTILE = 90.0
CHL_PERCENTILE = 50.0
WAVE_CAUTION_M, WAVE_UNSAFE_M = 1.25, 2.5
WIND_CAUTION_MS, WIND_UNSAFE_MS = 10.8, 13.9
SPOTS = 5
SPOT_SEPARATION_DEG = 0.5
KM_PER_DEG = 111.32

NOT_AN_ADVISORY = ("Indicative only, computed from model fields. This is not an INCOIS "
                   "Potential Fishing Zone advisory; for official advisories and ocean "
                   "state warnings see incois.gov.in, and always follow harbour and IMD "
                   "warnings.")


def front_strength(sst: np.ndarray, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """|grad SST| in degC per 100 km, by central differences; NaN next to land."""
    dy = np.gradient(sst, axis=0) / (np.gradient(lats)[:, None] * KM_PER_DEG)
    coslat = np.cos(np.radians(lats))[:, None]
    dx = np.gradient(sst, axis=1) / (np.gradient(lons)[None, :] * KM_PER_DEG * coslat)
    return np.hypot(dx, dy) * 100.0


def zones(front: np.ndarray, chl: np.ndarray) -> tuple[np.ndarray, dict]:
    """The relative rule. Returns the mask and the thresholds it resolved to here."""
    ok = np.isfinite(front) & np.isfinite(chl)
    if ok.sum() < 20:
        return np.zeros(front.shape, bool), {"front": None, "chlorophyll": None}
    f_cut = float(np.percentile(front[ok], FRONT_PERCENTILE))
    c_cut = float(np.percentile(chl[ok], CHL_PERCENTILE))
    return ok & (front >= f_cut) & (chl >= c_cut), {"front": f_cut, "chlorophyll": c_cut}


def sea_state(waves: np.ndarray | None, wind: np.ndarray | None, shape) -> np.ndarray:
    """0 fit, 1 caution, 2 stay in, 3 unknown (neither source has the cell)."""
    out = np.full(shape, 3, np.uint8)
    known = np.zeros(shape, bool)
    level = np.zeros(shape, np.uint8)
    for field, caution, unsafe in ((waves, WAVE_CAUTION_M, WAVE_UNSAFE_M),
                                   (wind, WIND_CAUTION_MS, WIND_UNSAFE_MS)):
        if field is None:
            continue
        good = np.isfinite(field)
        known |= good
        level = np.maximum(level, np.where(good & (field >= unsafe), 2,
                                           np.where(good & (field >= caution), 1, 0)))
    out[known] = level[known]
    return out


def _onto(field: dict | None, lats: np.ndarray, lons: np.ndarray) -> np.ndarray | None:
    """Nearest-neighbour onto the display grid; both grids are regular and ascending."""
    if field is None:
        return None
    iy = np.clip(np.searchsorted(field["lats"], lats), 0, field["lats"].size - 1)
    ix = np.clip(np.searchsorted(field["lons"], lons), 0, field["lons"].size - 1)
    return field["values"][np.ix_(iy, ix)]


def _crop(level: surface.Level, box: cube.Box) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lons = level.lons
    values = level.values
    if box.lon1 > 180:  # across the date line: put the western hemisphere after the east
        lons = np.concatenate([lons, lons + 360])
        values = np.concatenate([values, values], axis=1)
    x = (lons >= box.lon0) & (lons <= box.lon1)
    y = (level.lats >= box.lat0) & (level.lats <= box.lat1)
    return values[np.ix_(y, x)], level.lats[y], lons[x]


def spots(mask: np.ndarray, front: np.ndarray, chl: np.ndarray, state: np.ndarray,
          lats: np.ndarray, lons: np.ndarray) -> list[dict]:
    """The strongest zone cells, at least SPOT_SEPARATION_DEG apart, best first."""
    iy, ix = np.nonzero(mask)
    if not iy.size:
        return []
    rank = front[iy, ix] / np.nanmax(front[iy, ix]) + chl[iy, ix] / np.nanmax(chl[iy, ix])
    chosen: list[dict] = []
    for k in np.argsort(-rank):
        lat, lon = float(lats[iy[k]]), float(lons[ix[k]])
        if any(abs(lat - c["lat"]) < SPOT_SEPARATION_DEG and
               abs(lon - c["lon"]) < SPOT_SEPARATION_DEG for c in chosen):
            continue
        chosen.append({"lat": round(lat, 3), "lon": round(lon - 360 if lon > 180 else lon, 3),
                       "front_c_per_100km": round(float(front[iy[k], ix[k]]), 2),
                       "chlorophyll_mg_m3": round(float(chl[iy[k], ix[k]]), 3),
                       "sea_state": ["fit", "caution", "stay in", "unknown"][
                           int(state[iy[k], ix[k]])]})
        if len(chosen) == SPOTS:
            break
    return chosen


def assess(box: cube.Box, day: str) -> dict:
    sst_level = surface.level("temperature", day, 0.0)
    chl_level = surface.level("chlorophyll", day, 0.0)
    sst, lats, lons = _crop(sst_level, box)
    chl_full, clats, clons = _crop(chl_level, box)
    chl = _onto({"values": chl_full, "lats": clats, "lons": clons}, lats, lons)
    front = front_strength(sst, lats, lons)
    mask, cuts = zones(front, chl)

    missing, sources = [], {}
    readers = (("waves", marine.wave_height_box), ("wind", marine.wind_speed_box))
    fields: dict[str, np.ndarray | None] = {}
    for name, read in readers:
        try:
            got = read(box, day)
            sources[name] = got["provenance"]
            fields[name] = _onto({**got, "lons": np.where(got["lons"] < box.lon0,
                                                          got["lons"] + 360, got["lons"])},
                                 lats, lons)
        except LookupError as exc:
            fields[name] = None
            missing.append(f"{name}: {exc}")
    state = sea_state(fields["waves"], fields["wind"], sst.shape)

    # One byte per cell, south row first: bit 0 a likely zone, bits 1-2 the sea state.
    code = (mask.astype(np.uint8) | (state << 1)).astype(np.uint8)
    ocean = np.isfinite(sst)
    return {
        "dimensions": [int(lons.size), int(lats.size)],
        "lonRange": [float(lons[0]), float(lons[-1])],
        "latRange": [float(lats[0]), float(lats[-1])],
        "cells": base64.b64encode(np.where(ocean, code, 255).astype(np.uint8).tobytes()).decode(),
        "spots": spots(mask, front, chl, state, lats, lons),
        "counts": {"ocean_cells": int(ocean.sum()), "zone_cells": int(mask.sum()),
                   "stay_in_cells": int(((state == 2) & ocean).sum()),
                   "caution_cells": int(((state == 1) & ocean).sum())},
        "provenance": {
            "day": day, "rule": {
                "front": f"|grad SST| in the strongest {100 - FRONT_PERCENTILE:.0f}% of the box",
                "chlorophyll": f"at or above the box's {CHL_PERCENTILE:.0f}th percentile",
                "resolved_thresholds": cuts},
            "sea_state_scale": {"waves_m": {"caution": WAVE_CAUTION_M, "stay_in": WAVE_UNSAFE_M,
                                            "scale": "WMO sea state code 3700"},
                                "wind_ms": {"caution": WIND_CAUTION_MS, "stay_in": WIND_UNSAFE_MS,
                                            "scale": "Beaufort 6 and 7"}},
            "sst": sst_level.provenance["sources"], "chlorophyll": chl_level.provenance["sources"],
            "sea_state_sources": sources, "missing": missing,
            "not_an_advisory": NOT_AN_ADVISORY},
    }


def demo() -> None:
    lats = np.arange(10, 12.01, 0.25)
    lons = np.arange(80, 82.01, 0.25)
    sst = np.tile(np.where(lons < 81, 28.0, 26.0), (lats.size, 1))  # one front at 81E
    front = front_strength(sst, lats, lons)
    assert front[:, 3:5].min() > 0 and front[:, 0].max() == 0, "a front where SST changes"
    chl = np.ones_like(sst)
    mask, cuts = zones(front, chl)
    assert mask.any() and not mask[:, :3].any() and not mask[:, 5:].any(), "zones sit on the front"
    state = sea_state(np.array([[0.5, 1.5, 3.0, np.nan]]), None, (1, 4))
    assert state.tolist() == [[0, 1, 2, 3]], state
    both = sea_state(np.array([[0.5]]), np.array([[14.0]]), (1, 1))
    assert both[0, 0] == 2, "the worse of waves and wind decides"
    s = spots(mask, front, chl, np.zeros_like(mask, np.uint8), lats, lons)
    assert 1 <= len(s) <= SPOTS and all(80.5 <= p["lon"] <= 81.5 for p in s)
    print(f"fishing ok: fronts, relative zones ({cuts}), sea state, spots")


if __name__ == "__main__":
    demo()
