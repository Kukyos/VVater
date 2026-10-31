"""Where would something in the water go, or where did it come from: search-and-rescue drift.

Click the sea, and an ensemble of particles is carried by the **surface currents of each
day in turn**, with the currents interpolated linearly in time between daily means. This is
a trajectory through time, unlike the streamlines and the animated particles, which are one
day's flow drawn as a picture (D-13). Forward it answers "where will it be"; backward (the
same integration with time reversed) answers "where could it have come from".

What moves a particle, per hour:

    velocity = surface current (model, daily means, linear in time)
             + leeway x 10 m wind      (downwind only; 0 for "current only")
    position += velocity through a midpoint (RK2) step + a random walk

**Why an ensemble and not one line.** One line from a model field is a precise answer to a
question nobody can ask: the start point is not known exactly, the model current is not
the true current, and how strongly the wind pushes depends on the object. The spread comes
from three stated choices, all listed in docs/10-unsourced.md and in every response:

  * a random walk with horizontal diffusivity DIFFUSIVITY_M2_S (sub-grid motion the daily
    1/12 deg field cannot hold);
  * each particle's leeway drawn uniformly within +-LEEWAY_SPREAD of the object's nominal;
  * start points scattered with SEED_SPREAD_M standard deviation.

**Leeway is simplified, and says so.** Operational leeway tables (Allen and Plourde, US
Coast Guard) give a slope, an offset and a crosswind divergence per object class. Here it is
one downwind percentage per class. That is the main reason this is a teaching and planning
aid, not a SAR product.

Land ends a particle: it stops where it would have entered a land cell, and the share that
did is reported per day as "reached the coast". A particle that leaves the area read for the
run is reported separately and never extrapolated.

The 90 % search ellipse per day is the covariance ellipse of the particles, scaled by the
chi-square 90 % point for two degrees of freedom (sqrt(4.605)).

    python -m server.ocean.drift            # self-check, no network
    python -m server.ocean.drift --live     # one real run, Bay of Bengal 2018-08-25
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache

import numpy as np

# ---------------------------------------------------------------- stated choices

# Objects and their nominal downwind leeway, % of the 10 m wind. Simplified (see above).
OBJECTS = {
    "current": ("Current only, no wind", 0.0),
    "person": ("Person in the water", 1.0),
    "liferaft": ("Life raft", 3.0),
}
DIFFUSIVITY_M2_S = 10.0      # horizontal random walk
LEEWAY_SPREAD = 0.5          # each particle's leeway in nominal x [0.5, 1.5]
SEED_SPREAD_M = 1_000.0      # start-point scatter, standard deviation
PARTICLES = 200
STEP_S = 3_600.0
MAX_HOURS = 120
MARGIN_DEG = 6.0             # area read around the start: 2 m/s for 72 h is ~5 deg
CHI2_90_2DOF = 4.605
SNAPSHOT_EVERY_H = 6
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON_EQ = 111_320.0


@dataclass
class Field:
    """u and v (m/s) on a regular lon/lat grid, south row first. NaN is land."""

    lons: np.ndarray
    lats: np.ndarray
    u: np.ndarray
    v: np.ndarray

    def sample(self, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Bilinear at many points. NaN if any corner is land or the point is outside, so a
        particle never interpolates its way through a coastline on three sea corners."""
        nx, ny = self.lons.size, self.lats.size
        fx = (lon - self.lons[0]) / (self.lons[-1] - self.lons[0]) * (nx - 1)
        fy = (lat - self.lats[0]) / (self.lats[-1] - self.lats[0]) * (ny - 1)
        outside = (fx < 0) | (fx > nx - 1) | (fy < 0) | (fy > ny - 1) | ~np.isfinite(fx + fy)
        i = np.clip(np.floor(np.nan_to_num(fx)).astype(int), 0, nx - 2)
        j = np.clip(np.floor(np.nan_to_num(fy)).astype(int), 0, ny - 2)
        tx, ty = np.nan_to_num(fx) - i, np.nan_to_num(fy) - j
        out = []
        for f in (self.u, self.v):
            val = ((f[j, i] * (1 - tx) + f[j, i + 1] * tx) * (1 - ty)
                   + (f[j + 1, i] * (1 - tx) + f[j + 1, i + 1] * tx) * ty)
            val[outside] = np.nan
            out.append(val)
        return out[0], out[1]

    def contains(self, lon: np.ndarray, lat: np.ndarray, inset: float = 0.0) -> np.ndarray:
        return ((lon >= self.lons[0] + inset) & (lon <= self.lons[-1] - inset)
                & (lat >= self.lats[0] + inset) & (lat <= self.lats[-1] - inset))


