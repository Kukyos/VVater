"""The tests that catch a silently-wrong comparison chart.

Everything else in the harness measures agreement and speed — self-consistency. These
two do not: they check the result against physics and against a value read by hand out
of the raw file, which is the only thing that catches an inverted depth axis or a
transposed dimension (docs/03-limitations.md V3, V4).

They need the cached Bay of Bengal subset, so they are skipped when it is absent.
Fetch it with:  python -m server.tools.fetch_fixtures
"""

from datetime import date
from pathlib import Path

import numpy as np
import pytest
import xarray as xr

from server.ocean import colocate

FIXTURES = Path(__file__).resolve().parents[2] / "data" / "cache"
GRID_FIXTURE = FIXTURES / "fixture_incois_vam_bob.nc"

pytestmark = pytest.mark.skipif(
    not GRID_FIXTURE.exists(),
    reason=f"missing {GRID_FIXTURE.name}; run python -m server.tools.fetch_fixtures",
)


@pytest.fixture(scope="module")
def grid() -> xr.Dataset:
    return xr.open_dataset(GRID_FIXTURE)


class FakeProfile:
    """A profile at a known place and time, used to probe the grid."""

    def __init__(self, lat, lon, time, depth):
        self.lat, self.lon, self.time = lat, lon, time
        self.depth = np.asarray(depth, dtype=float)
        self.value = np.zeros_like(self.depth)
        self.accepted = np.ones(self.depth.shape, dtype=bool)

    def provenance(self):
        return {"platform": "fixture", "data_mode": "D", "field_used": "n/a",
                "source_file": "n/a", "levels": int(self.depth.size),
                "levels_rejected": 0, "qc_accepted": []}


def test_depth_axis_is_not_inverted(grid):
    """V3 — the one test that is not self-consistency.

    ZAX carries no `positive` attribute, so nothing in the file says whether 5.0 means
    5 m down or 5 m up. Our ingest layer assumes down. Physics is the referee: the Bay
    of Bengal surface is warm and 2000 m is cold, and no plausible bug makes that
    ambiguous. An inverted axis fails here instantly and passes every consistency check
    ever written.

    Expected values come from the measured range of the real subset: 2.57 - 31.85 degC.
    """
    probe = FakeProfile(
        lat=15.0, lon=88.0, time=grid.time.values[len(grid.time) // 2],
        depth=[5.0, 2000.0],
    )
    result = colocate.colocate(probe, grid, "TEMP", "TERR")
    surface, deep = result.modelled

    assert np.isfinite(surface) and np.isfinite(deep), (surface, deep)
    assert 24.0 < surface < 33.0, f"surface {surface} is not a tropical sea surface"
    assert 1.0 < deep < 6.0, f"2000 m {deep} is not deep water"
    assert surface > deep + 15.0, "depth axis is inverted"


def test_colocation_matches_hand_read_neighbour(grid):
    """V4 — catches a transposed dimension.

    Interpolate at the exact centre of a grid cell, then read the same cell straight out
    of the raw array by index. A swapped lat/lon axis changes the second number and not
    the first.
    """
    lat_i, lon_i, z_i, t_i = 7, 9, 4, 3
    lat = float(grid.latitude.values[lat_i])
    lon = float(grid.longitude.values[lon_i])
    depth = float(grid.ZAX.values[z_i])
    time = grid.time.values[t_i]

    by_hand = float(grid.TEMP.values[t_i, z_i, lat_i, lon_i])
    if not np.isfinite(by_hand):
        pytest.skip("chosen fixture cell is masked land; pick another index")

    result = colocate.colocate(FakeProfile(lat, lon, time, [depth]), grid, "TEMP")
    assert np.isclose(result.modelled[0], by_hand, rtol=1e-5), (
        f"interpolated {result.modelled[0]} != hand-read {by_hand}"
    )


def test_provenance_records_every_assumption(grid):
    """A comparison that cannot say what it assumed is not usable evidence."""
    probe = FakeProfile(15.0, 88.0, grid.time.values[0], [5.0, 100.0, 500.0])
    prov = colocate.colocate(probe, grid, "TEMP", "TERR").provenance

    for key in ("method", "analysis_time", "time_offset_days", "grid_offset_deg",
                "pairing_window_days", "cf_assumptions", "units"):
        assert key in prov, f"provenance is missing {key}"

    # The real file has no standard_name and a non-UDUNITS 'degs', and ZAX has no
    # 'positive'. All three are guesses and all three must be on the record.
    joined = " ".join(prov["cf_assumptions"]).lower()
    assert "standard_name" in joined
    assert "positive" in joined
    assert prov["units"] == "°C"


def test_residual_ignores_rejected_levels(grid):
    """QC-failed levels must not reach a statistic (L5)."""
    probe = FakeProfile(15.0, 88.0, grid.time.values[0], [5.0, 100.0, 500.0])
    probe.value = np.array([29.0, 20.0, 9.0])
    probe.accepted = np.array([True, False, True])

    result = colocate.colocate(probe, grid, "TEMP")
    assert np.isnan(result.residual[1]), "a rejected level leaked into the residual"
    assert result.summary()["levels_compared"] <= 2
