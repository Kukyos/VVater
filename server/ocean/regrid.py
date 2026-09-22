"""Put a non-uniform depth axis onto the uniform grid a voxel renderer needs.

Cesium voxel grids are uniform along each axis. Ocean depth levels are not: the INCOIS
analyses use 5, 10, 20, 30, 50, 75, 100 ... 2000 m, dense where the structure is.

So we resample into bins that are uniform in `sqrt(depth)`, which is dense near the
surface and coarse at depth — roughly where the native levels already are. The stretch
exists to make the grid *renderable*, never to make it *finer*:

    the number of output levels never exceeds the source's native level count (L2/V1).

Upsampling 24 native levels into 64 bins would invent thermocline structure that is not
in the data, in the one place an oceanographer looks hardest. The assertion below is the
whole point of this module.
"""

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class DepthGrid:
    """A uniform-in-stretched-space depth axis, plus the way back to metres."""

    depths: np.ndarray       # the actual depth of each bin centre, metres
    z_min: float
    z_max: float

    @property
    def n(self) -> int:
        return int(self.depths.size)

    def label_for_index(self, index: float) -> float:
        """Metres for a fractional voxel index. The viewer must use this for every
        depth it prints — a raw voxel index is never shown as a depth."""
        s0, s1 = np.sqrt(self.z_min), np.sqrt(self.z_max)
        frac = index / max(self.n - 1, 1)
        return float(np.clip((s0 + frac * (s1 - s0)) ** 2, self.z_min, self.z_max))

    def provenance(self) -> dict:
        return {
            "stretch": "uniform in sqrt(depth)",
            "levels": self.n,
            "z_min_m": self.z_min,
            "z_max_m": self.z_max,
            "depths_m": [round(float(d), 2) for d in self.depths],
        }


def build_grid(native_depths: np.ndarray, native_levels: int,
               levels: int | None = None) -> DepthGrid:
    """Uniform-in-sqrt(depth) bins spanning the native range.

    `levels` defaults to — and is capped at — the source's native level count.
    """
    native = np.asarray(native_depths, dtype=float)
    z_min, z_max = float(native.min()), float(native.max())

    requested = native_levels if levels is None else int(levels)
    if requested > native_levels:
        raise ValueError(
            f"regrid to {requested} levels from a source with {native_levels} native "
            "levels would invent structure that is not in the data (docs/03-limitations.md L2)"
        )

    s = np.linspace(np.sqrt(z_min), np.sqrt(z_max), requested)
    # Clip: squaring a square root walks off the end by an ulp, and np.interp's
    # right=nan then blanks the deepest level of every column.
    depths = np.clip(s**2, z_min, z_max)
    return DepthGrid(depths=depths, z_min=z_min, z_max=z_max)


def resample(values: np.ndarray, native_depths: np.ndarray, grid: DepthGrid,
             depth_axis: int = 0) -> np.ndarray:
    """Linearly interpolate `values` from `native_depths` onto `grid.depths`.

    NaN is the ocean's land mask and must stay NaN rather than being interpolated
    across, so masked columns are handled explicitly.
    """
    native = np.asarray(native_depths, dtype=float)
    if native.size != values.shape[depth_axis]:
        raise ValueError(
            f"depth axis has {values.shape[depth_axis]} levels but {native.size} depths given"
        )

    moved = np.moveaxis(np.asarray(values, dtype=float), depth_axis, 0)
    flat = moved.reshape(moved.shape[0], -1)
    out = np.full((grid.n, flat.shape[1]), np.nan)

    for col in range(flat.shape[1]):
        column = flat[:, col]
        good = np.isfinite(column)
        if good.sum() < 2:
            continue
        # Outside the measured span stays NaN: extrapolating below the deepest good
        # level is exactly how a renderer ends up showing water that was never sampled.
        out[:, col] = np.interp(
            grid.depths, native[good], column[good], left=np.nan, right=np.nan
        )

    return np.moveaxis(out.reshape((grid.n,) + moved.shape[1:]), 0, depth_axis)


def demo() -> None:
    """Self-check: the invariant this module exists to hold."""
    native = np.array([5.0, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000, 2000])

    grid = build_grid(native, native_levels=native.size)
    assert grid.n == native.size, grid.n
    # Uniform in sqrt space means surface-dense in metres.
    assert grid.depths[1] - grid.depths[0] < grid.depths[-1] - grid.depths[-2]

    # The assertion that stops the volume lying.
    try:
        build_grid(native, native_levels=native.size, levels=64)
    except ValueError as exc:
        assert "invent structure" in str(exc)
    else:
        raise AssertionError("upsampling past the native level count must be refused")

    # Round-trip: a linear-in-depth field resamples to itself.
    values = native * 2.0
    back = resample(values, native, grid)
    assert np.allclose(back, grid.depths * 2.0, equal_nan=True), back

    # A land column (all NaN) stays NaN rather than being filled.
    masked = np.full_like(native, np.nan)
    assert np.isnan(resample(masked, native, grid)).all()

    # label_for_index must agree with the grid it describes.
    assert abs(grid.label_for_index(0) - grid.z_min) < 1e-6
    assert abs(grid.label_for_index(grid.n - 1) - grid.z_max) < 1e-6

    print(f"regrid ok: {grid.n} levels, {grid.depths[0]:.1f}-{grid.depths[-1]:.1f} m")


if __name__ == "__main__":
    demo()
