"""Current vectors, as streamlines integrated on the server.

`docs/03-limitations.md` L4: a full-column glyph field at GLORYS resolution is 2.85 M
arrows and Cesium will not draw it. The two usual answers are decimated glyphs (readable
but ugly, and still thousands of primitives) and GPU particle advection (beautiful, and a
shader project with its own failure modes).

There is a third that is cheaper than both: **integrate the streamlines in numpy and send
polylines.** A few hundred lines at a few dozen points each is a trivial payload, the
browser draws them as ordinary geometry, and the integration is testable on the server
where a wrong answer is visible as a number rather than as a plausible-looking picture.

The trade, stated plainly: streamlines show the *instantaneous* flow pattern, not
particle trajectories through time. For a field that updates daily that is the honest
thing to draw anyway — advecting a particle for a week through a single day's field
would be a prettier lie.
"""

from dataclasses import dataclass

import numpy as np
import xarray as xr

from . import config


@dataclass
class Streamline:
    """One integrated path, with the speed sampled along it."""

    points: list[tuple[float, float]]   # (lon, lat) in degrees
    speeds: list[float]                 # m/s at each point

    def as_dict(self) -> dict:
        return {
            "points": [[round(lon, 4), round(lat, 4)] for lon, lat in self.points],
            "speeds": [round(s, 4) for s in self.speeds],
        }


def _bilinear(field: np.ndarray, lons: np.ndarray, lats: np.ndarray,
              lon: float, lat: float) -> float:
    """Sample a (lat, lon) grid at one point. NaN outside the grid or over land."""
    if not (lons[0] <= lon <= lons[-1] and lats[0] <= lat <= lats[-1]):
        return float("nan")

    i = int(np.searchsorted(lons, lon) - 1)
    j = int(np.searchsorted(lats, lat) - 1)
    i = min(max(i, 0), len(lons) - 2)
    j = min(max(j, 0), len(lats) - 2)

    tx = (lon - lons[i]) / (lons[i + 1] - lons[i])
    ty = (lat - lats[j]) / (lats[j + 1] - lats[j])

    corners = np.array([field[j, i], field[j, i + 1], field[j + 1, i], field[j + 1, i + 1]])
    if not np.isfinite(corners).all():
        # Any land corner makes the interpolation meaningless; stop the line instead of
        # letting it drift through a coastline on three good corners.
        return float("nan")

    return float(
        corners[0] * (1 - tx) * (1 - ty)
        + corners[1] * tx * (1 - ty)
        + corners[2] * (1 - tx) * ty
        + corners[3] * tx * ty
    )


def integrate(u: np.ndarray, v: np.ndarray, lons: np.ndarray, lats: np.ndarray,
              seed_lon: float, seed_lat: float, steps: int = 40,
              step_degrees: float = 0.12) -> Streamline | None:
    """Trace one streamline with midpoint (RK2) integration.

    Steps are taken in degrees along the *normalised* velocity, so line spacing is even
    and a fast jet does not produce a line that leaves the region in three steps. Speed
    is carried separately and drawn as colour.
    """
    lon, lat = seed_lon, seed_lat
    points: list[tuple[float, float]] = []
    speeds: list[float] = []

    for _ in range(steps):
        u0 = _bilinear(u, lons, lats, lon, lat)
        v0 = _bilinear(v, lons, lats, lon, lat)
        if not (np.isfinite(u0) and np.isfinite(v0)):
            break

        speed = float(np.hypot(u0, v0))
        if speed < 1e-4:
            break

        # Midpoint: sample again halfway along the first estimate. Plain Euler visibly
        # spirals outward on a rotating eddy, which is exactly what this region is full of.
        half = step_degrees / 2
        mid_lon = lon + (u0 / speed) * half / np.cos(np.radians(lat))
        mid_lat = lat + (v0 / speed) * half

        u1 = _bilinear(u, lons, lats, mid_lon, mid_lat)
        v1 = _bilinear(v, lons, lats, mid_lon, mid_lat)
        if not (np.isfinite(u1) and np.isfinite(v1)):
            break

        mid_speed = float(np.hypot(u1, v1))
        if mid_speed < 1e-4:
            break

        points.append((lon, lat))
        speeds.append(speed)

        # Longitude degrees shrink with latitude; without this the lines skew poleward.
        lon += (u1 / mid_speed) * step_degrees / np.cos(np.radians(lat))
        lat += (v1 / mid_speed) * step_degrees

    if len(points) < 4:
        return None
    return Streamline(points=points, speeds=speeds)


