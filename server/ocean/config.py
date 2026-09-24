"""Every number that fixes the shape of the system lives here and nowhere else.

Read `docs/03-limitations.md` before changing anything in this file. Most of these
values are not preferences — they are consequences of measurements recorded in
`docs/05-data-sources.md`.
"""

from dataclasses import dataclass, field
from datetime import date

# ---------------------------------------------------------------- region

# Bay of Bengal. Fixes the volume budget (L1) and therefore everything downstream.
REGION = {"name": "Bay of Bengal", "lon": (78.0, 100.0), "lat": (5.0, 23.0)}

# Depth range rendered by default. The INCOIS analyses stop at 2000 m.
DEPTH_RANGE = (5.0, 2000.0)

# ---------------------------------------------------------------- float pairing

# Floats are paired to a gridded analysis step by +/- this many days (L6).
#
# The analysis cadence is 10 days, which suggests a 10-day bucket. It is not: the
# McCreary product's own T_BOXOBS counts 28-30 profiles per step over this box against
# ~20 for a strict 10-day bucket, so the analysis assimilates a window wider than its
# cadence. We display the window we can defend and record the discrepancy.
FLOAT_PAIRING_DAYS = 5.0
FLOAT_PAIRING_NOTE = (
    "Display window is +/-5 days centred on the analysis timestamp. The analysis's own "
    "assimilation window is wider: T_BOXOBS = 28-30 profiles/step over this region "
    "against ~20 profiles in a strict 10-day bucket (measured 2026-09-22)."
)

# ---------------------------------------------------------------- demo date

# The one date where all four sources are simultaneously present over this region:
#   INCOIS VAM analysis steps at 2018-08-20 and 2018-08-30
#   Argo day-files throughout
#   glider ru29 flying inside the box 2018-08-12 to 2018-09-02 (its densest weeks)
#   GLORYS12 reanalysis (covers 1993-2021)
# Chosen by measurement, not by preference. Change it and you probably lose the glider.
DEMO_DATE = date(2018, 8, 25)

# IOOS Glider DAC deployments with data inside REGION. Found by filtering all 2562
# datasets in that DAC by bounding box; only these two intersect the Indian Ocean, and
# only the second flies inside the Bay of Bengal box.
GLIDER_DEPLOYMENTS = ["ru29-20180812T0220"]

# Argo QC flags we accept. 1 good, 2 probably good, 5 changed, 8 interpolated.
# Everything else is kept and marked rejected, never dropped (L5).
QC_ACCEPT = frozenset("1258")


# ---------------------------------------------------------------- sources


@dataclass(frozen=True)
class Source:
    """One gridded field provider.

    `native_levels` is the hard ceiling on regrid output (L2/V1): we never emit more
    depth levels than the source actually has, because that invents thermocline
    structure that is not in the data.
    """

    id: str
    title: str
    kind: str  # which parser in sources.PARSERS handles it
    native_levels: int
    variables: dict[str, str]  # our name -> the source's variable name
    error_variables: dict[str, str] = field(default_factory=dict)  # our name -> error var
    needs_credentials: bool = False


SOURCES: dict[str, Source] = {
    # Primary. INCOIS's own product, no account, ships per-cell error (L10).
    "incois_vam": Source(
        id="incois_argo_10d_VAM",
        title="INCOIS Argo 10-day, Variational Analysis",
        kind="erddap",
        native_levels=24,
        variables={"temperature": "TEMP", "salinity": "SAL"},
        error_variables={"temperature": "TERR", "salinity": "SERR"},
    ),
    "incois_mccreary": Source(
        id="incois_argo_10day_McCreary",
        title="INCOIS Argo 10-day, Kessler-McCreary Analysis",
        kind="erddap",
        native_levels=24,
        # "observations" is not a physical field and the brief never asks for it, but
        # the product ships it: T_BOXOBS counts how many profiles fell inside each 1x1
        # cell. Rendered as a volume it shows where the analysis is informed by data and
        # where it is interpolating between distant floats -- which is the honest answer
        # to "how much should I trust this?" and costs one line to expose.
        variables={"temperature": "T_ANALYZED", "salinity": "S_ANALYZED",
                   "observations": "T_BOXOBS"},
        error_variables={"temperature": "T_RMSE", "salinity": "S_RMSE"},
    ),
    # Secondary. Higher resolution and the only source with currents (L4).
    # shortcut: declared but not wired until credentials exist; model.py raises if used.
    "glorys12": Source(
        id="cmems_mod_glo_phy_my_0.083deg_P1D-m",
        title="Copernicus GLORYS12 reanalysis",
        kind="copernicus",
        native_levels=50,
        variables={
            "temperature": "thetao",
            "salinity": "so",
            "u": "uo",
            "v": "vo",
        },
        needs_credentials=True,
    ),
}

