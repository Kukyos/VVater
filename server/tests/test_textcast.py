"""Delimited-text ingestion agrees with the NetCDF path on the same real deployment.

Needs both copies of the glider fixture: python -m server.tools.fetch_fixtures
"""

from pathlib import Path

import pytest

from server.ocean import textcast

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache"
STEM = "glider_ru29-20180812T0220_bob"


@pytest.mark.skipif(
    not ((CACHE / f"{STEM}.nc").exists() and (CACHE / f"{STEM}.csv").exists()),
    reason="missing glider fixtures; run python -m server.tools.fetch_fixtures",
)
def test_text_path_matches_netcdf_path():
    textcast.demo()
