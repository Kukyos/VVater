"""Copernicus Marine In Situ TAC files: moorings, CTDs, ADCPs and HF-radar, one reader.

The brief's extensible-design list (CTDs, moorings, HF-radar, ADCP) is four instruments,
but on the wire it is one file format. The In Situ TAC publishes every platform in the
same NetCDF layout, and the file name says what the platform is:

    GL_TS_MO_23009.nc      TS = time series,  MO = mooring   (RAMA 15N 90E)
    GL_PR_CT_FNIN.nc       PR = profiles,     CT = CTD casts
    BS_PR_AD_Mangalia70.nc PR = profiles,     AD = ADCP
    GL_TV_HF_HFR-*.nc      TV = total vectors, HF = HF-radar  (a grid, not casts)

So a new mooring, CTD or ADCP is a line in `config.INSITU_PLATFORMS`, not new code. The
first three become the same `argo.Profile` every other instrument emits, and co-location,
the profile chart and QC display work on them unchanged. HF-radar is a surface current
grid, so it has its own small reader (`read_surface_currents`).

Found by filtering the TAC's own file index (`index_history.txt`, 2026-09-28) to the Bay;
`docs/05-data-sources.md` 2.5 has the probe. What this reader has to get right, all seen
in real files:

  * **Depth varies per record.** `DEPH` is (TIME, DEPTH), not a coordinate; a mooring's
    sensors are re-deployed at slightly different depths between servicing cruises.
  * **The DEPTH axis repeats.** RAMA 15N 90E declares 180/300/500 m twice (slots 15-17
    and 18-20). A cast is de-duplicated and sorted, or interpolation onto it breaks.
  * **Several record streams share one TIME axis.** RAMA writes the full column once a
    day at 12:00 and surface-only records at :17; a cast is a record with >= 2 levels.
  * **Pressure, not depth, in some files** (the ADCP sample). Converted with TEOS-10 the
    way argo.py does it, and the conversion is recorded.
  * **QC is float with NaN.** The flag scale is Argo's (0 none, 1 good, 2 probably good,
    3-4 bad, 5 changed, 8 interpolated, 9 missing), so `config.QC_ACCEPT` applies. But
    flag 0 is "no QC performed": a cast with only 0 flags is data_mode 'U', never passing.
  * **data_mode is per variable** (an attribute, R/A/D/M), the same vocabulary as Argo.

    python -m server.ocean.insitu        # self-check against the cached real files
"""

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import gsw
import numpy as np
import requests
import xarray as xr

from . import config
from .argo import Profile

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache" / "insitu"

# Our canonical name -> the TAC parameter code. Same codes in every TAC file.
VARIABLES = {"temperature": "TEMP", "salinity": "PSAL", "u": "EWCT", "v": "NSCT"}

UNEVALUATED_NOTE = ("every flag on these levels is 0 (no QC performed), so no quality "
                    "control has been applied. Reported as data_mode 'U', never as passing.")


def fetch(path: str, cache_dir: Path | None = None) -> Path:
    """One TAC file by its path under the product root, cached. Plain HTTPS GET: the
    bucket is public, so no toolbox, no credentials."""
    cache_dir = cache_dir or CACHE
    local = cache_dir / Path(path).name
    if local.exists() and local.stat().st_size > 0:
        return local
    cache_dir.mkdir(parents=True, exist_ok=True)
    url = path if path.startswith("http") else f"{config.INSITU_TAC}/{path}"
    response = requests.get(url, timeout=180)
    response.raise_for_status()
    tmp = local.with_suffix(".part")
    tmp.write_bytes(response.content)
    tmp.replace(local)
    return local


def _flag_chars(flags: np.ndarray) -> np.ndarray:
    # NaN flag next to a real value: nobody flagged it, which is flag 0, not flag 1.
    return np.array([str(int(f)) if np.isfinite(f) else "0" for f in flags], dtype="<U1")


def _per_record(ds: xr.Dataset, name: str) -> np.ndarray:
    """A (TIME,) or (TIME, DEPTH) or scalar variable, as a float array broadcast to TIME."""
    a = np.asarray(ds[name].values, dtype=float)
    return np.broadcast_to(a, (ds.sizes["TIME"],)) if a.ndim == 0 else a


