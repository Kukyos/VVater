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
| Current vectors | Not available in any INCOIS Argo analysis. | **Resolved** — Copernicus GLORYS12 `uo`/`vo`, verified working 2026-09-22. |
