# Unsourced — values we could not source, and where the real one comes from

Anything here is structurally present and visibly unsourced. Never quoted as fact.

| Value | Status | Where the real one comes from |
|---|---|---|
| Glider per-level QC | The DAC declares `qartod_temperature_primary_flag` and leaves it **entirely empty** for `ru29-20180812T0220` — its history says the QARTOD standard changed in 2022 and this is 2018 data. Carried as `data_mode = 'U'` (unevaluated), never as passing. | A deployment with populated QARTOD flags, or the EGO/Coriolis copy of the same mission (D-02b). |
| Depth-aware range limits for model fields | **Needed and unsourced.** The published global range test (-2.5 to 40 degC) is depth-blind and misses 18 of 24 impossible cells. | A published depth-dependent range table. Not invented here — see `13-eval-results.md`. |
| `TEMP` standard name | Assumed `sea_water_temperature`. The file gives none. | CF standard name table; confirm against INCOIS's own product documentation. |
| `TEMP` units | File says `"degs"`, which is not UDUNITS. Read as `degree_Celsius`. | Confirmed by value range (2.57–31.85), but INCOIS should state it. |
| `ZAX` depth sign | No `positive` attribute. Assumed positive-down. | Pinned by physics in `server/tests/test_colocate.py`, not by metadata. Ask INCOIS to add the attribute. |
| Analysis assimilation window | Inferred from `T_BOXOBS` counts (28–30/step vs ~20 for a strict 10-day bucket). | The VAM / Kessler-McCreary method papers, or INCOIS directly. |
| cmocean palettes (`thermal`, `haline`) | **Approximated** from published anchor points and then resampled to six stops for the shader, not the full published lookup tables. | The cmocean package (Thyng et al. 2016). Worth replacing before anything is published as a figure. |
| Current vectors | Not available in any INCOIS Argo analysis. | **Resolved** — Copernicus GLORYS12 `uo`/`vo`, verified working 2026-09-22. |
| TCHP reference density | Fixed **1025 kg/m³** (`heat.RHO`). A convention, not a measurement; the upper-150 m density of this basin varies by well under 1 %. | TEOS-10 `gsw.rho` per level from the cast's own salinity, when every source carries salinity. |
| TCHP heat capacity | **3991.868 J/(kg K)**, TEOS-10 `cp0` (IOC, SCOR and IAPSO 2010). `gsw` 3.6 does not export it, so it is typed in `heat.CP0`. | The TEOS-10 manual. Operational TCHP products differ in the constant they use; INCOIS's own choice should be matched before comparing numbers with theirs. |
| TCHP above the shallowest level | The top value is carried to the surface (mixed-layer assumption). Glider casts start near 11 m. | Nothing better exists without a sensor at the surface; stated on every record. |
| Text-file units | Temperature read as °C, salinity as PSS-78. A text file carries no reliable unit; the assumption is returned with every upload. | The uploader. |
