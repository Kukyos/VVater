"""Every ocean variable the viewer can show anywhere on Earth, and where it comes from.

One `Variable` per quantity. Each names the Copernicus dataset that carries it in each
**era**, and `for_day` picks the era for a date:

  * **reanalysis** (`*_my_*`): 1993 to a few months ago. Observations assimilated after
    the fact; the better estimate wherever it exists, so it wins wherever it covers.
  * **analysis & forecast** (`*_anfc_*`): mid-2022 (physics) or late 2021 (BGC) to about
    ten days ahead. Dates after today are a **forecast** and are labelled so everywhere.

The eras overlap by years, so there is no gap, but the boundaries move as Copernicus
publishes: they are read from each store's own time axis at run time, never written here.
Probed 2026-09-24 (docs/05-data-sources.md 1.5): physics reanalysis 1993-01-01 to
2026-06-23, BGC reanalysis to 2026-05-31, both forecasts to 2026-10-03.

`derived` variables are computed from others with TEOS-10 (`gsw`), at native resolution,
and the formula travels in the provenance. Everything else is the dataset's own field.

Humidity is not here and cannot be: it is a property of air. The ocean's own equivalents
of "what state is this water in" are density and sound speed, which are.

    python -m server.ocean.catalog            # self-check, no network
    python -m server.ocean.catalog --probe    # open every store, print coverage
"""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date

# ------------------------------------------------------------------ datasets

PHY_MY = "cmems_mod_glo_phy_my_0.083deg_P1D-m"
PHY_MY_STATIC = "cmems_mod_glo_phy_my_0.083deg_static"
PHY_T_ANFC = "cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m"
PHY_S_ANFC = "cmems_mod_glo_phy-so_anfc_0.083deg_P1D-m"
PHY_UV_ANFC = "cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m"
PHY_W_ANFC = "cmems_mod_glo_phy-wcur_anfc_0.083deg_P1D-m"
PHY_2D_ANFC = "cmems_mod_glo_phy_anfc_0.083deg_P1D-m"
BGC_MY = "cmems_mod_glo_bgc_my_0.25deg_P1D-m"
BGC_PFT_ANFC = "cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m"
BGC_BIO_ANFC = "cmems_mod_glo_bgc-bio_anfc_0.25deg_P1D-m"
BGC_NUT_ANFC = "cmems_mod_glo_bgc-nut_anfc_0.25deg_P1D-m"
BGC_CAR_ANFC = "cmems_mod_glo_bgc-car_anfc_0.25deg_P1D-m"

TITLES = {
    PHY_MY: "Copernicus GLORYS12 reanalysis, 1/12°",
    PHY_T_ANFC: "Copernicus global analysis & forecast, 1/12°",
    PHY_S_ANFC: "Copernicus global analysis & forecast, 1/12°",
    PHY_UV_ANFC: "Copernicus global analysis & forecast, 1/12°",
    PHY_W_ANFC: "Copernicus global analysis & forecast, 1/12°",
    PHY_2D_ANFC: "Copernicus global analysis & forecast, 1/12°",
    BGC_MY: "Copernicus PISCES biogeochemistry reanalysis, 1/4°",
    BGC_PFT_ANFC: "Copernicus PISCES biogeochemistry analysis & forecast, 1/4°",
    BGC_BIO_ANFC: "Copernicus PISCES biogeochemistry analysis & forecast, 1/4°",
    BGC_NUT_ANFC: "Copernicus PISCES biogeochemistry analysis & forecast, 1/4°",
    BGC_CAR_ANFC: "Copernicus PISCES biogeochemistry analysis & forecast, 1/4°",
}

# Native vertical levels, the ceiling on anything we emit (hard rule 3). The stores are
# probed for their actual axis at read time; these are the declared counts, kept as the
# second, looser ceiling exactly as regrid.build_grid does for config.Source.
NATIVE_LEVELS = {PHY_MY: 50, PHY_T_ANFC: 50, PHY_S_ANFC: 50, PHY_UV_ANFC: 50, PHY_W_ANFC: 50,
                 BGC_MY: 75, BGC_PFT_ANFC: 50, BGC_BIO_ANFC: 50, BGC_NUT_ANFC: 50,
                 BGC_CAR_ANFC: 50}