DEFAULT_SOURCE = "incois_vam"

# ---------------------------------------------------------------- scenarios

# Named places and days the viewer offers as starting points, and that
# `python -m server.tools.warm_scenarios` pre-fetches so they open instantly offline.
# Each is chosen for a physical reason stated in `why`. Descriptions stay qualitative:
# any number said about them must come from the eval harness (hard rule 1).
# Boxes are (lon0, lon1, lat0, lat1); lon1 past 180 crosses the antimeridian.


@dataclass(frozen=True)
class Scenario:
    key: str
    title: str
    box: tuple[float, float, float, float]
    day: str
    variable: str
    depth_max: float
    why: str


SCENARIOS: list[Scenario] = [
    Scenario("bay_of_bengal", "Bay of Bengal", (78, 100, 5, 23), DEMO_DATE.isoformat(),
             "temperature", 2000,
             "The flagship: INCOIS analysis, Argo floats, a glider and GLORYS12 all present "
             "on this one day, which is what the co-location results are measured on."),
    Scenario("amphan_before", "Cyclone Amphan, before", (80, 95, 5, 23), "2020-05-14",
             "temperature", 300,
             "The Bay two days before Amphan formed (16 May 2020): the warm upper ocean a "
             "cyclone draws its energy from."),
    Scenario("amphan_after", "Cyclone Amphan, after", (80, 95, 5, 23), "2020-05-22",
             "temperature", 300,
             "Two days after landfall (20 May 2020): compare the upper ocean with the day "
             "before the storm to look for the cooling a cyclone leaves behind it."),
    Scenario("arabian_sea", "Arabian Sea oxygen minimum", (50, 78, 5, 25), "2019-10-15",
             "oxygen", 1500,
             "One of the largest oxygen-poor layers in the world ocean sits a few hundred "
             "metres down here, under productive surface water."),
    Scenario("gulf_stream", "Gulf Stream", (-80, -50, 30, 45), "2020-02-15", "temperature",
             2000,
             "A western boundary current: warm water carried north against cold slope water, "
             "with eddies shed on both sides."),
    Scenario("kuroshio", "Kuroshio", (125, 155, 25, 42), "2020-02-15", "temperature", 2000,
             "The Pacific's western boundary current, the counterpart of the Gulf Stream."),
    Scenario("agulhas", "Agulhas retroflection", (10, 35, -45, -30), "2019-07-15",
             "temperature", 2000,
             "Where the Agulhas Current turns back on itself south of Africa and sheds "
             "rings of Indian Ocean water into the Atlantic."),
    Scenario("el_nino", "Equatorial Pacific, El Niño 2015", (170, 270, -10, 10),
             "2015-12-01", "temperature", 500,
             "The equatorial Pacific during the strong 2015-16 El Niño: the thermocline "
             "along the equator is the thing to look at from the side."),
    Scenario("drake_passage", "Drake Passage", (-75, -50, -65, -52), "2019-02-15",
             "temperature", 4000,
             "The Antarctic Circumpolar Current squeezed between South America and "
             "Antarctica: fronts that reach the sea floor."),
]

# ---------------------------------------------------------------- endpoints

ERDDAP_BASE = "https://erddap.incois.gov.in/erddap"
ARGO_GDAC_BASE = "https://data-argo.ifremer.fr"
ARGO_BASIN = "indian_ocean"

# Copernicus is ~15 MB per day for two variables over this region against 0.55 MB for
# thirteen INCOIS timesteps, so a window that is merely generous for one source is
# catastrophic for the other: the default four-month window would be roughly 1.8 GB.
# Any Copernicus request is truncated to this many days from its start.
COPERNICUS_MAX_DAYS = 2

# Network timeouts, seconds. The measured fetches were 0.9 s (ERDDAP subset) and
# 3.7 s (8.7 MB Argo day-file); these are generous multiples of that.
HTTP_TIMEOUT = 120