def streamlines(ds: xr.Dataset, u_name: str, v_name: str, time_index: int,
                depth_index: int = 0, seeds: int = 26) -> dict:
    """A seeded grid of streamlines on one depth level."""
    z_name = "depth" if "depth" in ds.coords else "ZAX"
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"

    selector = {"time": time_index, z_name: depth_index}
    u = np.asarray(ds[u_name].isel(selector).values, dtype=float)
    v = np.asarray(ds[v_name].isel(selector).values, dtype=float)
    lons = np.asarray(ds[lon_name].values, dtype=float)
    lats = np.asarray(ds[lat_name].values, dtype=float)

    # A regular seed grid rather than random seeds: the picture is then reproducible
    # frame to frame, so scrubbing the timeline shows the flow changing instead of the
    # seeding changing.
    seed_lons = np.linspace(lons[0], lons[-1], seeds)
    seed_lats = np.linspace(lats[0], lats[-1], seeds)

    lines = []
    for slon in seed_lons:
        for slat in seed_lats:
            line = integrate(u, v, lons, lats, float(slon), float(slat))
            if line is not None:
                lines.append(line.as_dict())

    speed = np.hypot(u, v)
    finite = speed[np.isfinite(speed)]

    return {
        "depth_m": float(ds[z_name].values[depth_index]),
        "time": str(ds.time.values[time_index])[:19],
        "count": len(lines),
        "speedRange": [float(finite.min()), float(finite.max())] if finite.size else [0.0, 1.0],
        "units": "m/s",
        "method": "RK2 midpoint, normalised steps of 0.12 deg, max 40 steps",
        "note": ("Streamlines show the instantaneous flow pattern, not particle "
                 "trajectories through time."),
        "streamlines": lines,
    }


def demo() -> None:
    """Self-check on an analytic field, where the right answer is known.

    Solid-body rotation: u = -(y - y0), v = (x - x0). Every streamline is a circle about
    the centre, so a correct integrator returns to near its start and a naive Euler one
    spirals outward. That difference is the reason this uses RK2.
    """
    lons = np.linspace(80.0, 90.0, 61)
    lats = np.linspace(10.0, 20.0, 61)
    lon0, lat0 = 85.0, 15.0

    grid_lon, grid_lat = np.meshgrid(lons, lats)
    u = -(grid_lat - lat0)
    v = (grid_lon - lon0) * np.cos(np.radians(grid_lat))

    line = integrate(u, v, lons, lats, 87.0, 15.0, steps=120, step_degrees=0.1)
    assert line is not None, "rotation field produced no streamline"

    start = np.array(line.points[0])
    radii = [np.hypot(p[0] - lon0, (p[1] - lat0)) for p in line.points]
    drift = abs(radii[-1] - radii[0]) / radii[0]
    assert drift < 0.05, f"streamline spiralled: radius drifted {drift:.1%}"

    # A seed on land (all-NaN field) must produce nothing rather than a line of zeros.
    assert integrate(np.full_like(u, np.nan), v, lons, lats, 85.0, 15.0) is None

    print(f"currents ok: {len(line.points)} points, radius drift {drift:.2%}, "
          f"start {start.round(2).tolist()}")


if __name__ == "__main__":
    demo()
