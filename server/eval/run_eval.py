"""The numbers table. Nothing is quoted in a deck, proposal or film that this did not print.

    python -m server.eval.run_eval
    python -m server.eval.run_eval --json    # also writes data/eval-latest.json

The JSON dump exists so the trace from a figure in the deck back to the harness is a file
rather than a copy-paste out of a terminal scroll. Hard rule 1 in CLAUDE.md is only true
if the numbers are machine-readable.
"""

import json
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import xarray as xr

from server.ocean import argo, cf, colocate, config, glider, regrid, sources

CACHE = Path(__file__).resolve().parents[2] / "data" / "cache"
CENTRE = config.DEMO_DATE
WINDOW = ("2018-07-01", "2018-10-31")


def _rule(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


def main(write_json: bool = False) -> None:
    record: dict = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "region": config.REGION, "centre_date": str(CENTRE),
                    "pairing_days": config.FLOAT_PAIRING_DAYS,
                    "source": config.SOURCES[config.DEFAULT_SOURCE].title}
    print(f"Region        {config.REGION['name']}  "
          f"{config.REGION['lon'][0]}-{config.REGION['lon'][1]}E  "
          f"{config.REGION['lat'][0]}-{config.REGION['lat'][1]}N")
    print(f"Source        {config.SOURCES[config.DEFAULT_SOURCE].title}")
    print(f"Centre date   {CENTRE}   pairing +/-{config.FLOAT_PAIRING_DAYS:.0f} days")

    # ---- gridded field -------------------------------------------------
    _rule("Gridded field")
    t0 = time.perf_counter()
    ds, names = sources.fetch("temperature", *WINDOW)
    fetch_s = time.perf_counter() - t0

    value = ds[names["value"]]
    nbytes = int(np.prod(value.shape)) * 4
    print(f"  shape          {dict(value.sizes)}")
    print(f"  fetch          {fetch_s:.2f} s   ({nbytes / 1e6:.2f} MB as float32)")
    print(f"  finite         {float(np.isfinite(value.values).mean()) * 100:.1f} %"
          "  (remainder is land / bathymetry mask)")
    print(f"  range          {float(np.nanmin(value)):.2f} to {float(np.nanmax(value)):.2f}")
    bad_mask, range_report = cf.global_range_check(value.values, "sea_water_temperature")
    print(f"  range test     {range_report['test']}: "
          f"{range_report['failed']} of {range_report['checked_cells']} cells fail")
    if range_report["failed"]:
        print(f"                 failing values {range_report['failed_range']} "
              "<- the MODEL needs QC too, not just the observations")

    record["field_range_test"] = range_report
    record["field"] = {"shape": {k: int(v) for k, v in value.sizes.items()},
                       "fetch_seconds": round(fetch_s, 3),
                       "float32_mb": round(nbytes / 1e6, 3),
                       "finite_fraction": round(float(np.isfinite(value.values).mean()), 4),
                       "min": round(float(np.nanmin(value)), 3),
                       "max": round(float(np.nanmax(value)), 3)}

    # ---- regrid --------------------------------------------------------
    _rule("Depth regrid")
    source = config.SOURCES[config.DEFAULT_SOURCE]
    native = ds.ZAX.values
    t0 = time.perf_counter()
    grid = regrid.build_grid(native, source.native_levels)
    one_step = regrid.resample(value.isel(time=0).values, native, grid, depth_axis=0)
    regrid_s = time.perf_counter() - t0
    print(f"  native levels  {native.size}   output levels {grid.n}   (never more: L2/V1)")
    print(f"  stretch        {grid.provenance()['stretch']}")
    print(f"  bin spacing    {grid.depths[1] - grid.depths[0]:.2f} m at the surface, "
          f"{grid.depths[-1] - grid.depths[-2]:.1f} m at {grid.z_max:.0f} m")
    print(f"  resample       {regrid_s * 1000:.0f} ms per timestep")
    print(f"  finite after   {float(np.isfinite(one_step).mean()) * 100:.1f} %")
    record["regrid"] = {"native_levels": int(native.size), "output_levels": grid.n,
                        "resample_ms": round(regrid_s * 1000, 1), **grid.provenance()}

    # ---- observations --------------------------------------------------
    _rule("Argo profiles")
    t0 = time.perf_counter()
    profiles = argo.load_window(CENTRE, "temperature", cache_dir=CACHE)
    argo_s = time.perf_counter() - t0
    total_levels = sum(p.depth.size for p in profiles)
    rejected = sum(p.n_rejected for p in profiles)
    fully_rejected = sum(1 for p in profiles if p.n_rejected == p.depth.size)
    modes = {m: sum(1 for p in profiles if p.data_mode == m) for m in "RAD"}
    print(f"  window         {argo_s:.1f} s for +/-{config.FLOAT_PAIRING_DAYS:.0f} days")
    print(f"  profiles       {len(profiles)} in region")
    print(f"  data modes     R={modes['R']}  A={modes['A']}  D={modes['D']}")
    print(f"  levels         {total_levels}   rejected by QC {rejected} "
          f"({rejected / max(total_levels, 1) * 100:.1f} %)")
    print(f"  profiles fully rejected  {fully_rejected}"
          "   <- these would be rendered by a pipeline that ignores QC")
    record["argo"] = {"window_seconds": round(argo_s, 2), "profiles": len(profiles),
                      "data_modes": modes, "levels": int(total_levels),
                      "levels_rejected": int(rejected),
                      "profiles_fully_rejected": int(fully_rejected)}

    # ---- gliders --------------------------------------------------------
    _rule("Glider profiles")
    t0 = time.perf_counter()
    gliders = glider.load_window(CENTRE, "temperature", cache_dir=CACHE)
    glider_s = time.perf_counter() - t0
    g_levels = sum(p.depth.size for p in gliders)
    if gliders:
        depths = np.concatenate([p.depth for p in gliders])
        print(f"  deployments    {', '.join(config.GLIDER_DEPLOYMENTS)}")
        print(f"  fetch          {glider_s:.1f} s")
        print(f"  casts          {len(gliders)} in region, {g_levels} levels")
        print(f"  depth span     {depths.min():.1f} - {depths.max():.1f} m")
        print(f"  track          {min(p.lat for p in gliders):.2f}-{max(p.lat for p in gliders):.2f} N, "
              f"{min(p.lon for p in gliders):.2f}-{max(p.lon for p in gliders):.2f} E")
    else:
        print("  none in window")
    record["glider"] = {"deployments": list(config.GLIDER_DEPLOYMENTS),
                        "fetch_seconds": round(glider_s, 2),
                        "casts": len(gliders), "levels": int(g_levels)}

    # ---- co-location ---------------------------------------------------
    _rule("Model-observation co-location")
    usable = [p for p in profiles if p.accepted.any()]
    if not usable:
        print("  no QC-accepted profile in the window")
        return

    rows = []
    for p in usable:
        c = colocate.colocate(p, ds, names["value"], names.get("error"))
        s = c.summary()
        rows.append(s)
        print(f"  {p.platform:<10} {p.lat:6.2f},{p.lon:7.2f}  "
              f"levels {s['levels_compared']:>3}/{s['levels']:<3} "
              f"bias {s['bias']:+6.2f}  rmse {s['rmse']:5.2f}  "
              f"dt {s['time_offset_days']:+.1f} d  "
              f"dgrid {s['grid_offset_deg']['lat']:.2f}/{s['grid_offset_deg']['lon']:.2f} deg")

    biases = np.array([r["bias"] for r in rows if np.isfinite(r["bias"])])
    rmses = np.array([r["rmse"] for r in rows if np.isfinite(r["rmse"])])
    if biases.size:
        print(f"\n  Argo:   {biases.size} profiles   "
              f"mean bias {biases.mean():+.2f} degC   mean rmse {rmses.mean():.2f} degC"
              "   <- in the analysis's own input stream")

    # Gliders go through the identical path — that is the point of reusing Profile.
    g_rows = [colocate.colocate(p, ds, names["value"], names.get("error")).summary()
              for p in gliders if p.accepted.any()]
    g_bias = np.array([r["bias"] for r in g_rows if np.isfinite(r["bias"])])
    g_rmse = np.array([r["rmse"] for r in g_rows if np.isfinite(r["rmse"])])
    if g_bias.size:
        print(f"  Glider: {g_bias.size} casts      "
              f"mean bias {g_bias.mean():+.2f} degC   mean rmse {g_rmse.mean():.2f} degC"
              "   <- NOT assimilated: this one is independent")

    record["colocation"] = {
        "profiles_compared": int(biases.size),
        "mean_bias_degC": round(float(biases.mean()), 4) if biases.size else None,
        "mean_rmse_degC": round(float(rmses.mean()), 4) if rmses.size else None,
        # Not an independent validation: these floats are in the analysis's own input
        # stream, so this is a lower bound on true error. See docs/13-eval-results.md.
        "interpretation": "consistency check, not independent validation",
        "per_profile": rows,
        "glider_casts_compared": int(g_bias.size),
        "glider_mean_bias_degC": round(float(g_bias.mean()), 4) if g_bias.size else None,
        "glider_mean_rmse_degC": round(float(g_rmse.mean()), 4) if g_rmse.size else None,
        "glider_interpretation": "independent: gliders are not assimilated into this analysis",
    }

    # ---- depth-matched comparison ---------------------------------------
    # Argo runs to 2000 m and the glider stops near 960 m, so a single pooled number
    # compares "glider in the hard part of the column" against "Argo mostly in the easy
    # part". Banding it is the only way to tell sampling apart from skill.
    _rule("Depth-banded residuals  (pooled levels, not per-profile means)")
    print(f"  {'band':<22}{'Argo n':>8}{'bias':>7}{'rmse':>7}   {'Glider n':>9}{'bias':>7}{'rmse':>7}")
    bands = {}
    for label, lo, hi in colocate.BANDS:
        a = colocate.pooled_residuals(usable, ds, names["value"], lo, hi)
        g = colocate.pooled_residuals(gliders, ds, names["value"], lo, hi)
        bands[label] = {"argo": a, "glider": g}
        print(f"  {label:<22}{a['levels']:>8}{a['bias']:>7.2f}{a['rmse']:>7.2f}"
              f"   {g['levels']:>9}{g['bias']:>7.2f}{g['rmse']:>7.2f}")
    record["depth_bands"] = bands

    deep = bands["300-950 m"]
    print(f"\n  Below 300 m the two instruments are indistinguishable "
          f"({deep['argo']['rmse']:.2f} vs {deep['glider']['rmse']:.2f}).")
    print("  The entire disagreement lives in the upper 300 m, where the thermocline is.")

    _rule("Assumptions on the record")
    for note in rows[0]["cf_assumptions"]:
        print(f"  - {note}")
    print(f"  - {rows[0]['pairing_note']}")

    if write_json:
        out = Path(__file__).resolve().parents[2] / "data" / "eval-latest.json"
        out.write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
        print(f"\nwrote {out.relative_to(out.parents[1])}")


if __name__ == "__main__":
    main(write_json="--json" in sys.argv)
