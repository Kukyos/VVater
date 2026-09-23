"""Pack a regridded field into the flat array a voxel renderer consumes.

Cesium's `VoxelPrimitive` walks the ray itself; all it wants from us is a typed array
per metadata channel, plus the bounds the grid occupies. So this module does three
things and stops:

  * resample onto the uniform `sqrt(depth)` grid (`regrid.py`)
  * flatten to Cesium's voxel ordering, x fastest
  * emit the bounds and the provenance alongside

Two channels are emitted where the source has them: the **value** and its **uncertainty**
(`TERR`/`SERR`). The shader modulates per-step alpha by the second, so low-confidence
water renders faint. The problem statement does not ask for this; the data offers it and
throwing it away would be the wasteful choice (docs/03-limitations.md L10).
"""

from dataclasses import dataclass

import warnings

import numpy as np
import xarray as xr

from . import cf, config, regrid


@dataclass
class Volume:
    """One timestep of one variable, ready to hand to a voxel provider."""

    values: np.ndarray            # float32, flat, x fastest then y then z
    errors: np.ndarray | None     # same shape, or None when the source has no error field
    dimensions: tuple[int, int, int]   # (lon, lat, depth)
    lon_range: tuple[float, float]
    lat_range: tuple[float, float]
    depth_range: tuple[float, float]
    value_range: tuple[float, float]   # finite min/max, for the default colourbar
    provenance: dict

    def as_dict(self) -> dict:
        """Metadata only. The arrays go over the wire as binary, not JSON."""
        return {
            "dimensions": list(self.dimensions),
            "lonRange": list(self.lon_range),
            "latRange": list(self.lat_range),
            "depthRange": list(self.depth_range),
            "valueRange": list(self.value_range),
            "hasError": self.errors is not None,
            "provenance": self.provenance,
        }


def _flatten(array: np.ndarray) -> np.ndarray:
    """Flatten (depth, lat, lon) to Cesium's voxel order: x fastest, then y, then z.

    **The depth axis is reversed here, and it has to be.** A voxel grid runs from
    `minBounds` to `maxBounds`, so voxel z = 0 sits at the *lowest height* — the deepest
    water. Our arrays are ordered shallow-to-deep. Handing them over unreversed renders
    the ocean upside down: warm water at the sea floor, cold at the surface. It looks
    like a plausible volume, which is exactly why this is asserted rather than trusted.

    No transpose is needed beyond that — a C-ordered (z, y, x) array already ravels to
    `x + nx * (y + ny * z)`, which is what Cesium wants.
    """
    return np.ascontiguousarray(array[::-1].ravel(), dtype=np.float32)


# Horizontal cells per axis the viewer is sent. GLORYS12 is 1/12 deg -- 265 x 217 x 36,
# two million voxels in one tile -- and it froze the browser tab outright. Nothing here
# upsamples: INCOIS (23 x 19) passes through untouched, and depth is never touched at all
# (hard rule 3 is about depth levels). The factor used is written into the provenance.
MAX_HORIZONTAL = 96