def _between(fields: list[Field], s: float, lon: np.ndarray, lat: np.ndarray):
    """A field list sampled at day-fraction s (0 = noon of the first day), linear in time."""
    k = min(max(int(math.floor(s)), 0), len(fields) - 2) if len(fields) > 1 else 0
    w = min(max(s - k, 0.0), 1.0) if len(fields) > 1 else 0.0
    u0, v0 = fields[k].sample(lon, lat)
    if w == 0.0:
        return u0, v0
    u1, v1 = fields[k + 1].sample(lon, lat)
    return u0 + (u1 - u0) * w, v0 + (v1 - v0) * w


def integrate(currents: list[Field], winds: list[Field] | None, lon0: float, lat0: float,
              hours: int, backward: bool, leeway_pct: float, *, n: int = PARTICLES,
              diffusivity: float = DIFFUSIVITY_M2_S, seed_spread_m: float = SEED_SPREAD_M,
              seed: int = 1) -> dict:
    """The ensemble. `currents` and `winds` are daily fields at noon, oldest first; the
    release is at noon of the first day going forward, of the last day going back."""
    rng = np.random.default_rng(seed)
    coslat0 = math.cos(math.radians(lat0))
    lon = lon0 + rng.normal(0, seed_spread_m, n) / (M_PER_DEG_LON_EQ * coslat0)
    lat = lat0 + rng.normal(0, seed_spread_m, n) / M_PER_DEG_LAT
    leeway = leeway_pct / 100 * rng.uniform(1 - LEEWAY_SPREAD, 1 + LEEWAY_SPREAD, n)
    state = np.zeros(n, dtype=np.int8)  # 0 drifting, 1 reached the coast, 2 left the area

    sign = -1.0 if backward else 1.0
    s = float(len(currents) - 1) if backward else 0.0
    ds = sign * STEP_S / 86_400.0

    def velocity(x, y, s_at):
        u, v = _between(currents, s_at, x, y)
        if winds and leeway_pct > 0:
            wu, wv = _between(winds, s_at, x, y)
            u = u + leeway * np.nan_to_num(wu)
            v = v + leeway * np.nan_to_num(wv)
        k = sign * STEP_S
        return u * k / (M_PER_DEG_LON_EQ * np.cos(np.radians(y))), v * k / M_PER_DEG_LAT

    walk = math.sqrt(2 * diffusivity * STEP_S)
    track = [[lon0, lat0]]
    snapshots = [{"hour": 0, "points": _points(lon, lat)}]
    days = []
    for h in range(1, hours + 1):
        live = state == 0
        dx1, dy1 = velocity(lon, lat, s)
        mx, my = lon + 0.5 * dx1, lat + 0.5 * dy1
        dx2, dy2 = velocity(mx, my, s + 0.5 * ds)
        nx_ = lon + dx2 + rng.normal(0, walk, n) / (M_PER_DEG_LON_EQ * np.cos(np.radians(lat)))
        ny_ = lat + dy2 + rng.normal(0, walk, n) / M_PER_DEG_LAT
        ok = np.isfinite(nx_) & np.isfinite(ny_)
        # Where the next position cannot be computed, or lands on a land cell, say why.
        landed, _ = currents[0].sample(nx_, ny_)
        ok &= np.isfinite(landed)
        # A step that cannot be computed is the coast, unless the particle is at the edge of
        # the area read (within 0.25 deg), where a missing corner means "outside".
        inside = np.where(np.isfinite(nx_) & np.isfinite(ny_),
                          currents[0].contains(np.nan_to_num(nx_), np.nan_to_num(ny_)),
                          currents[0].contains(lon, lat, inset=0.25))
        state[live & ~ok & inside] = 1
        state[live & ~ok & ~inside] = 2
        move = live & ok
        lon[move], lat[move] = nx_[move], ny_[move]
        s += ds
        track.append([float(lon.mean()), float(lat.mean())])
        if h % SNAPSHOT_EVERY_H == 0:
            snapshots.append({"hour": h, "points": _points(lon, lat)})
        if h % 24 == 0 or h == hours:
            days.append({"hour": h, **_ellipse(lon, lat),
                         "reached_coast": round(float((state == 1).mean()), 3),
                         "left_area": round(float((state == 2).mean()), 3)})
    return {"track": [[round(a, 4), round(b, 4)] for a, b in track],
            "snapshots": snapshots, "days": days}


