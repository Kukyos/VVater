"""Delimited-text ingestion: casts from CSV, TSV, semicolon or whitespace tables.

The brief asks for "automated parsers for NetCDF ... and delimited text formats". This is
the text half. It emits the same `argo.Profile` every other instrument emits, so a cast
read from a text file is co-located, charted and residual-binned by exactly the code that
handles Argo and gliders — nothing downstream knows where it came from.

What it accepts, because text files from instruments agree on almost nothing:

  * Delimiter sniffed (comma, tab, semicolon, pipe), falling back to whitespace.
  * `#` comment lines skipped.
  * Headers matched by name, case-insensitive, with units in brackets stripped:
    "Temperature (degC)" and "TEMP" and "sea_water_temperature" are all temperature.
  * An ERDDAP-style units row directly under the header, detected and recorded.
  * Depth in metres, or pressure in dbar converted with TEOS-10 the way argo.py does it.
  * One cast per station/profile id column; without one, per (time, lat, lon).

What it refuses to guess, per hard rules 2 and 5:

  * **QC.** A text file has no agreed flag vocabulary, so every cast is data_mode 'U'
    (unevaluated): shown, never presented as passing. Flag characters are carried through
    for display when a matching column exists, but not interpreted.
  * **Units.** Temperature is assumed degC and salinity PSS-78, and both assumptions are
    returned in `notes` and travel with the data, rather than being silently applied.

The check is `demo()`: the same IOOS glider deployment, downloaded once as NetCDF and once
as CSV, must produce identical casts through glider.py and through this module.
"""

import csv
import re
from pathlib import Path

import gsw
import numpy as np

from .argo import Profile

# Canonical column -> accepted header names (after normalisation).
ALIASES = {
    "lat": {"lat", "latitude"},
    "lon": {"lon", "long", "longitude"},
    "time": {"time", "date", "datetime", "date_time", "juld"},
    "depth": {"depth", "depth_m", "z"},
    "pres": {"pres", "pressure", "prs", "dbar"},
    "station": {"station", "station_id", "cast", "cast_id", "profile", "profile_id",
                "platform", "platform_number", "id"},
    "temperature": {"temperature", "temp", "t", "sea_water_temperature", "t90", "its90"},
    "salinity": {"salinity", "sal", "psal", "sea_water_salinity",
                 "sea_water_practical_salinity", "practical_salinity"},
}

QC_SUFFIXES = ("_qc", "_flag", "_primary_flag")

UNIT_NOTES = {
    "temperature": "temperature read as degC (text carries no reliable unit)",
    "salinity": "salinity read as practical salinity, PSS-78",
}


class TextCastError(ValueError):
    """The file is not a cast table we can read. The message says why."""


def _norm(header: str) -> str:
    header = re.sub(r"[\(\[].*?[\)\]]", "", header)  # drop "(degC)", "[m]"
    return re.sub(r"[^a-z0-9]+", "_", header.strip().lower()).strip("_")


def _rows(text: str) -> list[list[str]]:
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    if len(lines) < 2:
        raise TextCastError("fewer than two non-comment lines; need a header and data")
    sample = "\n".join(lines[:20])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        return [row for row in csv.reader(lines, dialect)]
    except csv.Error:
        return [ln.split() for ln in lines]


def _float(cell: str) -> float:
    try:
        return float(cell)
    except (TypeError, ValueError):
        return float("nan")


def _time(cell: str) -> np.datetime64:
    try:
        return np.datetime64(cell.strip().rstrip("Z").replace(" ", "T"), "s")
    except ValueError:
        return np.datetime64("NaT")


