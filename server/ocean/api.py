"""The REST surface the viewer talks to.

    uvicorn server.ocean.api:app --reload

Volumes go over the wire as **raw float32**, not JSON. A 24x19x23 grid is 42 KB binary
against roughly 400 KB of JSON numerals, and the browser can hand the bytes straight to
`VoxelContent.fromMetadataArray` with no parse step. Metadata is a separate small JSON
call so the binary stays a clean typed array and both are independently cacheable.
"""

import io
from datetime import date, datetime
from functools import lru_cache

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from . import argo, cf, colocate, config, currents, glider, residual, sources, volume, wms

# Variables that exist as gridded fields but not as instrument measurements. Asking a
# float for its "observation count" is meaningless, so the in-situ side falls back to
# temperature rather than raising.
GRID_ONLY = {"observations"}


def _instrument_variable(variable: str) -> str:
    return "temperature" if variable in GRID_ONLY else variable

app = FastAPI(title="VVater — 3D ocean data", version="0.1.0")

# The viewer runs on Vite's dev server on another port during development. In a real
# INCOIS deployment both are served from the same origin and this does nothing.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# The fetched dataset is the expensive thing, not the packing. Cached by (source,
# variable, window) so scrubbing the timeline re-packs but never re-downloads.
DEFAULT_WINDOW = ("2018-07-01", "2018-10-31")


@lru_cache(maxsize=8)
def _dataset(variable: str, source_key: str, t0: str, t1: str):
    return sources.fetch(variable, t0, t1, source_key=source_key)


@lru_cache(maxsize=32)
def _volume(variable: str, source_key: str, time_index: int, t0: str, t1: str):
    ds, names = _dataset(variable, source_key, t0, t1)
    return volume.build(ds, names["value"], time_index, names.get("error"),
                        source_key, canonical=variable)


def _window(t0: str | None, t1: str | None) -> tuple[str, str]:
    return (t0 or DEFAULT_WINDOW[0], t1 or DEFAULT_WINDOW[1])


@app.get("/api/meta")
def meta(t0: str | None = None, t1: str | None = None) -> dict:
    """Everything the viewer needs to build its controls before requesting any data."""
    start, end = _window(t0, t1)
    catalogue = []
    for key, source in config.SOURCES.items():
        catalogue.append({
            "key": key,
            "title": source.title,
            "variables": sorted(source.variables),
            "hasError": bool(source.error_variables),
            "nativeLevels": source.native_levels,
            "needsCredentials": source.needs_credentials,
        })

    ds, _ = _dataset("temperature", config.DEFAULT_SOURCE, start, end)
    return {
        "region": {"name": config.REGION["name"],
                   "lon": list(config.REGION["lon"]),
                   "lat": list(config.REGION["lat"])},
        "depthRange": list(config.DEPTH_RANGE),
        "demoDate": str(config.DEMO_DATE),
        "sources": catalogue,
        "defaultSource": config.DEFAULT_SOURCE,
        "times": [str(t)[:19] for t in ds.time.values],
        "window": [start, end],
    }


