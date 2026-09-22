# Deferred — knowingly incomplete, with what it blocks

Appended to in the same pass as the shortcut, never cleaned up at the end.

| ID | What | Blocks | What it would take |
|---|---|---|---|
| ~~D-01~~ | ~~Copernicus credentials.~~ **RESOLVED 2026-09-22.** Login verified, a 23 MB Bay of Bengal subset with `uo`/`vo` fetched. `sources.py` still raises — wiring the fetch is now ordinary work, not a blocker. | — | — |
| ~~D-02~~ | ~~No glider data.~~ **RESOLVED 2026-09-22.** 112 real casts in the box from the IOOS Glider DAC, co-located and giving the independent validation number. | — | — |
| D-02b | **EGO/Coriolis GDAC not wired.** 184 gliders over THREDDS — the archive the brief's dead FTP link served. No spatial index. | A second glider source, and the ability to say we read INCOIS's own cited archive. | Walk the 184 per-glider catalogues once, cache a lat/lon index. |
| D-08 | **Model fields have no depth-aware range test.** The published global range test catches 6 of 24 impossible cells; 18 between 35-40 degC pass it. | Silent rendering of physically impossible water. | A published source for depth-dependent limits. Logged in `10-unsourced.md` rather than invented. |
| D-03 | **`VoxelPrimitive` is `@experimental`** in CesiumJS — breaking changes without deprecation. | Nothing yet; will break silently on a Cesium bump. | `@cesium/engine` and `@cesium/widgets` are pinned exactly. Re-test the volume on every upgrade; voxel rendering fails silently, not loudly. |
| D-09 | **The two Cesium packages must be bumped together.** The `cesium` wrapper was dropped because its `@cesium/engine` range and the one `@cesium/widgets` wants disagreed, so npm nested a *second* engine. Two engines means two `ContextLimits`: the Viewer populates one, `VoxelPrimitive` reads the other, and the volume renders as nothing with no error. | Any dependency bump. | Bump both, then check `find node_modules -path "*@cesium/engine/package.json"` returns exactly one line. This cost most of a day. |
| D-10 | **Colourbar is a six-stop ramp evaluated in the shader**, not a 256-entry lookup texture. `CustomShader` texture uniforms need context limits that are not populated when a `VoxelPrimitive` first updates. | Fine fidelity on sharply non-linear palettes. | Raise the stop count (edit `RAMP_STOPS` and the GLSL together), or revisit the texture path if Cesium changes the ordering. |
| D-11 | **One tile, no streaming.** `OceanVoxelProvider` holds the whole volume in memory and `maximumTileCount` is 1. | Copernicus resolution (2.85 M voxels) and long time animations (L1). | Tile the provider and drive an LRU cache from the Cesium clock. |
| D-04 | **BGC / chlorophyll not ingested.** It lives in separate Argo `Sprof` files, not the core profile files. | The chlorophyll variable the brief names. | A second fetch path in `argo.py` against the `Sprof` index. |
| D-05 | **WCS not implemented**, only minimal WMS is planned. | An OGC claim we have chosen not to make (L8). | Nothing — this is deliberate. It stays here so it is never claimed by accident. |
| D-06 | **TLS: INCOIS serves only its leaf certificate.** `truststore` routes verification through the OS store, which chases the AIA extension. | Nothing on Windows. May fail on a Linux deployment where OpenSSL does not chase AIA. | Bundle the intermediate and point `REQUESTS_CA_BUNDLE` at it. Never `verify=False`. |
| D-07 | **Argo window fetch is 32 s cold** — 11 day-files at ~8.7 MB. | Interactive time-scrubbing over observations. | Fetch concurrently, or cache a slimmed region-only extract per day. |
