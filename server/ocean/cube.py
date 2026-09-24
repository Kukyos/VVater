"""A cube of ocean: one variable, one day, any box on Earth, from the surface down.

This is what the viewer's Ocean Cube is drawn from. A request names a variable from
`catalog.py`, a longitude/latitude box, a day and a maximum depth; the answer is the
field on the dataset's **native depth levels** (never more, hard rule 3), block-averaged
horizontally to a display budget, with the sea floor under it and a provenance record
saying exactly where every number came from and what was assumed on the way.

Order of operations, and why:

  1. **Resolve** the day to an era (`catalog.resolve`): reanalysis where it exists,
     analysis & forecast after it, with forecast days flagged.
  2. **Read** only the native levels inside the depth range (`arco.open_store`).
  3. **Normalise** the vertical axis. The ARCO stores call it `elevation` and hold
     negative metres, while its attributes still say `standard_name=depth`,
     `positive=down`. We read depth = -elevation, record that assumption (hard rule 5),
     and pin it with physics in `live_check`, not with the metadata that contradicts it.
  4. **Range-test at native resolution** (`cf.global_range_check`), before any averaging
     could dilute an impossible cell into a plausible one; the same order as volume.build.
  5. **Derive** (density, sound speed, current speed) at native resolution with TEOS-10.
  6. **Block-average** horizontally to at most MAX_HORIZONTAL cells a side. Depth is
     never touched.

Output order is (depth, lat, lon), shallow first and south first, x fastest. The viewer
builds faces and slices from that directly; the voxel path resamples it itself.

    python -m server.ocean.cube            # self-check, no network
    python -m server.ocean.cube --live     # one real cube, and the depth-sign physics test
"""

from __future__ import annotations

import math
import sys
import threading
import warnings
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache

import numpy as np

from . import catalog, cf

# Cells per horizontal axis sent to the viewer. 160 x 160 x 50 levels is 1.3 M values,
# 5 MB as float32 before gzip: comfortable to colour faces from on the CPU and to hand to
# the voxel renderer, which froze at 2 M voxels in one tile (docs/11-deferred.md D-15).
MAX_HORIZONTAL = 160

# The largest box one request may cover. Cost scales with the ARCO chunks a box touches
# (one depth level of one day, 42 x 170 deg each), not with its area, so this is about the
# size of a basin rather than about bandwidth: at 1/12 deg a 90 deg box is already block-
# averaged 7:1, and a cube much wider than that stops being a cube and becomes a map.
MAX_BOX_DEG = (100.0, 80.0)

# Bounding-box edges snap to this grid, so near-identical requests share a cache entry.
SNAP_DEG = 0.25

BATHY = ("cmems_mod_glo_phy_my_0.083deg_static", "static-arco", "bathy")


# ------------------------------------------------------------------ request

@dataclass(frozen=True)
class Box:
    lon0: float
    lon1: float  # may exceed 180 for a box across the antimeridian
    lat0: float
    lat1: float

    @classmethod
    def parse(cls, lon0: float, lon1: float, lat0: float, lat1: float) -> "Box":
        snap = lambda v, f: f(v / SNAP_DEG) * SNAP_DEG  # noqa: E731
        lon0, lon1 = snap(lon0, math.floor), snap(lon1, math.ceil)
        lat0, lat1 = snap(lat0, math.floor), snap(lat1, math.ceil)
        if lon1 <= lon0:
            lon1 += 360.0  # 170 E to 170 W arrives as (170, -170)
        if not (-180 <= lon0 < 180 and lon1 - lon0 <= MAX_BOX_DEG[0]):
            raise ValueError(f"longitude box {lon0}..{lon1} is outside -180..180 or wider "
                             f"than {MAX_BOX_DEG[0]} deg")
        lat0, lat1 = max(lat0, -80.0), min(lat1, 90.0)  # the products stop at 80 S
        if not (lat1 > lat0 and lat1 - lat0 <= MAX_BOX_DEG[1]):
            raise ValueError(f"latitude box {lat0}..{lat1} is empty or taller than "
                             f"{MAX_BOX_DEG[1]} deg")
        return cls(lon0, lon1, lat0, lat1)

    def pieces(self) -> list[tuple[float, float, float]]:
        """(lo, hi, shift): store-longitude ranges to read, and what to add to their
        longitudes so the stitched axis is continuous across the antimeridian."""
        if self.lon1 <= 180.0:
            return [(self.lon0, self.lon1, 0.0)]
        return [(self.lon0, 180.0, 0.0), (-180.0, self.lon1 - 360.0, 360.0)]


