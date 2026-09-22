"""Argo profile ingestion from the GDAC HTTPS mirror.

The FTP host in the problem statement is dead (port 21 blocked). This reads
`data-argo.ifremer.fr`, which serves one aggregated NetCDF per basin per day.

The three things a naive reader gets wrong, all measured on a real file
(`docs/05-data-sources.md` 2.1):

  1. `DATA_MODE` was 62 'A' / 35 'R' on one day, so `TEMP_ADJUSTED` is the *default*
     and `TEMP` the fallback, not the other way round.
  2. Per-level QC flags are real and non-empty: 1 x 65728, 3 x 4, 4 x 72. Data that
     fails QC is kept and marked, never silently dropped (L5).
  3. Argo reports pressure, not depth. Converting needs latitude (TEOS-10).
"""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import gsw
import numpy as np
import requests
import xarray as xr

from . import config

# Our canonical name -> (core variable, adjusted variable, QC variable)
VARIABLES = {
    "temperature": ("TEMP", "TEMP_ADJUSTED", "TEMP_QC"),
    "salinity": ("PSAL", "PSAL_ADJUSTED", "PSAL_QC"),
}


@dataclass
class Profile:
    """One float cast. Everything needed to draw it and to defend drawing it."""

    platform: str
    lat: float
    lon: float
    time: np.datetime64
    depth: np.ndarray          # metres, positive down
    value: np.ndarray          # the variable, same length as depth
    qc: np.ndarray             # per-level QC flag characters
    accepted: np.ndarray       # bool mask: qc in config.QC_ACCEPT
    # Argo: 'R' real-time, 'A' adjusted, 'D' delayed-mode.
    # Glider (see glider.py): 'Q' QARTOD-flagged, 'U' unevaluated — deliberately not
    # folded into Argo's vocabulary, because they do not mean the same thing.
    data_mode: str
    field_used: str            # which NetCDF variable the values came from
    source_file: str

    @property
    def n_rejected(self) -> int:
        return int((~self.accepted).sum())

    def provenance(self) -> dict:
        return {
            "platform": self.platform,
            "data_mode": self.data_mode,
            "field_used": self.field_used,
            "source_file": self.source_file,
            "levels": int(self.depth.size),
            "levels_rejected": self.n_rejected,
            # 'U' means no QC was ever run on this source, so quoting an accept-set
            # here would advertise a check that did not happen.
            "qc_accepted": ("none - unevaluated" if self.data_mode == "U"
                            else sorted(config.QC_ACCEPT)),
        }


def day_url(day: date) -> str:
    return (
        f"{config.ARGO_GDAC_BASE}/geo/{config.ARGO_BASIN}/"
        f"{day:%Y}/{day:%m}/{day:%Y%m%d}_prof.nc"
    )


def fetch_day(day: date, cache_dir: Path) -> Path | None:
    """Download one day-file. Returns None when that day simply has no file."""
    path = cache_dir / f"argo_{config.ARGO_BASIN}_{day:%Y%m%d}.nc"
    if path.exists():
        return path
    cache_dir.mkdir(parents=True, exist_ok=True)
    resp = requests.get(day_url(day), timeout=config.HTTP_TIMEOUT)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    path.write_bytes(resp.content)
    return path


def _as_str(values) -> np.ndarray:
    """Argo stores fixed-width character arrays; xarray hands them back as bytes or str."""
    out = np.asarray(values)
    if out.dtype.kind == "S":
        out = np.char.decode(out, "utf-8")
    return np.char.strip(out.astype(str))


def _qc_chars(values, length: int) -> np.ndarray:
    """One QC flag character per level.

    The QC variables come back as an **object array** whose elements are single bytes
    (`b'4'`) with `nan` in the unfilled levels — not as a string, and not as a character
    array. Calling str() on it yields the array's repr, which silently produces garbage
    flags that then reject every level. Padded with ' ' (missing), which is not in
    QC_ACCEPT, so an absent flag is treated as not-accepted rather than assumed good.
    """
    out = np.full(length, " ", dtype="<U1")
    raw = np.asarray(values, dtype=object).ravel()
    for i, item in enumerate(raw[:length]):
        if isinstance(item, bytes):
            item = item.decode("utf-8", "ignore")
        if isinstance(item, str) and item.strip():
            out[i] = item.strip()[0]
    return out


def read_profiles(path: Path, variable: str) -> list[Profile]:
    """Pull every profile inside the configured region out of one day-file."""
    core, adjusted, qc_name = VARIABLES[variable]
    lon0, lon1 = config.REGION["lon"]
    lat0, lat1 = config.REGION["lat"]

    out: list[Profile] = []
    with xr.open_dataset(path) as ds:
        lats = np.asarray(ds.LATITUDE.values, dtype=float)
        lons = np.asarray(ds.LONGITUDE.values, dtype=float)
        inside = (lons >= lon0) & (lons <= lon1) & (lats >= lat0) & (lats <= lat1)
        modes = _as_str(ds.DATA_MODE.values)
        platforms = _as_str(ds.PLATFORM_NUMBER.values)

        for i in np.flatnonzero(inside):
            mode = str(modes[i])
            # Adjusted first (see module docstring), core only if adjusted is all-NaN.
            field_used = adjusted if adjusted in ds else core
            values = np.asarray(ds[field_used].isel(N_PROF=i).values, dtype=float)
            if not np.isfinite(values).any() and core in ds:
                field_used = core
                values = np.asarray(ds[core].isel(N_PROF=i).values, dtype=float)

            pres_name = "PRES_ADJUSTED" if field_used.endswith("_ADJUSTED") else "PRES"
            pres = np.asarray(ds[pres_name].isel(N_PROF=i).values, dtype=float)
            if not np.isfinite(pres).any():
                pres = np.asarray(ds["PRES"].isel(N_PROF=i).values, dtype=float)

            qc_padded = _qc_chars(ds[qc_name].isel(N_PROF=i).values, values.size)

            real = np.isfinite(values) & np.isfinite(pres)
            if not real.any():
                continue

            # gsw returns height (negative below the surface); we want depth positive down.
            depth = -gsw.z_from_p(pres[real], float(lats[i]))

            out.append(
                Profile(
                    platform=str(platforms[i]),
                    lat=float(lats[i]),
                    lon=float(lons[i]),
                    time=ds.JULD.isel(N_PROF=i).values,
                    depth=depth,
                    value=values[real],
                    qc=qc_padded[real],
                    accepted=np.isin(qc_padded[real], list(config.QC_ACCEPT)),
                    data_mode=mode,
                    field_used=field_used,
                    source_file=path.name,
                )
            )
    return out


def load_window(centre: date, variable: str = "temperature",
                days: float | None = None, cache_dir: Path | None = None) -> list[Profile]:
    """Every in-region profile within +/- `days` of `centre`.

    The default window is `config.FLOAT_PAIRING_DAYS`, and the reason it is 5 and not 10
    is measured, not chosen — see L6 in docs/03-limitations.md.
    """
    days = config.FLOAT_PAIRING_DAYS if days is None else days
    cache_dir = cache_dir or Path(__file__).resolve().parents[2] / "data" / "cache"
    span = int(days)

    profiles: list[Profile] = []
    for offset in range(-span, span + 1):
        path = fetch_day(centre + timedelta(days=offset), cache_dir)
        if path is not None:
            profiles.extend(read_profiles(path, variable))
    return profiles