def _points(lon: np.ndarray, lat: np.ndarray) -> list[list[float]]:
    return [[round(float(a), 4), round(float(b), 4)] for a, b in zip(lon, lat)]


def _ellipse(lon: np.ndarray, lat: np.ndarray, sides: int = 48) -> dict:
    """The 90 % ellipse of a cloud of points, in km on the local tangent plane."""
    clon, clat = float(lon.mean()), float(lat.mean())
    kx = M_PER_DEG_LON_EQ * math.cos(math.radians(clat)) / 1000
    ky = M_PER_DEG_LAT / 1000
    xy = np.stack([(lon - clon) * kx, (lat - clat) * ky])
    cov = np.cov(xy) if lon.size > 2 else np.zeros((2, 2))
    vals, vecs = np.linalg.eigh(cov)
    vals = np.clip(vals, 0, None)
    a, b = (math.sqrt(CHI2_90_2DOF * vals[1]), math.sqrt(CHI2_90_2DOF * vals[0]))
    major = vecs[:, 1]
    t = np.linspace(0, 2 * math.pi, sides + 1)
    ex = a * np.cos(t) * major[0] - b * np.sin(t) * major[1]
    ey = a * np.cos(t) * major[1] + b * np.sin(t) * major[0]
    ring = [[round(clon + x / kx, 4), round(clat + y / ky, 4)] for x, y in zip(ex, ey)]
    return {"lon": round(clon, 4), "lat": round(clat, 4), "a_km": round(a, 2),
            "b_km": round(b, 2), "area_km2": round(math.pi * a * b, 1),
            "bearing_deg": round(math.degrees(math.atan2(major[0], major[1])) % 180, 1),
            "ring": ring}


# ---------------------------------------------------------------- real data

def _currents_day(box, day: str) -> tuple[Field, dict]:
    from . import cf, cube
    out, prov, level_m = {}, None, None
    for name in ("u", "v"):
        src = cube._open(name, box, day, 6000.0)
        level_m = float(src.depths[0]) if src.depths is not None else 0.0
        raw = src.level(0)
        bad, _ = cf.global_range_check(raw, "eastward_sea_water_velocity")
        out[name] = np.where(bad, np.nan, raw).astype(np.float64)
        prov = {**src.resolved.provenance(), "level_m": round(level_m, 3)}
        lats, lons = src.lats, src.lons
    return Field(np.asarray(lons, float), np.asarray(lats, float), out["u"], out["v"]), prov


def _wind_day(day: str) -> tuple[Field, dict]:
    from . import marine
    w = marine.wind(day)
    m = w["meta"]
    nx, ny = m["dimensions"]
    lons = np.linspace(m["lonRange"][0], m["lonRange"][1], nx)
    lats = np.linspace(m["latRange"][0], m["latRange"][1], ny)
    return Field(lons, lats, w["u"].astype(np.float64), w["v"].astype(np.float64)), m["provenance"]


@lru_cache(maxsize=32)
def drift(lon: float, lat: float, day: str, hours: int = 72, backward: bool = False,
          obj: str = "liferaft") -> dict:
    """One run on real data. Release (or, going back, the find) at 12:00 UTC on `day`, the
    time the daily mean fields stand for."""
    from . import cube
    if obj not in OBJECTS:
        raise ValueError(f"object must be one of {sorted(OBJECTS)}")
    hours = int(min(max(hours, 6), MAX_HOURS))
    title, leeway_pct = OBJECTS[obj]
    n_days = math.ceil(hours / 24) + 1
    d0 = date.fromisoformat(day)
    days = [(d0 + timedelta(days=sign * k)).isoformat() for k in range(n_days)
            for sign in [(-1 if backward else 1)]]
    days.sort()
    box = cube.Box.parse(lon - MARGIN_DEG, lon + MARGIN_DEG, lat - MARGIN_DEG, lat + MARGIN_DEG)
    currents, cprov = zip(*(_currents_day(box, d) for d in days))
    first_u, _ = currents[0].sample(np.array([lon]), np.array([lat]))
    if not np.isfinite(first_u[0]):
        raise LookupError("that point is land in the current model, or too close to the coast "
                          "for all four surrounding cells to be sea")
    winds, wprov = (None, [])
    if leeway_pct > 0:
        winds, wprov = zip(*(_wind_day(d) for d in days))
    run = integrate(list(currents), list(winds) if winds else None, lon, lat, hours, backward,
                    leeway_pct)
    return {
        "start": {"lon": lon, "lat": lat, "day": day, "time_utc": f"{day}T12:00Z"},
        "hours": hours, "direction": "backward" if backward else "forward",
        "object": {"key": obj, "title": title, "leeway_pct": leeway_pct},
        **run,
        "provenance": {
            "currents": list(cprov), "wind": [p for p in wprov][:1] + ([] if not wprov else
                                                                      [{"days": days}]),
            "method": ("ensemble of %d particles, RK2 hourly steps through daily surface "
                       "currents interpolated linearly in time%s; random walk K=%g m2/s; "
                       "90%% ellipse = covariance x chi2(2 dof, 0.90)" % (
                           PARTICLES, " plus leeway x 10 m wind" if leeway_pct else "",
                           DIFFUSIVITY_M2_S)),
            "assumptions": [
                f"release at 12:00 UTC on {day}, the time the daily means stand for",
                f"start points scattered with {SEED_SPREAD_M:g} m standard deviation",
                f"each particle's leeway is the nominal x uniform[{1 - LEEWAY_SPREAD:g}, "
                f"{1 + LEEWAY_SPREAD:g}]",
                f"horizontal diffusivity {DIFFUSIVITY_M2_S:g} m2/s (a chosen value)",
                "leeway is downwind only: no crosswind divergence, no offset term, a "
                "simplification of the operational leeway tables",
                "a particle stops where it would enter a land cell of the current model",
            ],
            "note": "a planning and teaching aid, not an operational search-and-rescue product",
        },
    }