# ------------------------------------------------------------------ reading

@dataclass
class Raw:
    """One stored variable, read at native resolution."""

    values: np.ndarray        # (nz, ny, nx) or (ny, nx), float64, shallow first, south first
    depths: np.ndarray | None  # native metres, shallow first
    lats: np.ndarray
    lons: np.ndarray
    attrs: dict
    resolved: catalog.Resolved
    assumptions: list[str] = field(default_factory=list)


def _vertical(ds) -> tuple[str, np.ndarray, str | None]:
    """The vertical axis name, depths in positive metres, and what had to be assumed."""
    if "elevation" in ds.coords:
        values = np.asarray(ds["elevation"].values, dtype=float)
        attrs = ds["elevation"].attrs
        note = None
        if values.max() <= 0:
            note = ("vertical axis 'elevation' holds negative metres "
                    f"({values.min():.1f} to {values.max():.2f}) while its attributes say "
                    f"standard_name={attrs.get('standard_name')!r}, "
                    f"positive={attrs.get('positive')!r}; read as depth = -elevation")
        return "elevation", -values if values.max() <= 0 else values, note
    return "depth", np.asarray(ds["depth"].values, dtype=float), None


def _read(key: str, box: Box, day: str, depth_max: float) -> Raw:
    from . import arco

    resolved = catalog.resolve(key, day)
    store = arco.open_store(resolved.era.dataset)
    ds = store.ds
    var = ds[resolved.era.var]
    when = np.datetime64(day)
    times = store.times
    t_index = int(np.searchsorted(times, when))
    if t_index >= times.size or times[t_index] != when:
        raise LookupError(f"{resolved.era.dataset} has no step on {day}")
    var = var.isel(time=t_index)

    assumptions: list[str] = []
    depths = None
    if "elevation" in var.dims or "depth" in var.dims:
        zname, all_depths, note = _vertical(ds)
        if note:
            assumptions.append(note)
        order = np.argsort(all_depths)  # shallow first, whatever the store's order
        keep = order[all_depths[order] <= depth_max]
        if keep.size == 0:
            keep = order[:1]  # a range shallower than the top level still gets the top
        depths = all_depths[keep]
        if var.sizes[zname] > 1:
            # isel with a sorted index list reads only these levels' chunks; restore
            # the shallow-first order afterwards.
            idx = np.sort(keep)
            var = var.isel({zname: idx})
            depths_read = all_depths[idx]
        else:
            depths_read = all_depths[keep]
            var = var.isel({zname: 0})
    lats_all = np.asarray(ds["latitude"].values, dtype=float)
    lat_sel = (lats_all >= box.lat0) & (lats_all <= box.lat1)

    pieces, lons = [], []
    lons_all = np.asarray(ds["longitude"].values, dtype=float)
    for lo, hi, shift in box.pieces():
        lon_sel = (lons_all >= lo) & (lons_all <= hi)
        if not lon_sel.any():
            continue
        sub = var.isel(latitude=np.flatnonzero(lat_sel), longitude=np.flatnonzero(lon_sel))
        pieces.append(np.asarray(sub.values, dtype=float))
        lons.append(lons_all[lon_sel] + shift)
    if not pieces or not lat_sel.any():
        raise LookupError(f"the box {box} contains no {resolved.era.dataset} grid cells")
    values = np.concatenate(pieces, axis=-1)

    if depths is not None and values.ndim == 3:
        values = values[np.argsort(depths_read)]  # back to shallow first
        depths = np.sort(depths_read)
    return Raw(values, depths, lats_all[lat_sel], np.concatenate(lons),
               dict(var.attrs), resolved, assumptions)


