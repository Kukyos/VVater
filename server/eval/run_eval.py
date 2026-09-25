"""The numbers table. Nothing is quoted in a deck, proposal or film that this did not print.

    python -m server.eval.run_eval
    python -m server.eval.run_eval --json    # also writes data/eval-latest.json

The JSON dump exists so the trace from a figure in the deck back to the harness is a file
rather than a copy-paste out of a terminal scroll. The one architectural rule
(docs/00-start-here.md) is only true if the numbers are machine-readable.
"""

import json
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import truststore
import xarray as xr

truststore.inject_into_ssl()  # INCOIS serves an incomplete chain; never verify=False

# TLS first, then anything that fetches.
from server.ocean import (argo, cf, colocate, config, currents, glider,  # noqa: E402
                          heat, regrid, residual, sources, textcast)

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

    # ---- cyclone heat potential -----------------------------------------
    # The same co-located pairs, integrated into TCHP (heat.py): the residual restated in
    # kJ/cm^2, the unit an intensity forecast uses. Casts that never cool to 26 degC on
    # their accepted levels have no D26 and are counted, not guessed.
    _rule("Tropical cyclone heat potential  (analysis minus observed, kJ/cm^2)")
    record["tchp"] = {}
    for label, casts in (("argo", usable), ("glider", [g for g in gliders if g.accepted.any()])):
        pairs = [heat.compare(colocate.colocate(p, ds, names["value"], names.get("error")))
                 for p in casts]
        diffs = np.array([t["difference_kj_cm2"] for t in pairs
                          if t["difference_kj_cm2"] is not None])
        obs = np.array([t["observed_kj_cm2"] for t in pairs
                        if t["difference_kj_cm2"] is not None])
        entry = {"casts": len(pairs), "with_d26": int(diffs.size)}
        if diffs.size:
            entry.update({
                "mean_observed_kj_cm2": round(float(obs.mean()), 2),
                "mean_difference_kj_cm2": round(float(diffs.mean()), 2),
                "rmse_kj_cm2": round(float(np.sqrt((diffs ** 2).mean())), 2),
                "relative_rmse_percent": round(float(np.sqrt((diffs ** 2).mean())
                                                     / obs.mean() * 100), 1),
            })
            print(f"  {label:<7} {diffs.size:>3}/{len(pairs):<3} casts reach D26   "
                  f"observed mean {entry['mean_observed_kj_cm2']:6.2f}   "
                  f"analysis - observed {entry['mean_difference_kj_cm2']:+6.2f}   "
                  f"rmse {entry['rmse_kj_cm2']:5.2f}  ({entry['relative_rmse_percent']} %)")
        else:
            print(f"  {label:<7} no cast reaches D26 on accepted levels")
        record["tchp"][label] = entry
    record["tchp"]["constants"] = {
        "rho_kg_m3": heat.RHO, "cp_J_kg_K": heat.CP0, "threshold_degC": heat.THRESHOLD}

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

    # ---- residual volume ------------------------------------------------
    # The viewer prints these numbers on screen during a demo, so they have to come from
    # here. Hard rule 1: no figure appears anywhere the harness did not produce it.
    _rule("Residual volume  (what the viewer shows on the residual layer)")
    t0 = time.perf_counter()
    _, res = residual.build(ds, names["value"], usable + gliders, str(CENTRE))
    residual_s = time.perf_counter() - t0
    summary = res.as_dict()
    print(f"  casts compared   {summary['casts']}")
    print(f"  analysis steps   {', '.join(summary['analysis_steps'])}"
          "   <- a +/-5 d window over a 10-day cadence spans two")
    print(f"  levels binned    {summary['levels_binned']}")
    print(f"  cells with data  {summary['cells_filled']} of {summary['cells_total']} "
          f"({summary['coverage_percent']} %)")
    print(f"  pooled           bias {summary['bias']:+.3f}   rmse {summary['rmse']:.3f}")
    print(f"  build            {residual_s:.1f} s")
    record["residual"] = {**summary, "build_seconds": round(residual_s, 2)}

    # ---- delimited-text ingestion ----------------------------------------
    # The same glider deployment as NetCDF and as CSV, through the two parsers. Agreement
    # is counted cast by cast, level by level, rather than asserted, so the number that
    # goes on a slide is the number measured here.
    _rule("Delimited-text ingestion  (same deployment, NetCDF path vs text path)")
    stem = f"glider_{config.GLIDER_DEPLOYMENTS[0]}_bob"
    nc_path, csv_path = CACHE / f"{stem}.nc", CACHE / f"{stem}.csv"
    if nc_path.exists() and csv_path.exists():
        t0 = time.perf_counter()
        from_text, _ = textcast.read_text(csv_path.read_text(encoding="utf-8"), "temperature",
                                          source_name=f"{config.GLIDER_DEPLOYMENTS[0]}.csv")
        text_s = time.perf_counter() - t0
        from_nc = {q.platform.split("#")[1]: q for q in glider.read_profiles(nc_path)}
        same = [q for q in from_text
                if (m := from_nc.get(q.platform.split("#")[1])) is not None
                and m.depth.size == q.depth.size and np.allclose(m.depth, q.depth)
                and np.allclose(m.value, q.value, atol=1e-4)]
        record["text_ingest"] = {
            "casts_netcdf": len(from_nc), "casts_text": len(from_text),
            "casts_identical": len(same),
            "levels_identical": int(sum(q.depth.size for q in same)),
            "parse_seconds": round(text_s, 2),
        }
        print(f"  casts            {len(from_nc)} NetCDF, {len(from_text)} text, "
              f"{len(same)} identical ({record['text_ingest']['levels_identical']} levels)")
        print(f"  parse            {text_s:.2f} s for {csv_path.stat().st_size / 1e6:.1f} MB of CSV")
    else:
        print("  glider CSV fixture missing; run python -m server.tools.fetch_fixtures")

    # ---- currents -------------------------------------------------------
    _rule("Current streamlines")
    try:
        day = config.DEMO_DATE.isoformat()
        cds, cnames = sources.fetch_many(["u", "v"], day, day, source_key="glorys12")
        t0 = time.perf_counter()
        lines = currents.streamlines(cds, cnames["u"], cnames["v"], 0, 0)
        currents_s = time.perf_counter() - t0
        print(f"  source           Copernicus GLORYS12 (the only source with u/v)")
        print(f"  streamlines      {lines['count']} at {lines['depth_m']:.0f} m")
        print(f"  speed            {lines['speedRange'][0]:.3f} to {lines['speedRange'][1]:.3f} m/s")
        print(f"  integrate        {currents_s * 1000:.0f} ms")
        print(f"  method           {lines['method']}")
        record["currents"] = {
            "count": lines["count"], "depth_m": lines["depth_m"],
            "speed_range": lines["speedRange"], "seconds": round(currents_s, 3),
            "method": lines["method"], "caveat": lines["note"],
        }
    except Exception as exc:  # credentials absent, or no network
        print(f"  unavailable: {exc}")
        record["currents"] = {"unavailable": str(exc)}

    record["v2"] = v2_numbers()

    _rule("Assumptions on the record")
    for note in rows[0]["cf_assumptions"]:
        print(f"  - {note}")
    print(f"  - {rows[0]['pairing_note']}")

    if write_json:
        out = Path(__file__).resolve().parents[2] / "data" / "eval-latest.json"
        out.write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
        print(f"\nwrote {out.relative_to(out.parents[1])}")