# ---------------------------------------------------------------- self-check

def demo() -> None:
    lons = np.linspace(80, 90, 41)
    lats = np.linspace(10, 20, 41)
    shape = (lats.size, lons.size)
    east = Field(lons, lats, np.ones(shape), np.zeros(shape))
    calm = Field(lons, lats, np.zeros(shape), np.zeros(shape))
    north_wind = Field(lons, lats, np.zeros(shape), np.full(shape, 10.0))

    r = integrate([east, east], None, 82.0, 15.0, 24, False, 0.0, n=50, diffusivity=0,
                  seed_spread_m=0)
    moved = (r["track"][-1][0] - 82.0) * M_PER_DEG_LON_EQ * math.cos(math.radians(15))
    assert abs(moved - 86_400) < 300, moved  # 1 m/s for a day; cos(lat) varies a little
    assert r["days"][0]["a_km"] < 1e-6, "no spread without diffusion, scatter or leeway"

    back = integrate([east, east], None, 86.0, 15.0, 24, True, 0.0, n=10, diffusivity=0,
                     seed_spread_m=0)
    assert back["track"][-1][0] < 86.0, "backward goes upstream"

    windy = integrate([calm, calm], [north_wind, north_wind], 85.0, 12.0, 24, False, 3.0,
                      n=400, diffusivity=0, seed_spread_m=0)
    north_km = (windy["track"][-1][1] - 12.0) * M_PER_DEG_LAT / 1000
    assert abs(north_km - 25.92) < 1.5, north_km  # 3 % of 10 m/s for a day, mean leeway
    assert windy["days"][0]["a_km"] > 5, "leeway spread stretches the cloud downwind"
    assert abs(windy["days"][0]["bearing_deg"] - 0) < 5 or abs(windy["days"][0]["bearing_deg"] - 180) < 5

    coast = east.u.copy()
    coast[:, lons >= 84] = np.nan  # land from 84 E
    shore = Field(lons, lats, coast, np.zeros(shape))
    s = integrate([shore, shore], None, 82.5, 15.0, 48, False, 0.0, n=20, diffusivity=0,
                  seed_spread_m=0)
    assert s["days"][-1]["reached_coast"] == 1.0 and s["track"][-1][0] < 84.0

    spread = integrate([calm, calm], None, 85.0, 15.0, 24, False, 0.0, n=2000, seed_spread_m=0)
    d = spread["days"][0]
    expected = math.sqrt(CHI2_90_2DOF * 2 * DIFFUSIVITY_M2_S * 86_400) / 1000
    assert abs(d["a_km"] - expected) / expected < 0.1, (d["a_km"], expected)
    print(f"drift ok: advection, backward, leeway, coast, 90 % ellipse "
          f"(random walk alone: {d['a_km']:.2f} km vs {expected:.2f} expected)")


def live() -> None:
    import time

    import truststore
    truststore.inject_into_ssl()
    t = time.time()
    r = drift(88.0, 15.0, "2018-08-25", 72, False, "liferaft")
    print(f"{time.time() - t:.1f} s")
    for d in r["days"]:
        print(d["hour"], d["lon"], d["lat"], d["a_km"], d["b_km"], d["reached_coast"])


if __name__ == "__main__":
    live() if "--live" in sys.argv else demo()