@dataclass(frozen=True)
class Era:
    name: str        # "reanalysis" | "analysis-forecast"
    dataset: str
    var: str         # the dataset's own variable name


@dataclass(frozen=True)
class Variable:
    key: str
    title: str
    units: str
    palette: str               # a palette id in viewer/src/colorbar.ts
    group: str                 # "physics" | "biogeochemistry" | "surface"
    eras: tuple[Era, ...] = ()  # in preference order: reanalysis first
    depth: bool = True         # False: a 2D field (sea level, mixed layer depth, ...)
    signed: bool = False       # symmetric colour range about zero
    log: bool = False          # spans orders of magnitude; log colour scale by default
    derived: tuple[str, ...] = ()  # computed from these variables instead of read
    formula: str = ""
    note: str = ""
    # For the CF layer (cf.normalise_variable) and the range test (cf.global_range_check).
    canonical: str = ""


def _phy(var_my: str, anfc: str, var_anfc: str | None = None) -> tuple[Era, ...]:
    return (Era("reanalysis", PHY_MY, var_my), Era("analysis-forecast", anfc, var_anfc or var_my))


def _bgc(var: str, anfc: str | None) -> tuple[Era, ...]:
    eras = [Era("reanalysis", BGC_MY, var)]
    if anfc:
        eras.append(Era("analysis-forecast", anfc, var))
    return tuple(eras)


