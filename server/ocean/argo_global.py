"""Argo anywhere: every float cast in a box and a few days, from Ifremer's ERDDAP.

The GDAC day-files in `argo.py` are one file per basin per day, which suits the Bay. A cube
can be anywhere, so this asks Ifremer's ERDDAP by box and time (docs/05-data-sources.md
2.4), core floats from `ArgoFloats` and biogeochemical floats from
`ArgoFloats-synthetic-BGC`. Responses are cached on disk.

It returns the same `argo.Profile` the rest of the system already handles, with the same
refusals (L5, hard rule 2):

  * adjusted values first, raw only where the adjusted field is empty;
  * every level kept with its QC flag; failing levels are marked rejected, never dropped;
  * the data mode travels with the cast (core floats report it; the synthetic BGC files do
    not carry PARAMETER_DATA_MODE through ERDDAP, so it is inferred from whether adjusted
    values exist, and the inference is recorded);
  * the source file is the cast's own GDAC file name, derived from platform, cycle,
    direction and data mode, and the ERDDAP dataset it was read through.

**Temperature is converted to potential temperature** (`gsw.pt0_from_t`, with the float's
own salinity where it has one) before it is drawn against the model, which reports
potential temperature. `cf.py` keeps the two quantities apart for exactly this reason; the
conversion and the salinity it used are in each cast's notes. **Oxygen** arrives in
umol/kg and the model's is mmol/m3; it is converted with the in-situ density from the
float's own temperature and salinity, and recorded the same way.

    python -m server.ocean.argo_global            # self-check, no network
    python -m server.ocean.argo_global --live     # one real query
"""

from __future__ import annotations

import csv
import hashlib
import io
import sys
import time
import urllib.parse
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from . import config
from .argo import Profile

ERDDAP = "https://erddap.ifremer.fr/erddap/tabledap"
CACHE = Path(__file__).resolve().parents[2] / "data" / "cache" / "argo_erddap"

# Responses about days more than this far back are treated as final and kept; nearer ones
# are re-asked after RECENT_TTL_S, because real-time casts are still being adjusted.
SETTLED_DAYS = 60
RECENT_TTL_S = 6 * 3600

# The most casts one cube is shown. A 100 x 80 deg box over ten days can hold a thousand;
# past this they are thinned evenly and the response says how many were left out.
MAX_CASTS = 400


@dataclass(frozen=True)
class Field:
    dataset: str           # ERDDAP dataset id
    raw: str
    adjusted: str
    units: str


# Our canonical names -> where the floats keep them.
FIELDS = {
    "temperature": Field("ArgoFloats", "temp", "temp_adjusted", "degC (in situ)"),
    "salinity": Field("ArgoFloats", "psal", "psal_adjusted", "PSU"),
    "chlorophyll": Field("ArgoFloats-synthetic-BGC", "chla", "chla_adjusted", "mg/m3"),
    "oxygen": Field("ArgoFloats-synthetic-BGC", "doxy", "doxy_adjusted", "umol/kg"),
}


def available(variable: str) -> bool:
    return variable in FIELDS


# ------------------------------------------------------------------ query

def _query_url(field: Field, lon0: float, lon1: float, lat0: float, lat1: float,
               t0: str, t1: str, depth_max: float) -> str:
    core = field.dataset == "ArgoFloats"
    columns = ["platform_number", "cycle_number", "direction", "time", "latitude", "longitude",
               "pres", "pres_adjusted", field.raw, f"{field.raw}_qc", field.adjusted,
               f"{field.adjusted}_qc"]
    # Temperature needs salinity (for potential temperature); oxygen needs both (density).
    if field.raw in ("temp", "doxy"):
        columns += ["psal", "psal_adjusted"]
    if field.raw == "doxy":
        columns += ["temp", "temp_adjusted"]
    if core:
        columns += ["data_mode", "data_center"]
    else:
        columns += ["data_centre"]
    # Pressure in dbar is close to depth in m; a little margin keeps the deepest level.
    constraints = [f"time>={t0}T00:00:00Z", f"time<={t1}T23:59:59Z",
                   f"latitude>={lat0}", f"latitude<={lat1}",
                   f"longitude>={lon0}", f"longitude<={lon1}",
                   f"pres<={depth_max * 1.03 + 10:.0f}"]
    query = ",".join(dict.fromkeys(columns)) + "&" + "&".join(
        urllib.parse.quote(c, safe="=<>") for c in constraints)
    return f"{ERDDAP}/{field.dataset}.csv?{query}"


def _fetch(url: str, settled: bool) -> str:
    """One ERDDAP response, from the disk cache when it is still good."""
    import requests

    path = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".csv")
    if path.exists() and (settled or time.time() - path.stat().st_mtime < RECENT_TTL_S):
        return path.read_text(encoding="utf-8")
    response = requests.get(url, timeout=config.HTTP_TIMEOUT)
    # ERDDAP answers "no rows" with a 404 whose body says so; that is an empty result.
    if response.status_code == 404 and "nRows = 0" in response.text:
        text = ""
    elif response.status_code != 200:
        raise RuntimeError(f"Argo ERDDAP {response.status_code}: {response.text[:300]}")
    else:
        text = response.text
    CACHE.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    partial.write_text(text, encoding="utf-8")
    partial.replace(path)
    return text


