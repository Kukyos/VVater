"""The whole ocean at one depth on one day: the globe's own layer, and its currents.

One level of any catalogue variable, worldwide, at 1/4 deg: the physics products are 1/12
deg and are block-averaged 3:1 for display; the biogeochemistry products are 1/4 deg and
pass through. A whole level of one day is 12 ARCO chunks, 0.6 s cold (docs/05-data-sources
1.4), so any day from 1993 to the forecast horizon opens without a pre-built archive.

The same rules as the cube (cube.py): the day resolves through `catalog.resolve`, the
level asked for is the nearest native level and the response says which one, the range
test runs at native resolution before any averaging, and derived fields are computed at
native resolution with TEOS-10.

`currents()` returns u and v on the same grid for the particle animation. The particles
are a picture of the flow on that one day at that one level, not trajectories through
time, and every response says so (as the streamlines always have, D-13).

    python -m server.ocean.surface           # self-check, no network
    python -m server.ocean.surface --live    # one real global level
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from . import catalog, cf, cube

# Display resolution of the globe layer: 1/4 deg (1440 x 681 cells, 3.9 MB as float32).
TARGET_STEP_DEG = 0.25


@dataclass
class Level:
    values: np.ndarray        # (ny, nx) float32, south row first, NaN on land
    lons: np.ndarray
    lats: np.ndarray
    level_m: float | None     # the native level used; None for a 2D field
    value_range: tuple[float, float]
    provenance: dict

    def meta(self) -> dict:
        ny, nx = self.values.shape
        return {"dimensions": [int(nx), int(ny)],
                "lonRange": [float(self.lons[0]), float(self.lons[-1])],
                "latRange": [float(self.lats[0]), float(self.lats[-1])],
                "levelM": None if self.level_m is None else round(self.level_m, 3),
                "valueRange": list(self.value_range), "provenance": self.provenance}


def _level_index(src_depths: np.ndarray, depth: float) -> int:
    return int(np.argmin(np.abs(src_depths - depth)))


def _read_global(key: str, day: str, depth: float) -> tuple[np.ndarray, "cube.Source", float | None]:
    """One stored variable, one native level, the whole globe, native resolution.

    `cube._open` resolves the era, the day and the native levels; its box is only there to
    satisfy it, since the whole level is read below, not the box."""
    src = cube._open(key, cube.Box.parse(-180, -170, -10, 10), day, 6000.0)
    level = None
    var = src.var
    if src.zname is not None:
        i = _level_index(src.depths, depth)
        level = float(src.depths[i])
        var = var.isel({src.zname: int(src.zindex[i])})
    return np.asarray(var.values, dtype=np.float32), src, level


@lru_cache(maxsize=16)
def level(key: str, day: str, depth: float = 0.0) -> Level:
    variable = catalog.VARIABLES[key]
    bases = catalog.base_variables(key)
    with ThreadPoolExecutor(max_workers=len(bases)) as pool:
        read = dict(zip(bases, pool.map(lambda b: _read_global(b, day, depth), bases)))
    first_values, first_src, level_m = next(iter(read.values()))
    ds = first_src.var
    lats = np.asarray(ds["latitude"].values, dtype=float)
    lons = np.asarray(ds["longitude"].values, dtype=float)

    inputs, tests, assumptions, sources = {}, {}, set(), []
    for name, (values, src, _) in read.items():
        report = cf.normalise_variable(type("A", (), {"attrs": src.attrs})(),
                                       catalog.VARIABLES[name].canonical or name)
        bad, test = cf.global_range_check(values, report.standard_name)
        inputs[name] = np.where(bad, np.nan, values).astype(np.float32)
        tests[name] = {**test, "masked_cells": int(bad.sum())}
        assumptions.update(f"{name}: {a}" for a in report.assumptions + src.assumptions)
        sources.append({**src.resolved.provenance(), "standard_name": report.standard_name})
    field = (cube.derive(key, inputs, level_m if level_m is not None else 0.0, lats, lons)
             if variable.derived else inputs[key])

    step = float(np.median(np.diff(lats)))
    k = max(1, int(round(TARGET_STEP_DEG / step)))
    values = cube._block_mean(field, k).astype(np.float32)
    out_lats, out_lons = cube._axis_mean(lats, k), cube._axis_mean(lons, k)
    provenance = {
        "variable": key, "title": variable.title, "units": variable.units, "day": day,
        "forecast": any(s["forecast"] for s in sources), "sources": sources,
        "level_m": level_m,
        "level_note": ("nearest native level to the depth asked for" if level_m is not None
                       else "a surface field with no depth axis"),
        "horizontal": {"native_step_deg": round(step, 5), "block": k,
                       "display_step_deg": round(step * k, 5)},
        "derived": ({"from": list(variable.derived), "formula": variable.formula}
                    if variable.derived else None),
        "range_test": tests, "cf_assumptions": sorted(assumptions), "note": variable.note,
    }
    return Level(values, out_lons, out_lats, level_m,
                 cube.display_range(values, variable.signed), provenance)


def currents(day: str, depth: float = 0.0) -> dict:
    """u and v at one level worldwide, for the particles. Land is 0, not NaN: a particle
    that reaches the coast stops and is re-seeded, rather than poisoning the GPU state."""
    u = level("u", day, depth)
    v = level("v", day, depth)
    return {"u": np.nan_to_num(u.values), "v": np.nan_to_num(v.values), "meta": {
        **u.meta(), "provenance": {**u.provenance, "variable": "u,v",
                                   "title": "Currents",
                                   "note": "the flow on this one day at this one level, "
                                           "animated; not trajectories through time"}}}


def regional_currents(box: "cube.Box", day: str, depth: float,
                      budget: int = cube.MAX_HORIZONTAL) -> dict:
    """u and v at the native level nearest `depth` over a cube's box, on the cube's grid."""
    out = {}
    level_m = None
    for name in ("u", "v"):
        src = cube._open(name, box, day, 6000.0)
        i = _level_index(src.depths, depth)
        level_m = float(src.depths[i])
        raw = src.level(i)
        bad, _ = cf.global_range_check(raw, "eastward_sea_water_velocity")
        k = cube.factor_for(src.lats.size, src.lons.size, budget)
        out[name] = np.nan_to_num(cube._block_mean(np.where(bad, np.nan, raw), k)).astype(np.float32)
        lats, lons = cube._axis_mean(src.lats, k), cube._axis_mean(src.lons, k)
    ny, nx = out["u"].shape
    return {"u": out["u"], "v": out["v"], "meta": {
        "dimensions": [int(nx), int(ny)],
        "lonRange": [float(lons[0]), float(lons[-1])],
        "latRange": [float(lats[0]), float(lats[-1])],
        "levelM": round(level_m, 3), "day": day,
        "note": "the flow on this one day at this one level, animated; not trajectories"}}


def demo() -> None:
    assert _level_index(np.array([0.5, 10.0, 100.0]), 40) == 1
    assert _level_index(np.array([0.5, 10.0, 100.0]), 5000) == 2
    step = 1 / 12
    assert int(round(TARGET_STEP_DEG / step)) == 3, "1/12 deg physics shown 3:1"
    assert int(round(TARGET_STEP_DEG / 0.25)) == 1, "1/4 deg BGC passes through"
    print("surface ok: nearest native level, 1/4 deg display")


def live() -> None:
    import time

    import truststore
    truststore.inject_into_ssl()
    t = time.time()
    s = level("temperature", "2019-08-15", 0.0)
    print(f"{s.values.shape} in {time.time() - t:.1f} s, level {s.level_m} m, "
          f"range {s.value_range}")
    tropics = np.nanmean(s.values[np.abs(s.lats) < 10])
    polar = np.nanmean(s.values[s.lats < -60])
    assert tropics > 25 and polar < 5, (tropics, polar)
    t = time.time()
    c = currents("2019-08-15", 0.0)
    print(f"currents {c['u'].shape} in {time.time() - t:.1f} s")


if __name__ == "__main__":
    live() if "--live" in sys.argv else demo()