def read_text(text: str, variable: str = "temperature",
              source_name: str = "upload.csv") -> tuple[list[Profile], list[str]]:
    """Parse a cast table. Returns (profiles, notes) — notes are the assumptions made."""
    rows = _rows(text)
    header = [_norm(h) for h in rows[0]]
    col: dict[str, int] = {}
    for key, names in ALIASES.items():
        for i, h in enumerate(header):
            if h in names:
                col.setdefault(key, i)

    missing = [k for k in ("lat", "lon", "time", variable) if k not in col]
    if "depth" not in col and "pres" not in col:
        missing.append("depth or pressure")
    if missing:
        raise TextCastError(
            f"no column for {', '.join(missing)}; headers were {rows[0]}. "
            f"Accepted names: {', '.join(sorted(ALIASES['lat'] | ALIASES['lon']))}, ...")

    notes = [UNIT_NOTES[variable]]
    body = rows[1:]
    # ERDDAP writes units on the row under the header. A row whose latitude is not a
    # number is that row, not data.
    if body and not np.isfinite(_float(body[0][col["lat"]])):
        units = dict(zip(rows[0], body[0]))
        notes.append(f"units row found and skipped: {units}")
        body = body[1:]

    width = len(header)
    body = [r for r in body if len(r) >= width]
    if not body:
        raise TextCastError("no data rows with a value in every column")

    def column(key: str) -> np.ndarray:
        return np.array([_float(r[col[key]]) for r in body])

    lat, lon, value = column("lat"), column("lon"), column(variable)
    if np.any(np.abs(lat[np.isfinite(lat)]) > 90) or np.any(np.abs(lon[np.isfinite(lon)]) > 360):
        raise TextCastError("latitude or longitude out of range; columns may be swapped")
    times = np.array([_time(r[col["time"]]) for r in body])

    if "depth" in col:
        depth = column("depth")
    else:
        depth = -gsw.z_from_p(column("pres"), np.where(np.isfinite(lat), lat, 0.0))
        notes.append("depth from pressure via TEOS-10 gsw.z_from_p, as for Argo")

    # A flag column names its variable and ends like one: TEMP_QC,
    # qartod_temperature_primary_flag.
    qc_index = next((i for i, h in enumerate(header)
                     if header[col[variable]] in h and h.endswith(QC_SUFFIXES)), None)
    qc_raw = [r[qc_index] for r in body] if qc_index is not None else None

    if "station" in col:
        keys = np.array([r[col["station"]].strip() for r in body])
    else:
        # A CTD export has no station column and a time on every scan, so grouping on
        # time would make every row its own cast. A new cast starts where the position
        # changes instead.
        moved = np.r_[True, (np.abs(np.diff(lat)) > 1e-4) | (np.abs(np.diff(lon)) > 1e-4)]
        keys = np.cumsum(moved).astype(str)
        notes.append("no station column; a new cast starts wherever the position changes")

    # One pass, not one scan per cast: an upload is handled inside the server's event
    # loop, and a quadratic loop over a large file would stall every other request.
    uniq, first, inverse = np.unique(keys, return_index=True, return_inverse=True)
    finite = np.isfinite(depth) & np.isfinite(value)

    stem = Path(source_name).stem
    out: list[Profile] = []
    for k in np.argsort(first):  # file order, not sorted order
        key = uniq[k]
        good = (inverse == k) & finite
        if good.sum() < 2:
            continue
        order = np.argsort(depth[good])
        if qc_raw is not None:
            flags = [qc_raw[i] for i in np.flatnonzero(good)]
            qc = np.array([(str(int(float(f))) if np.isfinite(_float(f)) else " ")
                           for f in flags], dtype="<U1")[order]
        else:
            qc = np.full(int(good.sum()), " ", dtype="<U1")
        label = str(int(float(key))) if np.isfinite(_float(key)) else key
        out.append(Profile(
            platform=f"{stem}#{label}",
            lat=float(np.nanmean(lat[good])),
            lon=float(np.nanmean(lon[good])),
            time=times[good][0],
            depth=depth[good][order],
            value=value[good][order],
            qc=qc,
            # Unevaluated, never passing: shown in full and labelled 'U' (hard rule 2).
            accepted=np.ones(int(good.sum()), dtype=bool),
            data_mode="U",
            field_used=rows[0][col[variable]].strip(),
            source_file=source_name,
        ))
    if not out:
        raise TextCastError("no cast had two or more levels with both depth and value")
    return out, notes


def demo() -> None:
    """The text path and the NetCDF path must agree on the same real deployment."""
    from . import glider

    cache = Path(__file__).resolve().parents[2] / "data" / "cache"
    stem = "glider_ru29-20180812T0220_bob"
    nc, txt = cache / f"{stem}.nc", cache / f"{stem}.csv"
    if not (nc.exists() and txt.exists()):
        raise SystemExit(f"missing {nc.name} or {txt.name}; run python -m server.tools.fetch_fixtures")

    a = glider.read_profiles(nc, "temperature")
    b, notes = read_text(txt.read_text(encoding="utf-8"), "temperature",
                         source_name="ru29-20180812T0220.csv")
    assert len(a) == len(b), f"{len(a)} casts from NetCDF, {len(b)} from text"
    by_id = {q.platform.split("#")[1]: q for q in b}
    for p in a:
        q = by_id[p.platform.split("#")[1]]
        assert np.allclose(p.depth, q.depth) and np.allclose(p.value, q.value, atol=1e-4)
        assert abs(p.lat - q.lat) < 1e-6 and abs(p.lon - q.lon) < 1e-6
        assert abs((p.time - q.time) / np.timedelta64(1, "s")) < 1, (p.time, q.time)
        assert list(p.qc) == list(q.qc) and q.data_mode == "U"

    # Pressure instead of depth, tab-separated, no station column, no units row.
    tsv = ("lat\tlon\ttime\tpres (dbar)\tTEMP [degC]\n"
           "15.0\t88.0\t2018-08-25T00:00:00\t10\t29.1\n"
           "15.0\t88.0\t2018-08-25T00:00:00\t1000\t6.2\n")
    (cast,), tsv_notes = read_text(tsv)
    assert 980 < cast.depth[-1] < 1000, cast.depth  # 1000 dbar is a little under 1000 m
    assert any("gsw" in n for n in tsv_notes)

    # CTD-style: no station column, a timestamp on every scan, two casts at two places.
    ctd = "latitude,longitude,time,depth,temperature\n" + "".join(
        f"{la},{lo},2018-08-25T00:{m:02d}:00,{d},{t}\n"
        for la, lo, base in ((12.0, 85.0, 0), (13.0, 86.0, 30))
        for m, d, t in ((base + 0, 5, 29.0), (base + 1, 50, 27.0), (base + 2, 200, 15.0)))
    casts, _ = read_text(ctd)
    assert len(casts) == 2 and all(c.depth.size == 3 for c in casts), [c.depth for c in casts]

    try:
        read_text("a,b\n1,2\n")
    except TextCastError as err:
        assert "no column for" in str(err)
    else:
        raise AssertionError("a table with no cast columns was accepted")

    levels = sum(p.depth.size for p in b)
    print(f"textcast ok: {len(b)} casts, {levels} levels identical to the NetCDF path; "
          f"{len(notes)} assumptions recorded")


if __name__ == "__main__":
    demo()
