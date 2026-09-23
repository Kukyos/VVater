"""Tropical cyclone heat potential: the residual in the unit a cyclone forecaster uses.

The 20 degC isotherm preset shows *where* the warm water is. The number an intensity
forecast actually consumes is how much heat sits above the 26 degC isotherm, the
threshold below which the ocean stops feeding a cyclone:

    TCHP = rho * cp * integral from the surface to D26 of (T - 26) dz

(Leipper and Volgenau 1972, J. Phys. Oceanogr. 2, 218-224; the "hurricane heat
potential"). Reported in kJ/cm^2, the unit the operational products use.

Computed from the co-located pair, on the *same levels*: the observation's accepted
levels and the analysis interpolated onto them. So "the analysis is 1.9 degC warm at 93 m"
becomes "the analysis over- or under-states the heat available to a cyclone here by N
kJ/cm^2" — the same finding, in the currency of the Disaster Management theme.

Constants (both in docs/10-unsourced.md, because neither is ours to choose silently):
    cp  = 3991.86795711963 J/(kg K)  TEOS-10 cp0, the defined heat capacity for ocean
                                     heat content (IOC, SCOR and IAPSO 2010)
    rho = 1025 kg/m^3                a fixed reference density; the real value in the
                                     upper 150 m of this basin varies by well under 1 %

What it refuses:
  * A cast that never cools to 26 degC has no D26; its TCHP is unknown, not "at least".
  * Above the shallowest level the top value is carried to the surface (a mixed-layer
    assumption), and the result says so.
"""

import numpy as np

CP0 = 3991.86795711963  # J kg-1 K-1, TEOS-10
RHO = 1025.0  # kg m-3
THRESHOLD = 26.0  # degC
J_PER_M2_TO_KJ_PER_CM2 = 1e-7

SURFACE_NOTE = "top level carried to the surface (mixed-layer assumption)"


def tchp(depth: np.ndarray, temperature: np.ndarray) -> tuple[float, float]:
    """(TCHP in kJ/cm^2, D26 in m) for one column. NaN, NaN when D26 is not reached."""
    ok = np.isfinite(depth) & np.isfinite(temperature)
    z, t = np.asarray(depth, float)[ok], np.asarray(temperature, float)[ok]
    if z.size < 2:
        return float("nan"), float("nan")
    order = np.argsort(z)
    z, t = z[order], t[order]

    below = np.flatnonzero(t < THRESHOLD)
    if below.size == 0:
        return float("nan"), float("nan")  # never cools to 26: D26 unknown
    k = below[0]
    if k == 0:
        return 0.0, 0.0  # already below 26 at the top: no fuel
    # The crossing, linear between the last warm level and the first cool one.
    d26 = z[k - 1] + (THRESHOLD - t[k - 1]) * (z[k] - z[k - 1]) / (t[k] - t[k - 1])

    zz = np.concatenate([[0.0], z[:k], [d26]])
    tt = np.concatenate([[t[0]], t[:k], [THRESHOLD]])
    excess = np.trapezoid(tt - THRESHOLD, zz)  # K m
    return float(RHO * CP0 * excess * J_PER_M2_TO_KJ_PER_CM2), float(d26)


def compare(comparison) -> dict:
    """Observed vs analysis TCHP for one colocate.Comparison, on shared levels."""
    both = (comparison.accepted & np.isfinite(comparison.observed)
            & np.isfinite(comparison.modelled))
    z = comparison.depth[both]
    obs, obs_d26 = tchp(z, comparison.observed[both])
    mod, mod_d26 = tchp(z, comparison.modelled[both])
    return {
        "observed_kj_cm2": None if np.isnan(obs) else round(obs, 2),
        "analysis_kj_cm2": None if np.isnan(mod) else round(mod, 2),
        "difference_kj_cm2": (None if np.isnan(obs) or np.isnan(mod)
                              else round(mod - obs, 2)),
        "observed_d26_m": None if np.isnan(obs_d26) else round(obs_d26, 1),
        "analysis_d26_m": None if np.isnan(mod_d26) else round(mod_d26, 1),
        "levels": int(both.sum()),
        "notes": [SURFACE_NOTE, f"rho {RHO} kg/m3, cp {CP0:.3f} J/(kg K) (TEOS-10 cp0)"],
    }


def demo() -> None:
    """Checked against integrals done by hand."""
    # 30 degC at the surface falling linearly to 26 at 100 m and on down:
    # excess = 4 K * 100 m / 2 = 200 K m.
    z = np.array([0.0, 50.0, 100.0, 150.0])
    t = np.array([30.0, 28.0, 26.0, 24.0])
    q, d26 = tchp(z, t)
    want = RHO * CP0 * 200.0 * J_PER_M2_TO_KJ_PER_CM2
    assert abs(d26 - 100.0) < 1e-9, d26
    assert abs(q - want) < 1e-9, (q, want)

    # A 30 m mixed layer at 29 degC, then 1 degC per 10 m: D26 = 60 m, and the excess is
    # the 30 x 3 rectangle plus the 30 x 3 / 2 triangle = 135 K m. The top sample is at
    # 5 m, so the surface-carry assumption is exercised too.
    z = np.array([5.0, 30.0, 40.0, 50.0, 60.0, 70.0])
    t = np.array([29.0, 29.0, 28.0, 27.0, 26.0, 25.0])
    q, d26 = tchp(z, t)
    assert abs(d26 - 60.0) < 1e-9 and abs(q - RHO * CP0 * 135.0 * 1e-7) < 1e-9, (q, d26)

    # Never cools to 26: unknown, not zero and not a lower bound.
    assert np.isnan(tchp(np.array([0.0, 20.0]), np.array([29.0, 28.0]))[0])
    # Already cold: no fuel.
    assert tchp(np.array([0.0, 20.0]), np.array([25.0, 20.0])) == (0.0, 0.0)
    print(f"heat ok: linear column {want:.2f} kJ/cm2 at D26 100 m, mixed layer + gradient "
          f"{q:.2f} kJ/cm2 at D26 {d26:.0f} m")


if __name__ == "__main__":
    demo()