def read_profiles(path: Path, variable: str, centre: date | None = None,
                  days: float | None = None, nearest_only: bool = False) -> list[Profile]:
    """Every cast of `variable` in the file, optionally within +/- `days` of `centre`.

    `nearest_only` keeps the one cast closest to `centre`: a mooring emits a column a day,
    and eleven markers stacked on one point would say "eleven instruments".
    Raises KeyError when the file does not carry the variable.
    """
    code = VARIABLES[variable]
    days = config.FLOAT_PAIRING_DAYS if days is None else days
    with xr.open_dataset(path) as ds:
        if code not in ds:
            raise KeyError(f"{path.name} has no {code}")
        times = ds["TIME"].values
        window = np.ones(times.shape, dtype=bool)
        if centre is not None:
            window = ((times >= np.datetime64(centre - timedelta(days=days)))
                      & (times <= np.datetime64(centre + timedelta(days=days))))
        if not window.any():
            return []

        value = np.asarray(ds[code].values, dtype=float)
        qc = (np.asarray(ds[f"{code}_QC"].values, dtype=float) if f"{code}_QC" in ds
              else np.full(value.shape, np.nan))
        has_depth = "DEPH" in ds
        vertical = np.broadcast_to(np.asarray(ds["DEPH" if has_depth else "PRES"].values,
                                              dtype=float), value.shape)
        lat_name = "PRECISE_LATITUDE" if "PRECISE_LATITUDE" in ds else "LATITUDE"
        lon_name = "PRECISE_LONGITUDE" if "PRECISE_LONGITUDE" in ds else "LONGITUDE"
        lats, lons = _per_record(ds, lat_name), _per_record(ds, lon_name)
        mode = str(ds[code].attrs.get("data_mode", ds.attrs.get("data_mode", "R"))).strip()[:1]
        platform = str(ds.attrs.get("platform_code", path.stem)).strip()

        out: list[Profile] = []
        for i in np.where(window)[0]:
            z = vertical[i] if has_depth else -gsw.z_from_p(vertical[i], lats[i])
            good = np.isfinite(z) & np.isfinite(value[i])
            if good.sum() < 2:
                continue  # a surface-only record, not a cast
            zi, vi, qi = z[good], value[i][good], qc[i][good]
            # Sort, then drop repeated depths (RAMA declares 180/300/500 m twice).
            order = np.argsort(zi, kind="stable")
            zi, vi, qi = zi[order], vi[order], qi[order]
            keep = np.concatenate([[True], np.diff(zi) > 0])
            zi, vi, qi = zi[keep], vi[keep], qi[keep]
            chars = _flag_chars(qi)
            evaluated = bool((chars != "0").any())
            accepted = (np.isin(chars, list(config.QC_ACCEPT)) if evaluated
                        else np.ones(chars.shape, dtype=bool))
            out.append(Profile(
                platform=f"{platform}#{np.datetime_as_string(times[i], unit='m')}",
                lat=float(lats[i]), lon=float(lons[i]), time=times[i],
                depth=zi, value=vi, qc=chars, accepted=accepted,
                data_mode=mode if evaluated else "U",
                field_used=code, source_file=path.name,
            ))
    if nearest_only and centre is not None and out:
        target = np.datetime64(centre) + np.timedelta64(12, "h")
        out = [min(out, key=lambda p: abs(p.time - target))]
    return out


def notes_for(path: Path) -> list[str]:
    """The assumptions a reader of this file had to make (hard rule 5)."""
    out = ["QC scale: Copernicus In Situ TAC (Argo-numbered); accepted "
           f"{sorted(config.QC_ACCEPT)}; flag 0 means no QC performed"]
    with xr.open_dataset(path) as ds:
        if "DEPH" not in ds:
            out.append("depth from PRES with TEOS-10 gsw.z_from_p at the record latitude")
        if "PRECISE_LATITUDE" in ds:
            out.append("position from PRECISE_LATITUDE/LONGITUDE per record, not the "
                       "nominal mooring site")
        out.append(f"platform: {str(ds.attrs.get('platform_name', '')).strip()} "
                   f"({str(ds.attrs.get('institution', '')).strip()})")
    return out


def load_window(files: list[str], centre: date, variable: str, days: float | None = None,
                nearest_only: bool = False, cache_dir: Path | None = None) -> list[Profile]:
    """Casts from several TAC files. A file without the variable is skipped, not an error:
    a temperature-only mooring asked for salinity has nothing to say."""
    out: list[Profile] = []
    for f in files:
        try:
            out.extend(read_profiles(fetch(f, cache_dir), variable, centre, days, nearest_only))
        except KeyError:
            continue
    return out


# ------------------------------------------------------------------ HF-radar

