"""Pull the small real files the tests run against.

Deliberately real data, not synthetic: the bugs these tests exist to catch — an
inverted depth axis, a transposed dimension, a non-UDUNITS unit string — are bugs about
what real files actually contain, and a fixture we wrote ourselves would encode our own
assumptions and then agree with them.

    python -m server.tools.fetch_fixtures
"""

from datetime import date
from pathlib import Path

import requests

from server.ocean import argo, config, sources

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache"

# A ten-week window ending at the last analysis step available when this was written.
WINDOW = ("2026-05-01", "2026-07-30")
# A day with known Bay of Bengal float coverage.
ARGO_DAY = date(2026, 7, 15)


def main() -> None:
    CACHE.mkdir(parents=True, exist_ok=True)

    target = CACHE / "fixture_incois_vam_bob.nc"
    if target.exists():
        print(f"have  {target.name}")
    else:
        source = config.SOURCES["incois_vam"]
        url = sources._erddap_url(source, ["TEMP", "SAL", "TERR"], *WINDOW)
        resp = requests.get(url, timeout=config.HTTP_TIMEOUT)
        if resp.status_code != 200:
            raise SystemExit(f"ERDDAP {resp.status_code}: {resp.text[:400]}")
        target.write_bytes(resp.content)
        print(f"wrote {target.name}  {len(resp.content) / 1e6:.2f} MB")

    path = argo.fetch_day(ARGO_DAY, CACHE)
    if path is None:
        raise SystemExit(f"no Argo day-file for {ARGO_DAY}")
    print(f"have  {path.name}  {path.stat().st_size / 1e6:.2f} MB")

    profiles = argo.read_profiles(path, "temperature")
    print(f"      {len(profiles)} profiles inside {config.REGION['name']}")
    for p in profiles:
        print(f"        {p.platform}  {p.lat:6.2f},{p.lon:7.2f}  mode={p.data_mode}  "
              f"{p.depth.size} levels, {p.n_rejected} rejected, {p.field_used}")


if __name__ == "__main__":
    main()