def _block_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean over k x k blocks of the last two axes; NaN skipped, all-NaN stays NaN.
    The ragged edge keeps its partial block rather than being trimmed: a user's box edge
    is where they asked to see, not a remainder."""
    if k == 1:
        return a
    ny, nx = a.shape[-2], a.shape[-1]
    py, px = (-ny) % k, (-nx) % k
    padded = np.pad(a, [(0, 0)] * (a.ndim - 2) + [(0, py), (0, px)], constant_values=np.nan)
    blocks = padded.reshape(*a.shape[:-2], (ny + py) // k, k, (nx + px) // k, k)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN block -> NaN, wanted
        return np.nanmean(blocks, axis=(-3, -1))


def _axis_mean(axis: np.ndarray, k: int) -> np.ndarray:
    if k == 1:
        return axis
    pad = (-axis.size) % k
    padded = np.concatenate([axis, np.full(pad, np.nan)])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(padded.reshape(-1, k), axis=1)


def factor_for(ny: int, nx: int, budget: int = MAX_HORIZONTAL) -> int:
    return max(1, -(-max(ny, nx) // budget))


# ------------------------------------------------------------------ derivation

def derive(key: str, inputs: dict[str, np.ndarray], depths: np.ndarray | None,
           lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Compute a derived variable from its stored inputs, at their native resolution."""
    if key == "speed":
        return np.hypot(inputs["u"], inputs["v"])
    if key in ("density", "sound_speed"):
        import gsw

        theta, sp = inputs["temperature"], inputs["salinity"]
        z = -depths[:, None, None]
        lat = lats[None, :, None]
        lon = lons[None, None, :]
        p = gsw.p_from_z(z, lat)
        sa = gsw.SA_from_SP(sp, p, lon, lat)
        ct = gsw.CT_from_pt(sa, theta)
        return gsw.sigma0(sa, ct) if key == "density" else gsw.sound_speed(sa, ct, p)
    raise KeyError(f"{key} is not a derived variable")


# ------------------------------------------------------------------ the cube

@dataclass
class Cube:
    values: np.ndarray        # float32, (nz, ny, nx) or (ny, nx), shallow first, south first
    lons: np.ndarray          # cell centres, possibly past 180 across the antimeridian
    lats: np.ndarray
    depths: np.ndarray | None  # native levels, metres, shallow first
    seafloor: np.ndarray      # (ny, nx) float32 metres below the surface, NaN on land
    value_range: tuple[float, float]
    provenance: dict

    def meta(self) -> dict:
        ny, nx = self.values.shape[-2:]
        return {
            "shape": list(self.values.shape),
            "dimensions": [int(nx), int(ny), int(self.values.shape[0]) if self.values.ndim == 3 else 1],
            "lons": [round(float(v), 5) for v in self.lons],
            "lats": [round(float(v), 5) for v in self.lats],
            "depths": None if self.depths is None else [round(float(v), 3) for v in self.depths],
            "valueRange": list(self.value_range),
            "provenance": self.provenance,
        }

    def payload(self) -> bytes:
        """float32 values, then float32 sea-floor depth. Shapes from meta()."""
        return (np.ascontiguousarray(self.values, dtype=np.float32).tobytes()
                + np.ascontiguousarray(self.seafloor, dtype=np.float32).tobytes())


def display_range(values: np.ndarray, signed: bool) -> tuple[float, float]:
    """2nd-98th percentile, symmetric about zero for a signed field. A display default,
    never a clip: the data sent keeps every value."""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return (0.0, 1.0)
    lo, hi = (float(v) for v in np.percentile(finite, [2, 98]))
    if signed:
        extent = max(abs(lo), abs(hi), 1e-9)
        lo, hi = -extent, extent
    if hi <= lo:
        hi = lo + 1e-6
    return (round(lo, 6), round(hi, 6))