@dataclass
class SurfaceCurrents:
    """One HF-radar total-vector map: a surface u/v grid with its own QC."""

    network: str
    time: np.datetime64
    lat: np.ndarray
    lon: np.ndarray
    u: np.ndarray               # (lat, lon), m/s, NaN where there is no vector
    v: np.ndarray
    accepted: np.ndarray        # (lat, lon) bool, from the aggregate QCflag
    depth_m: float
    source_file: str

    def provenance(self) -> dict:
        return {"network": self.network, "time": str(self.time)[:19],
                "vectors": int(np.isfinite(self.u).sum()),
                "rejected_by_qc": int((np.isfinite(self.u) & ~self.accepted).sum()),
                "depth_m": self.depth_m, "source_file": self.source_file,
                "qc": f"aggregate QCflag; accepted {sorted(config.QC_ACCEPT)}"}


def read_surface_currents(path: Path, step: int = 0) -> SurfaceCurrents:
    """One time step of a `GL_TV_HF_*` total-vector file."""
    with xr.open_dataset(path) as ds:
        pick = {"TIME": step, "DEPTH": 0}
        u = np.asarray(ds["EWCT"].isel(pick).values, dtype=float)
        v = np.asarray(ds["NSCT"].isel(pick).values, dtype=float)
        flags = (np.asarray(ds["QCflag"].isel(pick).values, dtype=float) if "QCflag" in ds
                 else np.full(u.shape, np.nan))
        chars = np.vectorize(lambda f: str(int(f)) if np.isfinite(f) else "0")(flags)
        return SurfaceCurrents(
            network=str(ds.attrs.get("platform_code", path.stem)).strip(),
            time=ds["TIME"].values[step],
            lat=np.asarray(ds["LATITUDE"].values, dtype=float),
            lon=np.asarray(ds["LONGITUDE"].values, dtype=float),
            u=u, v=v, accepted=np.isin(chars, list(config.QC_ACCEPT)),
            depth_m=float(np.asarray(ds["DEPH"].values).ravel()[0]) if "DEPH" in ds else 0.0,
            source_file=path.name,
        )


# ------------------------------------------------------------------ self-check

def demo() -> None:
    """Against the real files, cached by `fetch`. Network on first run only."""
    # Mooring: RAMA 15N 90E on the demo date.
    rama = fetch(config.INSITU_PLATFORMS["mooring"][0])
    casts = read_profiles(rama, "temperature", config.DEMO_DATE)
    assert casts, "RAMA 15N 90E has daily columns around the demo date"
    for c in casts:
        assert (np.diff(c.depth) > 0).all(), "sorted, and the repeated 180/300/500 m slots gone"
        assert c.depth.size == len(set(c.depth.tolist()))
        assert 14 < c.lat < 16 and 88 < c.lon < 91
    one = read_profiles(rama, "temperature", config.DEMO_DATE, nearest_only=True)
    assert len(one) == 1 and one[0].platform in {c.platform for c in casts}
    near = abs(one[0].time - (np.datetime64(config.DEMO_DATE) + np.timedelta64(12, "h")))
    assert all(near <= abs(c.time - (np.datetime64(config.DEMO_DATE) + np.timedelta64(12, "h")))
               for c in casts)
    top = one[0]
    assert 25 < float(top.value[0]) < 33, "Bay of Bengal surface water in August"
    assert top.data_mode in "RADM"
    # The file declares EWCT, but its current meter has no column that week: empty, no error.
    assert read_profiles(rama, "u", config.DEMO_DATE) == []

    # ADCP: a real velocity profile in pressure coordinates.
    adcp = fetch(config.INSITU_SAMPLES["adcp"])
    u = read_profiles(adcp, "u")
    assert u and (np.diff(u[0].depth) > 0).all() and np.abs(u[0].value).max() < 3
    assert any("PRES" in n for n in notes_for(adcp))

    # HF-radar: a real total-vector map.
    hf = read_surface_currents(fetch(config.INSITU_SAMPLES["hf_radar"]))
    assert hf.u.shape == (hf.lat.size, hf.lon.size)
    speed = np.hypot(hf.u, hf.v)
    assert np.isfinite(speed).any()
    # The raw map holds vectors no sea surface has; the network's own QC is what removes
    # them, which is why the flag travels with every vector rather than being pre-applied.
    assert np.nanmax(np.where(hf.accepted, speed, np.nan)) < 2.5
    assert hf.provenance()["rejected_by_qc"] > 0 and np.nanmax(speed) > 2.5

    # Flag 0 alone is unevaluated, not passing.
    assert (_flag_chars(np.array([np.nan, 0.0, 1.0])) == np.array(["0", "0", "1"])).all()
    print(f"insitu ok: RAMA {len(casts)} casts, nearest {str(top.time)[:16]} "
          f"{top.depth.size} levels; ADCP {len(u)} casts; HF-radar {hf.network} "
          f"{hf.provenance()['vectors']} vectors")


if __name__ == "__main__":
    import truststore
    truststore.inject_into_ssl()
    demo()