VARIABLES: dict[str, Variable] = {v.key: v for v in [
    # ---- physics, 1/12 deg, 50 levels to 5,728 m
    Variable("temperature", "Temperature", "°C", "thermal", "physics",
             _phy("thetao", PHY_T_ANFC), canonical="temperature",
             note="potential temperature, as the model reports it"),
    Variable("salinity", "Salinity", "PSU", "haline", "physics",
             _phy("so", PHY_S_ANFC), canonical="salinity"),
    Variable("u", "Eastward current", "m/s", "balance", "physics",
             _phy("uo", PHY_UV_ANFC), signed=True, canonical="u"),
    Variable("v", "Northward current", "m/s", "balance", "physics",
             _phy("vo", PHY_UV_ANFC), signed=True, canonical="v"),
    Variable("speed", "Current speed", "m/s", "speed", "physics",
             derived=("u", "v"), formula="sqrt(u² + v²)", canonical="speed"),
    Variable("w", "Vertical velocity", "m/s", "balance", "physics",
             (Era("analysis-forecast", PHY_W_ANFC, "wo"),), signed=True,
             note="upwelling positive; published only by the analysis & forecast, "
                  "from 2022"),
    Variable("density", "Density anomaly σθ", "kg/m³", "dense", "physics",
             derived=("temperature", "salinity"),
             formula="TEOS-10 gsw.sigma0(SA, CT); SA from gsw.SA_from_SP(SP, p, lon, lat), "
                     "CT from gsw.CT_from_pt(SA, θ), p from gsw.p_from_z(-depth, lat)",
             note="potential density minus 1000 kg/m³, referenced to the surface"),
    Variable("sound_speed", "Speed of sound", "m/s", "speed", "physics",
             derived=("temperature", "salinity"),
             formula="TEOS-10 gsw.sound_speed(SA, CT, p), same SA, CT and p as density",
             note="what sonar and acoustic ranging depend on; the minimum is the SOFAR "
                  "channel"),
    # ---- biogeochemistry, 1/4 deg (PISCES model)
    Variable("chlorophyll", "Chlorophyll", "mg/m³", "algae", "biogeochemistry",
             _bgc("chl", BGC_PFT_ANFC), log=True),
    Variable("oxygen", "Dissolved oxygen", "mmol/m³", "oxy", "biogeochemistry",
             _bgc("o2", BGC_BIO_ANFC)),
    Variable("nitrate", "Nitrate", "mmol/m³", "matter", "biogeochemistry",
             _bgc("no3", BGC_NUT_ANFC)),
    Variable("phosphate", "Phosphate", "mmol/m³", "matter", "biogeochemistry",
             _bgc("po4", BGC_NUT_ANFC)),
    Variable("silicate", "Silicate", "mmol/m³", "matter", "biogeochemistry",
             _bgc("si", BGC_NUT_ANFC)),
    Variable("primary_production", "Net primary production", "mg C/m³/day", "algae",
             "biogeochemistry", _bgc("nppv", BGC_BIO_ANFC), log=True),
    Variable("ph", "pH", "", "viridis", "biogeochemistry",
             (Era("analysis-forecast", BGC_CAR_ANFC, "ph"),),
             note="daily pH is published only by the analysis & forecast, from late 2021"),
    Variable("dic", "Dissolved inorganic carbon", "mol/m³", "matter", "biogeochemistry",
             (Era("analysis-forecast", BGC_CAR_ANFC, "dissic"),)),
    Variable("alkalinity", "Total alkalinity", "mol/m³", "matter", "biogeochemistry",
             (Era("analysis-forecast", BGC_CAR_ANFC, "talk"),)),
    Variable("iron", "Dissolved iron", "mmol/m³", "matter", "biogeochemistry",
             (Era("analysis-forecast", BGC_NUT_ANFC, "fe"),), log=True),
    Variable("phytoplankton", "Phytoplankton carbon", "mmol/m³", "algae", "biogeochemistry",
             (Era("analysis-forecast", BGC_PFT_ANFC, "phyc"),), log=True),
    # ---- 2D fields, for the globe
    Variable("sea_level", "Sea surface height", "m", "balance", "surface",
             _phy("zos", PHY_2D_ANFC), depth=False, signed=True,
             note="relative to the model geoid; the global mean is not zero"),
    Variable("mixed_layer", "Mixed layer depth", "m", "deep", "surface",
             _phy("mlotst", PHY_2D_ANFC), depth=False),
    Variable("bottom_temperature", "Sea floor temperature", "°C", "thermal", "surface",
             _phy("bottomT", PHY_2D_ANFC, "tob"), depth=False),
    Variable("sea_ice", "Sea ice concentration", "fraction", "ice", "surface",
             _phy("siconc", PHY_2D_ANFC), depth=False),
]}


# ------------------------------------------------------------------ era choice

@dataclass(frozen=True)
class Resolved:
    """Where one variable's values for one day actually come from."""

    variable: Variable
    era: Era
    day: str
    forecast: bool   # the day is after today: a model forecast, not an analysis

    def provenance(self) -> dict:
        return {
            "dataset": self.era.dataset,
            "source": TITLES.get(self.era.dataset, self.era.dataset),
            "era": self.era.name,
            "variable": self.era.var,
            "day": self.day,
            "forecast": self.forecast,
        }


def _coverage(dataset: str) -> tuple[str, str]:
    from . import arco
    return arco.open_store(dataset).coverage()


def resolve(key: str, day: str, today: date | None = None,
            coverage=_coverage) -> Resolved:
    """The first era whose store covers `day`. Raises if none does.

    `coverage` is injectable so the choice can be tested without the network.
    """
    variable = VARIABLES[key]
    if variable.derived:
        raise ValueError(f"{key} is derived from {variable.derived}; resolve those instead")
    for era in variable.eras:
        first, last = coverage(era.dataset)
        if first <= day <= last:
            today = today or date.today()
            return Resolved(variable, era, day, forecast=day > today.isoformat())
    spans = ", ".join(f"{e.name} {'–'.join(coverage(e.dataset))}" for e in variable.eras)
    raise LookupError(f"no {variable.title.lower()} for {day}; available: {spans}")