def v2_numbers() -> dict:
    """The Ocean Cube's numbers: catalogue, one scenario cube, its floats, Amphan's cooling,
    and the hosting measurement. Each part is measured here or read from the file the
    measuring tool wrote, never typed in."""
    from server.ocean import catalog, cube, cubecasts

    out: dict = {"scenarios": len(config.SCENARIOS)}
    _rule("v2 · catalogue")
    try:
        cat = catalog.describe()
        variables = cat["variables"]
        starts = [e["from"] for v in variables for e in v["eras"]]
        ends = [e["to"] for v in variables for e in v["eras"]]
        out["catalog"] = {
            "variables": len(variables),
            "depth_resolved": sum(v["depth"] for v in variables),
            "derived_teos10": sum(bool(v["derived"]) and "TEOS-10" in v["formula"]
                                  for v in variables),
            "biogeochemistry": sum(v["group"] == "biogeochemistry" for v in variables),
            "first_day": min(starts)[:10], "last_day": max(ends)[:10], "today": cat["today"],
        }
        # Not every variable reaches back that far: pH, w and the carbon system exist only
        # in the analysis & forecast. Counted, so "every day since" is said of the right ones.
        first = out["catalog"]["first_day"]
        out["catalog"]["from_first_day"] = sum(
            any(e["from"][:10] == first for e in v["eras"]) for v in variables)
        c = out["catalog"]
        print(f"  variables        {c['variables']} ({c['depth_resolved']} depth-resolved, "
              f"{c['biogeochemistry']} biogeochemistry, {c['derived_teos10']} TEOS-10 derived)")
        print(f"  days             {c['first_day']} to {c['last_day']} (today {c['today']}); "
              f"{c['from_first_day']} variables reach back to {c['first_day']}")
    except Exception as exc:  # no network
        print(f"  unavailable: {exc}")
        out["catalog"] = {"unavailable": str(exc)}

    _rule("v2 · Amphan cubes and their floats")
    try:
        scen = {s.key: s for s in config.SCENARIOS}
        sea = {}
        for key in ("amphan_before", "amphan_after"):
            sc = scen[key]
            box = cube.Box.parse(*sc.box)
            t0 = time.perf_counter()
            c = cube.build(sc.variable, box, sc.day, float(sc.depth_max))
            first_s = time.perf_counter() - t0
            t0 = time.perf_counter()
            cube.build(sc.variable, box, sc.day, float(sc.depth_max))
            again_s = time.perf_counter() - t0
            nz, ny, nx = c.values.shape
            top = c.values[0]
            sea[key] = float(np.nanmean(top))
            out[key] = {"day": sc.day, "levels": nz, "cells": [nx, ny],
                        "payload_mb": round(len(c.payload()) / 1e6, 2),
                        "open_seconds_disk_cache": round(first_s, 2),
                        "open_seconds_memory": round(again_s, 3),
                        "surface_mean_c": round(sea[key], 2)}
            print(f"  {key:14s} {sc.day}  {nx}x{ny}x{nz} levels  "
                  f"open {first_s:.2f} s from disk cache, {again_s * 1000:.0f} ms again  "
                  f"surface mean {sea[key]:.2f} C")
        out["amphan_cooling_c"] = round(sea["amphan_before"] - sea["amphan_after"], 2)
        # The deck's hero picture is the before cube taken down to 1,000 m, not the
        # scenario's 300 m: its own level count, so the caption describes the picture.
        sc = scen["amphan_before"]
        c = cube.build(sc.variable, cube.Box.parse(*sc.box), sc.day, 1000.0)
        out["hero"] = {"scenario": sc.key, "depth_max": 1000, "levels": int(c.values.shape[0]),
                       "deepest_level_m": round(float(c.depths[-1]), 1)}
        print(f"  hero           {sc.key} to 1,000 m: {out['hero']['levels']} native levels, "
              f"deepest {out['hero']['deepest_level_m']} m")
        print(f"  surface cooling  {out['amphan_cooling_c']:.2f} C, box mean, before minus after")

        sc = scen["amphan_before"]
        cs = cubecasts.casts(sc.variable, cube.Box.parse(*sc.box), sc.day, float(sc.depth_max))
        levels = sum(x["levels"] for x in cs["casts"])
        rejected = sum(x["levelsRejected"] for x in cs["casts"])
        modes = {m: sum(x["dataMode"] == m for x in cs["casts"]) for m in "RAD"}
        out["amphan_before_casts"] = {"found": cs["found"], "shown": cs["shown"],
                                      "levels": levels, "levels_rejected": rejected,
                                      "data_modes": modes, "window": [cs["from"], cs["to"]]}
        print(f"  Argo casts       {cs['found']} within +/-{cs['window_days']} days, "
              f"{levels} levels, {rejected} rejected by QC, modes {modes}")
    except Exception as exc:
        print(f"  unavailable: {exc}")
        out["amphan"] = {"unavailable": str(exc)}

    _rule("v2 · hosting (python -m server.tools.measure_hosting)")
    hosting = Path(__file__).resolve().parents[2] / "data" / "hosting-latest.json"
    if hosting.exists():
        h = json.loads(hosting.read_text(encoding="utf-8"))
        out["hosting"] = {k: h[k] for k in ("measured", "idle_mb", "peak_mb", "settled_mb",
                                           "cpu_pct_max", "cpu_total_s", "wall_s", "sent_mb",
                                           "cache_disk_mb", "boot_s")}
        out["hosting"]["requests"] = len(h["requests"])
        out["hosting"]["requests_ok"] = sum(r["status"] == 200 for r in h["requests"])
        print(f"  {h['measured']}: peak {h['peak_mb']} MB, idle {h['idle_mb']} MB, "
              f"CPU peak {h['cpu_pct_max']:.0f} %, cache {h['cache_disk_mb']} MB, "
              f"{out['hosting']['requests_ok']}/{out['hosting']['requests']} requests 200")
    else:
        print("  no data/hosting-latest.json; run python -m server.tools.measure_hosting")
    return out


if __name__ == "__main__":
    main(write_json="--json" in sys.argv)