@app.get("/api/volume/meta")
def volume_meta(variable: str = "temperature",
                source: str = config.DEFAULT_SOURCE,
                time_index: int = 0,
                t0: str | None = None, t1: str | None = None) -> dict:
    start, end = _window(t0, t1)
    try:
        return _volume(variable, source, time_index, start, end).as_dict()
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@app.get("/api/volume/data")
def volume_data(variable: str = "temperature",
                source: str = config.DEFAULT_SOURCE,
                time_index: int = 0,
                t0: str | None = None, t1: str | None = None) -> Response:
    """Raw float32: the value channel, then the error channel when the source has one.

    NaN is left as NaN rather than substituted. The shader tests for it and discards
    those samples, which is how land and the bathymetry mask stay empty instead of
    becoming whatever the colourbar maps zero to.
    """
    start, end = _window(t0, t1)
    try:
        packed = _volume(variable, source, time_index, start, end)
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    buffer = io.BytesIO()
    buffer.write(packed.values.tobytes())
    if packed.errors is not None:
        buffer.write(packed.errors.tobytes())

    return Response(
        content=buffer.getvalue(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@lru_cache(maxsize=8)
def _residual(variable: str, source_key: str, on: str, t0: str, t1: str):
    ds, names = _dataset(variable, source_key, t0, t1)
    centre = date.fromisoformat(on)
    casts = (argo.load_window(centre, variable) + glider.load_window(centre, variable))
    return residual.build(ds, names["value"], casts, on, source_key, canonical=variable)


@app.get("/api/residual/meta")
def residual_meta(variable: str = "temperature",
                  source: str = config.DEFAULT_SOURCE,
                  on: str | None = None,
                  t0: str | None = None, t1: str | None = None) -> dict:
    """Observed minus modelled, binned onto the grid. See server/ocean/residual.py.

    There is deliberately no time_index: the residual is a window aggregate, and
    accepting one would let the label disagree with the data it describes.
    """
    start, end = _window(t0, t1)
    centre = on or str(config.DEMO_DATE)
    try:
        packed, _ = _residual(variable, source, centre, start, end)
    except (KeyError, IndexError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return packed.as_dict()


@app.get("/api/residual/data")
def residual_data(variable: str = "temperature",
                  source: str = config.DEFAULT_SOURCE,
                  on: str | None = None,
                  t0: str | None = None, t1: str | None = None) -> Response:
    start, end = _window(t0, t1)
    centre = on or str(config.DEMO_DATE)
    packed, _ = _residual(variable, source, centre, start, end)
    return Response(content=packed.values.tobytes(),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


@lru_cache(maxsize=16)
def _streamlines(source_key: str, time_index: int, depth_index: int, t0: str, t1: str):
    source = config.SOURCES[source_key]
    if "u" not in source.variables or "v" not in source.variables:
        raise HTTPException(
            status_code=404,
            detail=(f"{source_key} has no current vectors. Only Copernicus GLORYS12 "
                    "carries uo/vo; the INCOIS Argo analyses do not."),
        )
    # One day, centred on the demo date. Currents are a snapshot, and asking Copernicus
    # for the full analysis window here is how the first version of this hung.
    day = config.DEMO_DATE.isoformat()
    ds, _ = sources.fetch_many(["u", "v"], day, day, source_key=source_key)
    return currents.streamlines(ds, source.variables["u"], source.variables["v"],
                                time_index, depth_index)


@app.get("/api/streamlines")
def streamlines(source: str = "glorys12", time_index: int = 0, depth_index: int = 0,
                t0: str | None = None, t1: str | None = None) -> dict:
    """Current streamlines on one depth level, integrated server-side (L4)."""
    start, end = _window(t0, t1)
    try:
        return _streamlines(source, time_index, depth_index, start, end)
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@app.get("/api/observations")
def observations(on: str | None = None, variable: str = "temperature") -> dict:
    """Float and glider positions for the map, with enough to draw a marker and no more.

    Full profiles are a separate call, because 147 casts x 500 levels is not something
    to send just so a dot can appear on a globe.
    """
    centre = date.fromisoformat(on) if on else config.DEMO_DATE
    variable = _instrument_variable(variable)
    out = []
    for kind, profiles in (("argo", argo.load_window(centre, variable)),
                           ("glider", glider.load_window(centre, variable))):
        for p in profiles:
            out.append({
                "kind": kind,
                "platform": p.platform,
                "lat": p.lat,
                "lon": p.lon,
                "time": str(p.time)[:19],
                "levels": int(p.depth.size),
                "levelsRejected": p.n_rejected,
                "dataMode": p.data_mode,
                "maxDepth": float(p.depth.max()),
            })
    return {"date": str(centre), "variable": variable, "count": len(out), "observations": out}


@app.get("/api/profile")
def profile(platform: str, on: str | None = None, variable: str = "temperature",
            source: str = config.DEFAULT_SOURCE,
            t0: str | None = None, t1: str | None = None) -> dict:
    """One cast, with the analysis interpolated onto it — the brief's core promise.

    Rejected levels are returned with their flags rather than filtered out, so the chart
    can draw them as rejected. Hiding them would make the QC invisible, which defeats
    the point of reading it.
    """
    centre = date.fromisoformat(on) if on else config.DEMO_DATE
    start, end = _window(t0, t1)
    variable = _instrument_variable(variable)

    found = None
    for profiles in (argo.load_window(centre, variable), glider.load_window(centre, variable)):
        for p in profiles:
            if p.platform == platform:
                found = p
                break
        if found:
            break
    if found is None:
        raise HTTPException(status_code=404, detail=f"no profile {platform!r} on {centre}")

    ds, names = _dataset(variable, source, start, end)
    comparison = colocate.colocate(found, ds, names["value"], names.get("error"),
                                   canonical=variable)

    def clean(array):
        return [None if not np.isfinite(v) else round(float(v), 4) for v in array]

    return {
        "platform": found.platform,
        "lat": found.lat,
        "lon": found.lon,
        "time": str(found.time)[:19],
        "depth": clean(comparison.depth),
        "observed": clean(comparison.observed),
        "modelled": clean(comparison.modelled),
        "accepted": [bool(v) for v in comparison.accepted],
        "qc": [str(v) for v in found.qc],
        "error": clean(comparison.error) if comparison.error is not None else None,
        "summary": {k: v for k, v in comparison.summary().items() if k != "per_profile"},
    }


@app.get("/wms")
def wms_endpoint(request: Request,
                 SERVICE: str = "WMS", REQUEST: str = "GetCapabilities",
                 LAYERS: str = "", BBOX: str = "", WIDTH: int = 512, HEIGHT: int = 512,
                 CRS: str = "EPSG:4326", TIME: str | None = None,
                 ELEVATION: float | None = None,
                 FORMAT: str = "image/png") -> Response:
    """Minimal OGC WMS 1.3.0. GetCapabilities and GetMap only — see server/ocean/wms.py.

    Parameter names are upper-case because that is what the specification says and what
    QGIS sends. WCS is deliberately absent rather than half-built.
    """
    xml = "text/xml"

    if SERVICE.upper() != "WMS":
        return Response(wms.service_exception(f"SERVICE={SERVICE} is not WMS"),
                        media_type=xml, status_code=400)

    if REQUEST.lower() == "getcapabilities":
        return Response(wms.capabilities(str(request.url).split("?")[0]), media_type=xml)

    if REQUEST.lower() != "getmap":
        return Response(
            wms.service_exception(
                f"REQUEST={REQUEST} is not supported. This service implements "
                "GetCapabilities and GetMap only.", "OperationNotSupported"),
            media_type=xml, status_code=400)

    if not CRS.upper().endswith("4326"):
        return Response(wms.service_exception(f"{CRS} unsupported; EPSG:4326 only", "InvalidCRS"),
                        media_type=xml, status_code=400)

    try:
        source_key, variable = LAYERS.split(":", 1)
    except ValueError:
        return Response(
            wms.service_exception(f"LAYERS={LAYERS!r} must be '<source>:<variable>'"),
            media_type=xml, status_code=400)

    try:
        parts = [float(v) for v in BBOX.split(",")]
        # WMS 1.3.0 with a geographic CRS orders the bbox lat-first, which is the single
        # most common source of a silently rotated map.
        min_lat, min_lon, max_lat, max_lon = parts
    except (ValueError, TypeError):
        return Response(wms.service_exception(f"BBOX={BBOX!r} is not four numbers"),
                        media_type=xml, status_code=400)

    start, end = _window(None, None)
    try:
        ds, names = _dataset(variable, source_key, start, end)
    except (KeyError, RuntimeError) as exc:
        return Response(wms.service_exception(str(exc), "LayerNotDefined"),
                        media_type=xml, status_code=400)

    z_name = "ZAX" if "ZAX" in ds.coords else "depth"
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"

    depths = np.asarray(ds[z_name].values, dtype=float)
    level = 0 if ELEVATION is None else int(np.abs(depths - ELEVATION).argmin())

    times = ds.time.values
    step = 0
    if TIME:
        step = int(np.abs(times - np.datetime64(TIME[:19])).argmin())
    else:
        step = len(times) - 1

    field = np.asarray(ds[names["value"]].isel({"time": step, z_name: level}).values, dtype=float)
    finite = field[np.isfinite(field)]
    value_range = ((float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0))

    png = wms.get_map(
        field,
        np.asarray(ds[lon_name].values, dtype=float),
        np.asarray(ds[lat_name].values, dtype=float),
        (min_lon, min_lat, max_lon, max_lat),
        max(1, min(WIDTH, 2048)), max(1, min(HEIGHT, 2048)),
        value_range,
    )
    return Response(content=png, media_type="image/png")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "region": config.REGION["name"], "demoDate": str(config.DEMO_DATE)}