def base_variables(key: str) -> tuple[str, ...]:
    """The stored variables a request for `key` has to read."""
    v = VARIABLES[key]
    return tuple(b for d in v.derived for b in base_variables(d)) if v.derived else (key,)


def describe() -> dict:
    """The catalogue for /api/catalog: every variable, and each era's measured coverage.

    Opens every store it names (a few seconds each, in parallel, once per process).
    """
    datasets = sorted({e.dataset for v in VARIABLES.values() for e in v.eras})
    with ThreadPoolExecutor(max_workers=len(datasets)) as pool:
        spans = dict(zip(datasets, pool.map(lambda d: _safe_coverage(d), datasets)))
    out = []
    for v in VARIABLES.values():
        bases = [VARIABLES[b] for b in base_variables(v.key)]
        eras = [{"name": e.name, "dataset": e.dataset, "source": TITLES.get(e.dataset, ""),
                 "from": spans[e.dataset][0], "to": spans[e.dataset][1]}
                for e in bases[0].eras if spans[e.dataset]]
        out.append({
            "key": v.key, "title": v.title, "units": v.units, "palette": v.palette,
            "group": v.group, "depth": v.depth, "signed": v.signed, "log": v.log,
            "derived": list(v.derived), "formula": v.formula, "note": v.note,
            "eras": eras,
        })
    return {"variables": out, "today": date.today().isoformat()}


def _safe_coverage(dataset: str) -> tuple[str, str] | None:
    try:
        return _coverage(dataset)
    except Exception:  # noqa: BLE001 -- one unreachable store must not hide the rest
        return None


# ------------------------------------------------------------------ self-checks

def demo() -> None:
    spans = {PHY_MY: ("1993-01-01", "2026-06-23"), PHY_T_ANFC: ("2022-06-01", "2026-10-03"),
             BGC_MY: ("1993-01-01", "2026-05-31"), BGC_PFT_ANFC: ("2021-11-01", "2026-10-03"),
             BGC_CAR_ANFC: ("2021-11-01", "2026-10-03")}
    cov = spans.__getitem__
    today = date(2026, 9, 24)

    r = resolve("temperature", "2018-08-25", today, cov)
    assert r.era.dataset == PHY_MY and not r.forecast, "the reanalysis wins where it covers"
    r = resolve("temperature", "2024-01-01", today, cov)
    assert r.era.name == "reanalysis", "overlap years still prefer the reanalysis"
    r = resolve("temperature", "2026-08-01", today, cov)
    assert r.era.dataset == PHY_T_ANFC and not r.forecast, "past the reanalysis: analysis"
    r = resolve("temperature", "2026-10-01", today, cov)
    assert r.forecast, "a day after today is a forecast and must say so"
    r = resolve("chlorophyll", "2026-06-10", today, cov)
    assert r.era.dataset == BGC_PFT_ANFC, "BGC reanalysis ends earlier than physics"
    try:
        resolve("ph", "2010-01-01", today, cov)
    except LookupError as exc:
        assert "available" in str(exc)
    else:
        raise AssertionError("pH before 2021 has no daily source and must say so")
    try:
        resolve("temperature", "2027-01-01", today, cov)
    except LookupError:
        pass
    else:
        raise AssertionError("beyond the forecast horizon there is nothing")

    assert base_variables("density") == ("temperature", "salinity")
    assert base_variables("speed") == ("u", "v")
    for v in VARIABLES.values():
        assert v.eras or v.derived, f"{v.key} has no source and no derivation"
        for d in v.derived:
            assert d in VARIABLES, f"{v.key} derives from unknown {d}"
        for e in v.eras:
            assert e.dataset in TITLES, f"{e.dataset} has no title"
            if v.depth:
                assert e.dataset in NATIVE_LEVELS, f"{e.dataset} has no native level count"
    print(f"catalog ok: {len(VARIABLES)} variables")


def probe() -> None:
    import json
    print(json.dumps(describe(), indent=1)[:4000])


if __name__ == "__main__":
    probe() if "--probe" in sys.argv else demo()