# ------------------------------------------------------------------ parsing

def _float(v: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def _column(rows: list[dict], name: str) -> np.ndarray:
    return np.array([_float(r.get(name, "")) for r in rows], dtype=float)


def _qc(rows: list[dict], name: str) -> np.ndarray:
    out = np.full(len(rows), " ", dtype="<U1")
    for i, r in enumerate(rows):
        v = (r.get(name) or "").strip()
        if v and v.lower() != "nan":
            out[i] = v[0]
    return out


def source_file(platform: str, cycle: int, direction: str, mode: str, bgc: bool,
                centre: str) -> str:
    """The cast's own GDAC file name (Argo user manual naming), and how it was read."""
    prefix = ("S" if bgc else "") + ("D" if mode == "D" else "R")
    suffix = "D" if direction == "D" else ""
    dac = f"{centre}/" if centre else ""
    dataset = "ArgoFloats-synthetic-BGC" if bgc else "ArgoFloats"
    return f"{dac}{platform}/profiles/{prefix}{platform}_{cycle:03d}{suffix}.nc (via Ifremer ERDDAP {dataset})"


def parse(text: str, variable: str) -> list[Profile]:
    """Rows (one per level) to one Profile per cast."""
    import gsw

    field = FIELDS[variable]
    if not text.strip():
        return []
    reader = csv.DictReader(io.StringIO(text))
    rows = [r for r in reader]
    rows = rows[1:] if rows and rows[0].get("time") == "UTC" else rows  # the units row
    bgc = field.dataset != "ArgoFloats"
    casts: dict[tuple, list[dict]] = {}
    for r in rows:
        casts.setdefault((r["platform_number"].strip(), r["cycle_number"].strip(),
                          r.get("direction", "").strip()), []).append(r)

    out: list[Profile] = []
    for (platform, cycle, direction), levels in casts.items():
        adjusted = _column(levels, field.adjusted)
        use_adjusted = np.isfinite(adjusted).any()
        values = adjusted if use_adjusted else _column(levels, field.raw)
        qc = _qc(levels, f"{field.adjusted}_qc" if use_adjusted else f"{field.raw}_qc")
        pres = _column(levels, "pres_adjusted")
        if not np.isfinite(pres).any():
            pres = _column(levels, "pres")
        real = np.isfinite(values) & np.isfinite(pres)
        if not real.any():
            continue
        lat = _float(levels[0]["latitude"])
        lon = _float(levels[0]["longitude"])
        notes: list[str] = []
        if bgc:
            mode = "A" if use_adjusted else "R"
            notes.append("data mode inferred from whether adjusted values exist: the synthetic "
                         "BGC dataset on ERDDAP does not carry PARAMETER_DATA_MODE")
        else:
            mode = (levels[0].get("data_mode") or "?").strip() or "?"

        order = np.argsort(pres[real])
        p = pres[real][order]
        v = values[real][order]
        q = qc[real][order]
        depth = -gsw.z_from_p(p, lat)

        salinity = _column(levels, "psal_adjusted")
        if not np.isfinite(salinity).any():
            salinity = _column(levels, "psal")
        salinity = salinity[real][order] if salinity.size else salinity
        if variable in ("temperature", "oxygen"):
            has_s = np.isfinite(salinity)
            sp = np.where(has_s, salinity, 35.0)
            sa = gsw.SA_from_SP(sp, p, lon, lat)
            if variable == "temperature":
                v = gsw.pt0_from_t(sa, v, p)
                notes.append("in-situ temperature converted to potential temperature "
                             "(gsw.pt0_from_t) to compare with the model's potential temperature; "
                             + ("salinity from the float" if has_s.all() else
                                f"{int((~has_s).sum())} levels without salinity used 35 PSU"))
            else:
                t = _column(levels, "temp_adjusted")
                if not np.isfinite(t).any():
                    t = _column(levels, "temp")
                t = t[real][order]
                rho = gsw.rho(sa, gsw.CT_from_t(sa, t, p), p)
                v = v * rho / 1000.0
                notes.append("oxygen converted from umol/kg to mmol/m3 with the in-situ density "
                             "from the float's own temperature and salinity (TEOS-10)")
        centre = (levels[0].get("data_center") or levels[0].get("data_centre") or "").strip()
        profile = Profile(
            platform=platform,
            lat=lat, lon=lon,
            time=np.datetime64(levels[0]["time"].replace("Z", "")),
            depth=depth,
            value=np.asarray(v, dtype=float),
            qc=q,
            accepted=np.isin(q, list(config.QC_ACCEPT)),
            data_mode=mode,
            field_used=field.adjusted if use_adjusted else field.raw,
            source_file=source_file(platform, int(float(cycle)), direction, mode, bgc, centre),
        )
        profile.cycle = int(float(cycle))  # type: ignore[attr-defined]
        profile.notes = notes  # type: ignore[attr-defined]
        out.append(profile)
    return out


def load_box(variable: str, lon0: float, lon1: float, lat0: float, lat1: float,
             day: str, window_days: int, depth_max: float) -> tuple[list[Profile], dict]:
    """Every cast of `variable` within the box and `window_days` of `day`."""
    field = FIELDS[variable]
    centre = date.fromisoformat(day)
    t0 = (centre - timedelta(days=window_days)).isoformat()
    t1 = (centre + timedelta(days=window_days)).isoformat()
    settled = (date.today() - centre).days > SETTLED_DAYS
    # Across the antimeridian the box is two queries in the store's -180..180 longitudes.
    spans = ([(lon0, lon1, 0.0)] if lon1 <= 180
             else [(lon0, 180.0, 0.0), (-180.0, lon1 - 360.0, 360.0)])
    profiles: list[Profile] = []
    urls = []
    for lo, hi, shift in spans:
        url = _query_url(field, lo, hi, lat0, lat1, t0, t1, depth_max)
        urls.append(url)
        for p in parse(_fetch(url, settled), variable):
            p.lon += shift
            profiles.append(p)
    found = len(profiles)
    if found > MAX_CASTS:
        keep = np.linspace(0, found - 1, MAX_CASTS).round().astype(int)
        profiles = [profiles[i] for i in keep]
    return profiles, {
        "dataset": field.dataset, "window_days": window_days, "from": t0, "to": t1,
        "found": found, "shown": len(profiles),
        "thinned": found > MAX_CASTS,
        "units_as_drawn": {"temperature": "degC (potential)", "oxygen": "mmol/m3"}.get(
            variable, field.units),
        "queries": urls,
    }


# ------------------------------------------------------------------ self-checks

SAMPLE = """platform_number,cycle_number,direction,time,latitude,longitude,pres,pres_adjusted,temp,temp_qc,temp_adjusted,temp_adjusted_qc,psal,psal_adjusted,data_mode,data_center
,,,UTC,degrees_north,degrees_east,decibar,decibar,degree_Celsius,,degree_Celsius,,PSU,PSU,,
6901234,12,A,2019-08-15T03:00:00Z,32.1,-45.2,5.0,5.1,27.1,1,27.0,1,36.5,36.6,D,IF
6901234,12,A,2019-08-15T03:00:00Z,32.1,-45.2,1000.0,1000.2,6.1,1,6.0,4,35.1,35.1,D,IF
6901234,12,A,2019-08-15T03:00:00Z,32.1,-45.2,500.0,500.1,12.1,1,12.0,1,35.6,35.6,D,IF
7900001,3,A,2019-08-16T03:00:00Z,33.0,-40.0,10.0,,26.0,1,,,36.0,,R,AO
"""


def demo() -> None:
    casts = parse(SAMPLE, "temperature")
    assert len(casts) == 2, casts
    a = next(c for c in casts if c.platform == "6901234")
    assert np.all(np.diff(a.depth) > 0), "levels sorted shallow to deep"
    assert a.field_used == "temp_adjusted" and a.data_mode == "D"
    assert a.qc.tolist() == ["1", "1", "4"] and a.accepted.tolist() == [True, True, False], \
        "the level flagged 4 is kept and marked rejected, not dropped"
    assert a.value[0] < 27.0 + 1e-9 and abs(a.value[0] - 27.0) < 0.01, \
        "potential temperature at 5 dbar is almost the in-situ value"
    assert a.value[2] < 6.0, "at 1000 dbar potential temperature is below in-situ"
    assert "R6901234_012.nc" not in a.source_file and "D6901234_012.nc" in a.source_file
    b = next(c for c in casts if c.platform == "7900001")
    assert b.field_used == "temp" and b.data_mode == "R", "raw used where no adjusted value"
    assert "IF/6901234/profiles/" in a.source_file
    assert source_file("5900001", 7, "D", "R", True, "AO").endswith(
        "SR5900001_007D.nc (via Ifremer ERDDAP ArgoFloats-synthetic-BGC)")
    assert parse("", "temperature") == []
    print("argo_global ok: adjusted first, QC kept, potential temperature, GDAC file names")


def live() -> None:
    import truststore
    truststore.inject_into_ssl()
    t = time.time()
    casts, info = load_box("temperature", -50, -35, 25, 35, "2019-08-15", 2, 2000)
    print(f"{info['found']} casts in {time.time() - t:.1f} s")
    for c in casts[:3]:
        print(" ", c.platform, c.data_mode, c.depth.size, "levels,", c.n_rejected, "rejected,",
              c.source_file)
    assert casts, "no floats in the North Atlantic subtropical gyre over five days is not credible"


if __name__ == "__main__":
    live() if "--live" in sys.argv else demo()
