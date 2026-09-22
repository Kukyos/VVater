# Deferred — knowingly incomplete, with what it blocks

Appended to in the same pass as the shortcut, never cleaned up at the end.

| ID | What | Blocks | What it would take |
|---|---|---|---|
| ~~D-01~~ | ~~Copernicus credentials.~~ **RESOLVED 2026-09-22.** Login verified, a 23 MB Bay of Bengal subset with `uo`/`vo` fetched. `sources.py` still raises — wiring the fetch is now ordinary work, not a blocker. | — | — |
| ~~D-02~~ | ~~No glider data.~~ **RESOLVED 2026-09-22.** 112 real casts in the box from the IOOS Glider DAC, co-located and giving the independent validation number. | — | — |
| D-02b | **EGO/Coriolis GDAC not wired.** 184 gliders over THREDDS — the archive the brief's dead FTP link served. No spatial index. | A second glider source, and the ability to say we read INCOIS's own cited archive. | Walk the 184 per-glider catalogues once, cache a lat/lon index. |
| D-08 | **Model fields have no depth-aware range test.** The published global range test catches 6 of 24 impossible cells; 18 between 35-40 degC pass it. | Silent rendering of physically impossible water. | A published source for depth-dependent limits. Logged in `10-unsourced.md` rather than invented. |
| D-03 | **`VoxelPrimitive` is `@experimental`** in CesiumJS — breaking changes without deprecation. | Nothing yet; will break silently on a Cesium bump. | Pin the exact version in `viewer/package.json` and re-test on every upgrade. |
| D-04 | **BGC / chlorophyll not ingested.** It lives in separate Argo `Sprof` files, not the core profile files. | The chlorophyll variable the brief names. | A second fetch path in `argo.py` against the `Sprof` index. |
| D-05 | **WCS not implemented**, only minimal WMS is planned. | An OGC claim we have chosen not to make (L8). | Nothing — this is deliberate. It stays here so it is never claimed by accident. |
| D-06 | **TLS: INCOIS serves only its leaf certificate.** `truststore` routes verification through the OS store, which chases the AIA extension. | Nothing on Windows. May fail on a Linux deployment where OpenSSL does not chase AIA. | Bundle the intermediate and point `REQUESTS_CA_BUNDLE` at it. Never `verify=False`. |
| D-07 | **Argo window fetch is 32 s cold** — 11 day-files at ~8.7 MB. | Interactive time-scrubbing over observations. | Fetch concurrently, or cache a slimmed region-only extract per day. |
