"""INCOIS Potential Fishing Zone advisories: the official ones, read as INCOIS publishes them.

INCOIS issues PFZ advisories for fourteen coastal sectors of India from satellite sea-surface
temperature and chlorophyll, as text tables on its Marine Fisheries pages (probed
2026-09-24, docs/05-data-sources.md 2.6):

    https://incois.gov.in/MarineFisheries/TextDataHome?mfid=1&request_locale=en
        -> sectors SEC001 (Gujarat) ... SEC014 (Lakshadweep)
    https://incois.gov.in/MarineFisheries/TextData?secid=SEC012
        -> "SATELLITE DATA SHOWS LIKELY AVAILABILITY OF FISH STOCK TILL 25 SEP 2026"
           and a table: from the coast of | direction | bearing | distance (km) from-to |
           depth (m) from-to | latitude (dms) | longitude (dms)

A sector under cloud has no advisory that day and says so ("No data available for this
sector due to excessive cloud cover"); that is carried as its status, not as an empty
success. There is no API: the page is HTML meant for people, so the parser is strict about
the one table it reads and fails loudly if the table's headings change.

The page needs a session cookie from the home page first. Nothing here is modelled or
interpolated: every point is INCOIS's, with its sector, landing centre and validity.

    python -m server.ocean.pfz           # self-check against a saved page, no network
    python -m server.ocean.pfz --live    # every sector, now
"""

from __future__ import annotations

import html
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

HOME = "https://incois.gov.in/MarineFisheries/TextDataHome?mfid=1&request_locale=en"
SECTOR_URL = "https://incois.gov.in/MarineFisheries/TextData?secid={}"
SECTORS = {
    "SEC001": "Gujarat", "SEC002": "Maharashtra", "SEC003": "Goa", "SEC004": "Karnataka",
    "SEC005": "Kerala", "SEC006": "South Tamil Nadu", "SEC007": "North Tamil Nadu",
    "SEC008": "South Andhra Pradesh", "SEC009": "North Andhra Pradesh", "SEC010": "Odisha",
    "SEC011": "West Bengal", "SEC012": "Andaman", "SEC013": "Nicobar", "SEC014": "Lakshadweep",
}
HEADINGS = ["From the coast of", "Direction", "Bearing (deg)", "Distance (km) From-To",
            "Depth (mtr) From-To", "Latitude (dms)", "Longitude (dms)"]
# Advisories are issued once a day; an hour's cache keeps INCOIS from being asked per click.
CACHE_S = 3600
FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "pfz_SEC012.html"

_cache: dict = {}
_lock = threading.Lock()


def _text(cell: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", cell))).strip()


def dms(value: str) -> float:
    """'23 7 27 N' -> 23.1242. South and west are negative."""
    m = re.fullmatch(r"(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*([NSEW])", value.strip())
    if not m:
        raise ValueError(f"not a D M S position: {value!r}")
    d, mi, s, hemi = m.groups()
    v = int(d) + int(mi) / 60 + float(s) / 3600
    return -v if hemi in "SW" else v


def _range(value: str) -> list[float]:
    parts = [float(p) for p in re.findall(r"\d+(?:\.\d+)?", value)]
    if len(parts) != 2:
        raise ValueError(f"not a from-to range: {value!r}")
    return parts


def parse(page: str, secid: str) -> dict:
    """One sector page -> its advisory. Raises if the table is not the one we know."""
    out = {"sector": secid, "name": SECTORS.get(secid, secid),
           "source": SECTOR_URL.format(secid), "valid_till": None, "points": []}
    if re.search(r"No data available for this sector", page, re.I):
        reason = re.search(r"No data available for this sector[^<]*", page, re.I).group(0)
        return {**out, "status": "none", "note": _text(reason)}
    till = re.search(r"FISH STOCK TILL\s+([0-9]{1,2} [A-Z]{3} [0-9]{4})", page)
    table = re.search(r'<div id="forecastdata".*?<table[^>]*>(.*?)</table>', page, re.S)
    if not table:
        return {**out, "status": "none", "note": "no advisory table on the page"}
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(1), re.S)
    heads = [_text(c) for c in re.findall(r"<th[^>]*>(.*?)</th>", rows[0], re.S)]
    if heads != HEADINGS:
        raise ValueError(f"INCOIS changed the PFZ table: {heads}")
    for row in rows[1:]:
        cells = [_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) != len(HEADINGS):
            continue
        out["points"].append({
            "coast": cells[0].title(), "direction": cells[1], "bearing_deg": float(cells[2]),
            "distance_km": _range(cells[3]), "depth_m": _range(cells[4]),
            "lat": round(dms(cells[5]), 5), "lon": round(dms(cells[6]), 5)})
    return {**out, "status": "ok" if out["points"] else "none",
            "valid_till": till.group(1) if till else None}


def _fetch_all() -> list[dict]:
    session = requests.Session()
    session.get(HOME, timeout=30).raise_for_status()  # the sector pages need its cookie

    def one(secid: str) -> dict:
        try:
            r = session.get(SECTOR_URL.format(secid), timeout=30)
            r.raise_for_status()
            return parse(r.text, secid)
        except (requests.RequestException, ValueError) as exc:
            return {"sector": secid, "name": SECTORS[secid], "status": "error",
                    "note": f"{type(exc).__name__}: {str(exc)[:160]}", "points": [],
                    "source": SECTOR_URL.format(secid), "valid_till": None}

    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, SECTORS))


def advisories() -> dict:
    """Every sector, fetched at most once an hour."""
    with _lock:
        if _cache.get("at", 0) > time.time() - CACHE_S:
            return _cache["value"]
    sectors = _fetch_all()
    value = {"fetched_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
             "sectors": sectors,
             "points": sum(len(s["points"]) for s in sectors),
             "provenance": {"publisher": "INCOIS, Ministry of Earth Sciences",
                            "home": HOME,
                            "method": "INCOIS Potential Fishing Zone advisory, from satellite "
                                      "SST and chlorophyll; read as published, not modelled"}}
    with _lock:
        _cache.update(at=time.time(), value=value)
    return value


def demo() -> None:
    assert abs(dms("23 7 27 N") - 23.124167) < 1e-5
    assert dms("68 14 17 W") < 0
    assert _range("46-51") == [46.0, 51.0]
    cloud = parse("<p>No data available for this sector due to excessive cloud cover</p>", "SEC007")
    assert cloud["status"] == "none" and "cloud" in cloud["note"] and not cloud["points"]
    page = FIXTURE.read_text(encoding="utf-8")
    got = parse(page, "SEC012")
    assert got["status"] == "ok" and got["valid_till"] == "25 SEP 2026", got["valid_till"]
    p = got["points"][0]
    assert p["coast"] == "Narcondam" and p["direction"] == "SW" and p["depth_m"] == [1488, 1493]
    assert all(5 < q["lat"] < 15 and 90 < q["lon"] < 95 for q in got["points"]), "Andaman waters"
    try:
        parse(page.replace("Bearing (deg)", "Bearing"), "SEC012")
    except ValueError:
        pass
    else:
        raise AssertionError("a changed table must fail loudly")
    print(f"pfz ok: {len(got['points'])} points from the saved Andaman page, cloud status kept")


def live() -> None:
    a = advisories()
    for s in a["sectors"]:
        print(f"{s['sector']} {s['name']:<22} {s['status']:<6} {len(s['points']):>3} "
              f"{s.get('valid_till') or s.get('note', '')}")


if __name__ == "__main__":
    live() if "--live" in sys.argv else demo()