def _block_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean over k x k blocks of the last two axes, trimming the ragged edge. NaN (land)
    is skipped, so a coastal block takes the mean of its water cells, and an all-land
    block stays NaN."""
    ny, nx = a.shape[-2] // k * k, a.shape[-1] // k * k
    a = a[..., :ny, :nx]
    blocks = a.reshape(*a.shape[:-2], ny // k, k, nx // k, k)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN block -> NaN, wanted
        return np.nanmean(blocks, axis=(-3, -1))


def build(ds: xr.Dataset, value_name: str, time_index: int,
          error_name: str | None = None,
          source_key: str = config.DEFAULT_SOURCE,
          canonical: str = "temperature") -> Volume:
    """Build one volume from an already-fetched dataset.

    `canonical` is our own name for the variable ("temperature", "salinity", ...) as
    opposed to `value_name`, which is whatever the source calls it. It was hardcoded to
    "temperature" here, which meant salinity was labelled sea_water_temperature in the
    units shown on screen AND checked against the temperature global range limits.
    """
    source = config.SOURCES[source_key]

    z_name = "ZAX" if "ZAX" in ds.coords else "depth"
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"

    positive_down, depth_note = cf.depth_sign_assumption(ds[z_name])
    if not positive_down:
        raise NotImplementedError(f"{z_name} is positive-up; see docs/03-limitations.md L2")

    native = np.asarray(ds[z_name].values, dtype=float)
    grid = regrid.build_grid(native, source.native_levels)

    field = ds[value_name].isel(time=time_index)
    report = cf.normalise_variable(field, canonical)

    # Physically impossible cells are masked out of the render and counted, never
    # silently clipped (docs/13-eval-results.md).
    raw = np.asarray(field.values, dtype=float)
    bad, range_report = cf.global_range_check(raw, report.standard_name)
    raw = np.where(bad, np.nan, raw)

    lons = np.asarray(ds[lon_name].values, dtype=float)
    lats = np.asarray(ds[lat_name].values, dtype=float)
    raw_errors = (np.asarray(ds[error_name].isel(time=time_index).values, dtype=float)
                  if error_name and error_name in ds else None)

    # Range-tested at native resolution first, so an impossible cell is counted and
    # masked before a block mean could dilute it into something plausible.
    k = max(1, -(-max(lons.size, lats.size) // MAX_HORIZONTAL))
    if k > 1:
        raw = _block_mean(raw, k)
        raw_errors = _block_mean(raw_errors, k) if raw_errors is not None else None
        lons = lons[:lons.size // k * k].reshape(-1, k).mean(axis=1)
        lats = lats[:lats.size // k * k].reshape(-1, k).mean(axis=1)

    values = regrid.resample(raw, native, grid, depth_axis=0)

    errors = None
    if raw_errors is not None:
        errors = regrid.resample(raw_errors, native, grid, depth_axis=0)

    finite = values[np.isfinite(values)]

    assumptions = list(report.assumptions)
    if depth_note:
        assumptions.append(depth_note)

    provenance = {
        "source": source.title,
        "variable": value_name,
        "standard_name": report.standard_name,
        "units": report.display_units,
        "time": str(ds.time.values[time_index])[:19],
        "depth_grid": grid.provenance(),
        "range_test": range_report,
        "masked_cells": int(bad.sum()),
        "cf_assumptions": assumptions,
        "horizontal_block": k,
    }

    return Volume(
        values=_flatten(values),
        errors=_flatten(errors) if errors is not None else None,
        dimensions=(lons.size, lats.size, grid.n),
        lon_range=(float(lons.min()), float(lons.max())),
        lat_range=(float(lats.min()), float(lats.max())),
        depth_range=(grid.z_min, grid.z_max),
        value_range=(float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0),
        provenance=provenance,
    )


def demo() -> None:
    """Self-check: the flatten order, which is the one thing here that can be silently wrong."""
    # A field whose value encodes its own (lon, lat, depth) index, so a transpose shows up.
    nz, ny, nx = 3, 4, 5
    marked = np.zeros((nz, ny, nx))
    for z in range(nz):
        for y in range(ny):
            for x in range(nx):
                marked[z, y, x] = x * 100 + y * 10 + z

    flat = _flatten(marked)
    assert flat.size == nx * ny * nz

    # x fastest, then y, then z -- and z reversed, because voxel z=0 is the deepest water.
    for z in range(nz):
        for y in range(ny):
            for x in range(nx):
                got = flat[x + nx * (y + ny * z)]
                want = x * 100 + y * 10 + (nz - 1 - z)
                assert got == want, f"at ({x},{y},{z}) got {got} want {want}"

    # The physics statement of the same thing: a warm surface must end up at the TOP of
    # the voxel grid, which is the last z slice, not the first.
    column = np.linspace(30.0, 3.0, nz)[:, None, None] * np.ones((nz, ny, nx))
    packed = _flatten(column).reshape(nz, ny, nx)
    assert packed[0].mean() < packed[-1].mean(), "warm surface did not land at the top"

    # Block mean: land (NaN) is skipped, an all-land block stays NaN, edges are trimmed.
    a = np.array([[[1.0, 3.0, np.nan, np.nan, 9.0],
                   [5.0, 7.0, np.nan, np.nan, 9.0]]])
    b = _block_mean(a, 2)
    assert b.shape == (1, 1, 2), b.shape
    assert b[0, 0, 0] == 4.0 and np.isnan(b[0, 0, 1]), b

    print(f"volume ok: x-fastest and depth-reversed, verified on {nx}x{ny}x{nz}")


if __name__ == "__main__":
    demo()