def _seafloor(lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """Sea-floor depth under each output cell, nearest 1/12 deg bathymetry cell."""
    from . import arco

    ds = arco.open_store(*BATHY).ds
    blats = np.asarray(ds["latitude"].values, dtype=float)
    blons = np.asarray(ds["longitude"].values, dtype=float)
    wrapped = ((lons + 180.0) % 360.0) - 180.0
    iy = np.clip(np.searchsorted(blats, lats), 0, blats.size - 1)
    ix = np.clip(np.searchsorted(blons, wrapped), 0, blons.size - 1)
    # Nearest, not merely the right-hand neighbour.
    iy = np.where((iy > 0) & (np.abs(blats[iy - 1] - lats) < np.abs(blats[iy] - lats)), iy - 1, iy)
    ix = np.where((ix > 0) & (np.abs(blons[ix - 1] - wrapped) < np.abs(blons[ix] - wrapped)),
                  ix - 1, ix)
    y0, y1 = int(iy.min()), int(iy.max()) + 1
    xs = np.unique(ix)
    block = np.asarray(ds["deptho"].isel(latitude=slice(y0, y1), longitude=xs).values, dtype=float)
    col = {x: i for i, x in enumerate(xs)}
    return block[np.ix_(iy - y0, [col[x] for x in ix])].astype(np.float32)


def assemble(key: str, raws: dict[str, Raw], budget: int = MAX_HORIZONTAL) -> tuple:
    """Everything after the read: range test, derivation, block mean. No I/O, so the
    self-check drives it with synthetic arrays."""
    variable = catalog.VARIABLES[key]
    first = next(iter(raws.values()))
    inputs, tests, assumptions, sources = {}, {}, [], []
    for name, raw in raws.items():
        base = catalog.VARIABLES[name]
        da_like = type("A", (), {"attrs": raw.attrs})()
        report = cf.normalise_variable(da_like, base.canonical or name)
        bad, range_report = cf.global_range_check(raw.values, report.standard_name)
        inputs[name] = np.where(bad, np.nan, raw.values)
        tests[name] = {**range_report, "masked_cells": int(bad.sum())}
        assumptions += [f"{name}: {a}" for a in report.assumptions + raw.assumptions]
        sources.append({**raw.resolved.provenance(), "standard_name": report.standard_name,
                        "units": raw.attrs.get("units", "")})
        if raw.values.shape != first.values.shape:
            raise ValueError(f"{name} and {next(iter(raws))} are on different grids")

    if variable.derived:
        field_ = derive(key, inputs, first.depths, first.lats, first.lons)
    else:
        field_ = inputs[key]

    ny, nx = field_.shape[-2:]
    k = factor_for(ny, nx, budget)
    values = _block_mean(field_, k).astype(np.float32)
    lats, lons = _axis_mean(first.lats, k), _axis_mean(first.lons, k)
    step = float(np.median(np.diff(first.lats))) if first.lats.size > 1 else float("nan")

    forecast = any(s["forecast"] for s in sources)
    provenance = {
        "variable": key,
        "title": variable.title,
        "units": variable.units,
        "day": first.resolved.day,
        "forecast": forecast,
        "sources": sources,
        "derived": ({"from": list(variable.derived), "formula": variable.formula}
                    if variable.derived else None),
        "native_levels": None if first.depths is None else int(first.depths.size),
        "depth_note": ("native levels only, never interpolated to more (hard rule 3); "
                       "faces drawn between levels are a display interpolation"),
        "horizontal": {"native_step_deg": round(step, 5), "block": k,
                       "display_step_deg": round(step * k, 5),
                       "note": (f"{k}x{k} block mean of the native grid, for display"
                                if k > 1 else "native grid")},
        "range_test": tests,
        "cf_assumptions": sorted(set(assumptions)),
        "note": variable.note,
    }
    return values, lats, lons, first.depths, provenance


# One lock per distinct request, never evicted: a few hundred small objects per session.
_build_locks: dict[tuple, threading.Lock] = defaultdict(threading.Lock)
_locks_guard = threading.Lock()


def build(key: str, box: Box, day: str, depth_max: float = 6000.0,
          budget: int = MAX_HORIZONTAL) -> Cube:
    """One cube. Cached, and built once even when the same request arrives twice at the
    same time (the API serves requests from a thread pool; a prefetch and a real load of
    the same day used to race exactly like that in sources.py)."""
    args = (key, box, day, depth_max, budget)
    with _locks_guard:
        lock = _build_locks[args]
    with lock:
        return _build(*args)


@lru_cache(maxsize=12)
def _build(key: str, box: Box, day: str, depth_max: float, budget: int) -> Cube:
    date.fromisoformat(day)  # validates the format before anything touches the network
    bases = catalog.base_variables(key)
    with ThreadPoolExecutor(max_workers=len(bases) + 1) as pool:
        futures = {b: pool.submit(_read, b, box, day, depth_max) for b in bases}
        raws = {b: f.result() for b, f in futures.items()}
    values, lats, lons, depths, provenance = assemble(key, raws, budget)
    seafloor = _seafloor(lats, lons)
    provenance["seafloor"] = ("Copernicus GLORYS12 static bathymetry (deptho), nearest "
                              "1/12 deg cell to each display cell")
    variable = catalog.VARIABLES[key]
    return Cube(values, lats=lats, lons=lons, depths=depths, seafloor=seafloor,
                value_range=display_range(values, variable.signed), provenance=provenance)


# ------------------------------------------------------------------ self-checks

def demo() -> None:
    # Box: snapping, antimeridian, limits.
    b = Box.parse(80.1, 94.9, 5.05, 19.9)
    assert (b.lon0, b.lon1, b.lat0, b.lat1) == (80.0, 95.0, 5.0, 20.0), b
    across = Box.parse(170, -170, -5, 5)
    assert across.lon1 == 190.0 and len(across.pieces()) == 2, across
    assert across.pieces()[1] == (-180.0, -170.0, 360.0)
    for bad in ((0, 150, 0, 10), (0, 10, 5, 5)):
        try:
            Box.parse(*bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"{bad} should be refused")

    # Block mean keeps the ragged edge and skips NaN.
    a = np.array([[[1.0, 3.0, 5.0], [np.nan, 7.0, np.nan]]])
    m = _block_mean(a, 2)
    assert m.shape == (1, 1, 2) and m[0, 0, 0] == (1 + 3 + 7) / 3 and m[0, 0, 1] == 5.0, m
    assert _axis_mean(np.array([1.0, 2, 3]), 2).tolist() == [1.5, 3.0]

    # Assemble: native levels only, range test before averaging, derivation.
    depths = np.array([0.5, 10.0, 100.0, 1000.0])
    lats = np.linspace(10, 12, 3)
    lons = np.linspace(80, 83, 4)
    shape = (4, 3, 4)
    theta = np.broadcast_to(np.array([29.0, 28.0, 20.0, 5.0])[:, None, None], shape).copy()
    theta[0, 0, 0] = 45.0  # impossible: must be masked, not averaged in
    sp = np.full(shape, 35.0)
    fake = lambda name, vals, units: Raw(  # noqa: E731
        vals, depths, lats, lons, {"standard_name": {"temperature": "sea_water_potential_temperature",
                                                     "salinity": "sea_water_salinity"}[name],
                                   "units": units},
        catalog.Resolved(catalog.VARIABLES[name], catalog.VARIABLES[name].eras[0],
                         "2018-08-25", False))
    raws = {"temperature": fake("temperature", theta, "degrees_C")}
    values, *_ , prov = assemble("temperature", raws, budget=2)
    assert values.shape == (4, 2, 2), values.shape
    assert prov["range_test"]["temperature"]["masked_cells"] == 1
    assert np.nanmax(values[0]) <= 29.0, "the 45 degC cell leaked into a block mean"
    assert prov["native_levels"] == 4 and prov["horizontal"]["block"] == 2

    raws["salinity"] = fake("salinity", sp, "1e-3")
    sigma, *_ = assemble("density", raws)
    # Reference values from gsw directly: 29 degC / 35 PSU is 22.06, 5 degC is 27.68.
    assert abs(sigma[0, 1, 1] - 22.06) < 0.05 and abs(sigma[-1, 1, 1] - 27.68) < 0.1, sigma[:, 1, 1]
    assert np.all(np.diff(sigma[:, 1, 1]) > 0), "density must increase with depth here"
    c, *_ = assemble("sound_speed", raws)
    assert 1480 < c[-1, 1, 1] < 1560, c[-1, 1, 1]

    lo, hi = display_range(np.array([-1.0, 0.5, 2.0]), signed=True)
    assert lo == -hi, (lo, hi)
    print("cube ok: box, block mean, range test before averaging, TEOS-10 derivations")


def live_check() -> None:
    """One real cube, and the check that is not self-consistency: the depth sign.

    The store's vertical metadata contradicts its values (see _vertical), so the sign is
    pinned by physics. North Atlantic subtropical gyre, summer: the surface is warm and
    2,000 m is cold everywhere in it."""
    import time

    import truststore
    truststore.inject_into_ssl()
    t = time.time()
    cube = build("temperature", Box.parse(-50, -35, 25, 35), "2019-08-15", 2200.0)
    top = np.nanmean(cube.values[0])
    deep_index = int(np.argmin(np.abs(cube.depths - 2000)))
    deep = np.nanmean(cube.values[deep_index])
    print(f"{cube.values.shape} in {time.time() - t:.1f} s; surface {top:.2f} degC, "
          f"{cube.depths[deep_index]:.0f} m {deep:.2f} degC; "
          f"sea floor {np.nanmin(cube.seafloor):.0f}-{np.nanmax(cube.seafloor):.0f} m")
    assert 20 < top < 32, f"surface {top} is not a subtropical summer surface"
    assert 2 < deep < 6, f"2000 m reads {deep}: the depth axis is upside down"
    assert cube.provenance["native_levels"] == cube.depths.size <= 50
    print("live ok: depth = -elevation confirmed by physics")


if __name__ == "__main__":
    live_check() if "--live" in sys.argv else demo()
