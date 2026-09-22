"""CF-convention handling, done defensively.

The real INCOIS file declares `Conventions = "CF-1.6, COARDS, ACDD-1.3"` and then gives
TEMP a `units` of `"degs"`, no `standard_name`, and no `positive` on the depth axis.
So we normalise, and we record every normalisation we had to make. Never trust the
global attribute (L8).
"""

from dataclasses import dataclass, field

# Non-UDUNITS spellings seen in real files, mapped to what they actually mean.
UNIT_ALIASES = {
    "degs": "degree_Celsius",
    "deg_c": "degree_Celsius",
    "degc": "degree_Celsius",
    "celsius": "degree_Celsius",
    "psu": "1e-3",  # practical salinity is dimensionless; PSU is the conventional label
}

STANDARD_NAMES = {
    "temperature": "sea_water_temperature",
    # Not a CF standard name, because CF has none for "how many observations went into
    # this cell". Kept distinct so the range test knows not to apply ocean limits to it.
    "observations": "number_of_observations",
    "salinity": "sea_water_practical_salinity",
    "u": "eastward_sea_water_velocity",
    "v": "northward_sea_water_velocity",
}

DISPLAY_UNITS = {
    "sea_water_temperature": "°C",
    "number_of_observations": "profiles",
    "sea_water_practical_salinity": "PSU",
    "eastward_sea_water_velocity": "m/s",
    "northward_sea_water_velocity": "m/s",
}


@dataclass
class CFReport:
    """What we had to assume. Travels with the data into the provenance record."""

    standard_name: str
    units: str
    display_units: str
    assumptions: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "standard_name": self.standard_name,
            "units": self.units,
            "display_units": self.display_units,
            "assumptions": list(self.assumptions),
        }


def normalise_variable(da, canonical: str) -> CFReport:
    """Work out what a DataArray really is, recording each guess.

    `canonical` is our own name ("temperature"), not the file's.
    """
    assumptions: list[str] = []

    raw_units = str(da.attrs.get("units", "")).strip()
    units = UNIT_ALIASES.get(raw_units.lower(), raw_units)
    if not raw_units:
        units = DISPLAY_UNITS.get(STANDARD_NAMES.get(canonical, ""), "")
        assumptions.append(f"no units attribute; assumed {units!r} from variable identity")
    elif units != raw_units:
        assumptions.append(f"units {raw_units!r} is not UDUNITS; read as {units!r}")

    std = str(da.attrs.get("standard_name", "")).strip()
    if not std:
        std = STANDARD_NAMES.get(canonical, canonical)
        assumptions.append(f"no standard_name; assumed {std!r} from variable identity")

    return CFReport(
        standard_name=std,
        units=units,
        display_units=DISPLAY_UNITS.get(std, units),
        assumptions=assumptions,
    )


def depth_sign_assumption(depth_coord) -> tuple[bool, str | None]:
    """Decide whether the vertical coordinate increases downward.

    Returns (positive_down, assumption_note). The note is None when the file actually
    told us, and a sentence when we had to guess.

    This matters more than it looks: nothing in the INCOIS file says whether 5.0 means
    5 m below the surface or 5 m above it. The physics test in
    `server/tests/test_colocate.py` is what actually pins this down (L2, V3).
    """
    positive = str(depth_coord.attrs.get("positive", "")).strip().lower()
    if positive in ("down", "up"):
        return positive == "down", None

    values = depth_coord.values
    ascending = len(values) < 2 or values[-1] >= values[0]
    all_non_negative = bool((values >= 0).all())

    note = (
        f"depth coordinate {depth_coord.name!r} has no 'positive' attribute; assumed "
        f"positive-down because values are {'non-negative and ' if all_non_negative else ''}"
        f"{'ascending' if ascending else 'descending'}"
    )
    return True, note


# Argo global range test (QC test 6) limits. These are the published operational
# thresholds, not numbers we chose, so a value outside them is indefensible whatever
# produced it.
GLOBAL_RANGE = {
    "sea_water_temperature": (-2.5, 40.0),
    "sea_water_practical_salinity": (2.0, 41.0),
}


def global_range_check(values, standard_name: str):
    """Flag physically impossible values in a *model* field.

    The brief treats model output as ground truth and QC as something you do to
    observations. It is not. The INCOIS analysis contains 24 cells at 75-100 m reading
    36-44 degC on the 2018-07-20 step — impossible at that depth in the Bay of Bengal,
    and a renderer that trusts its input paints them as a heatwave.

    Returns (mask_of_impossible_values, report). The caller masks them from the render
    and reports the count; nothing is silently clipped, and the cells are never quietly
    dropped from the record.
    """
    import numpy as np

    limits = GLOBAL_RANGE.get(standard_name)
    array = np.asarray(values, dtype=float)
    if limits is None:
        return np.zeros(array.shape, dtype=bool), {
            "checked": False,
            "reason": f"no published global range for {standard_name!r}",
        }

    lo, hi = limits
    bad = np.isfinite(array) & ((array < lo) | (array > hi))
    report = {
        "checked": True,
        "test": "Argo global range test (QC test 6)",
        "limits": [lo, hi],
        "failed": int(bad.sum()),
        "checked_cells": int(np.isfinite(array).sum()),
    }
    if bad.any():
        report["failed_range"] = [round(float(array[bad].min()), 3),
                                  round(float(array[bad].max()), 3)]
    return bad, report
