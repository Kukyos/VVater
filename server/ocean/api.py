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
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from . import (argo, assistant, catalog, cf, colocate, config, cube, cubecasts, currents, fishing,
               glider, globalsurface, heat, marine, residual, sources, surface, textcast,
               volume, wms)

# Variables that exist as gridded fields but not as instrument measurements. Asking a
# float for its "observation count" is meaningless, so the in-situ side falls back to
# temperature rather than raising.
GRID_ONLY = {"observations"}


def _instrument_variable(variable: str) -> str:
    return "temperature" if variable in GRID_ONLY else variable

app = FastAPI(title="VVater — 3D ocean data", version="0.1.0")


# Registered before CORS on purpose: Starlette makes the last-added middleware the
# outermost, so CORS wraps this one and even a crash reaches the browser as a readable
# 500. The other way round, every server error showed up in the viewer as a bare
# "Failed to fetch" with the real message only in the server log.
@app.middleware("http")
async def _errors_as_json(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001 -- the log keeps the traceback
        import traceback
        traceback.print_exc()
        return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)


# The viewer runs on Vite's dev server on another port during development, and on a
# separate Vercel host in production (Vercel preview deploys get a random *.vercel.app
# subdomain each time, so ALLOWED_ORIGIN_REGEX covers those; ALLOWED_ORIGINS covers the
# fixed production domain). Falls back to local dev origins when unset.
import os

_extra_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    # 5173 is `npm run dev`, 4173 is `npm run preview` (the production build). Preview
    # was missing, so the built viewer could not reach the API at all.
    allow_origins=[f"http://{host}:{port}" for host in ("localhost", "127.0.0.1")
                   for port in (5173, 4173)] + _extra_origins,
    allow_origin_regex=os.environ.get("ALLOWED_ORIGIN_REGEX"),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
# Cubes are megabytes of float32 with large NaN runs (land, below the sea floor), which
# compress well; the old 42 KB INCOIS volume never needed this.
app.add_middleware(GZipMiddleware, minimum_size=4096)

# The fetched dataset is the expensive thing, not the packing. Cached by (source,
# variable, window) so scrubbing the timeline re-packs but never re-downloads.
DEFAULT_WINDOW = ("2018-07-01", "2018-10-31")


@lru_cache(maxsize=8)
def _dataset(variable: str, source_key: str, t0: str, t1: str):
    return sources.fetch(variable, t0, t1, source_key=source_key)


@lru_cache(maxsize=32)
def _volume(variable: str, source_key: str, time_index: int, t0: str, t1: str):
    if config.SOURCES[source_key].kind == "copernicus":
        # The time slider is built from the default source's analysis dates. GLORYS is
        # daily and capped at COPERNICUS_MAX_DAYS per request, so indexing its own short
        # window with that slider position asked for step 6 of a 3-step file. Fetch the
        # one day the slider is showing instead.
        base, _ = _dataset("temperature", config.DEFAULT_SOURCE, t0, t1)
        day = str(base.time.values[time_index])[:10]
        t0, t1, time_index = day, day, 0
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
def _streamlines(source_key: str, time_index: int, depth_m: float):
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
    # Asked for in metres, resolved to the nearest native level here. The viewer's slice
    # slider indexes the INCOIS grid (24 levels) and GLORYS has 36, so passing the raw
    # index drew currents from one depth under a label from another (hard rule 4).
    z_name = "depth" if "depth" in ds.coords else "ZAX"
    depth_index = int(np.abs(np.asarray(ds[z_name].values, dtype=float) - depth_m).argmin())
    return currents.streamlines(ds, source.variables["u"], source.variables["v"],
                                time_index, depth_index)


@app.get("/api/streamlines")
def streamlines(source: str = "glorys12", time_index: int = 0,
                depth_m: float = 0.0) -> dict:
    """Current streamlines at the native level nearest depth_m, integrated server-side (L4).
    The response's depth_m is the level actually used; label and place from that."""
    try:
        return _streamlines(source, time_index, round(depth_m, 1))
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@app.get("/api/global/layers")
def global_layers() -> dict:
    """The whole-Earth surface layers and the dates they step through (globalsurface.py)."""
    return {
        "days": globalsurface.days(),
        "layers": [{"key": l.key, "title": l.title, "units": l.units, "palette": l.palette,
                    "note": l.note} for l in globalsurface.LAYERS.values()],
        "cached": [d for d in globalsurface.days() if globalsurface.path_for(d).exists()],
    }


def _global(layer: str, day: str | None):
    if layer not in globalsurface.LAYERS:
        raise HTTPException(404, f"no global layer {layer!r}; see /api/global/layers")
    try:
        return globalsurface.surface(day or config.DEMO_DATE.isoformat(), layer)
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc


@app.get("/api/global/meta")
def global_meta(layer: str = "temperature", day: str | None = None) -> dict:
    """One layer on one day. Surface only."""
    return _global(layer, day).meta()


@app.get("/api/global/data")
def global_data(layer: str = "temperature", day: str | None = None) -> Response:
    """Raw float32, north row first, NaN over land. Shape from /api/global/meta."""
    return Response(content=_global(layer, day).values.tobytes(),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


@lru_cache(maxsize=1)
def _catalog(today: str) -> dict:
    return catalog.describe()


@app.get("/api/catalog")
def catalog_endpoint() -> dict:
    """Every variable the cube can show, and each source era's measured time coverage.
    Rebuilt once a day, because the stores grow by a day every day."""
    return {**_catalog(date.today().isoformat()),
            "scenarios": [{"key": s.key, "title": s.title, "box": list(s.box), "day": s.day,
                           "variable": s.variable, "depthMax": s.depth_max, "why": s.why}
                          for s in config.SCENARIOS]}


def _cube(variable: str, lon0: float, lon1: float, lat0: float, lat1: float, day: str,
          depth_max: float) -> "cube.Cube":
    if variable not in catalog.VARIABLES:
        raise HTTPException(404, f"no variable {variable!r}; see /api/catalog")
    try:
        box = cube.Box.parse(lon0, lon1, lat0, lat1)
        return cube.build(variable, box, day, float(min(max(depth_max, 0.0), 6000.0)))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/cube/meta")
def cube_meta(variable: str, lon0: float, lon1: float, lat0: float, lat1: float, day: str,
              depth_max: float = 6000.0) -> dict:
    """One variable, one day, one box, surface to depth_max, on native levels (cube.py)."""
    return _cube(variable, lon0, lon1, lat0, lat1, day, depth_max).meta()


@app.get("/api/cube/data")
def cube_data(variable: str, lon0: float, lon1: float, lat0: float, lat1: float, day: str,
              depth_max: float = 6000.0) -> Response:
    """float32 values (depth, lat, lon; shallow and south first, x fastest), then float32
    sea-floor depth (lat, lon). NaN is land or below the sea floor."""
    c = _cube(variable, lon0, lon1, lat0, lat1, day, depth_max)
    # A forecast day is rewritten by every new model run; history is not.
    cache = "public, max-age=3600" if c.provenance["forecast"] else "public, max-age=86400"
    return Response(content=c.payload(), media_type="application/octet-stream",
                    headers={"Cache-Control": cache})


def _surface(variable: str, day: str, depth: float):
    if variable not in catalog.VARIABLES:
        raise HTTPException(404, f"no variable {variable!r}; see /api/catalog")
    try:
        return surface.level(variable, day, round(float(depth), 1))
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/surface/meta")
def surface_meta(variable: str, day: str, depth: float = 0.0) -> dict:
    """One level of any variable, the whole ocean, 1/4 deg (surface.py)."""
    return _surface(variable, day, depth).meta()


@app.get("/api/surface/data")
def surface_data(variable: str, day: str, depth: float = 0.0) -> Response:
    """float32 (lat, lon), south row first, NaN on land."""
    s = _surface(variable, day, depth)
    return Response(content=np.ascontiguousarray(s.values).tobytes(),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


def _currents(day: str, depth: float) -> dict:
    try:
        return surface.currents(day, round(float(depth), 1))
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/surface/currents/meta")
def surface_currents_meta(day: str, depth: float = 0.0) -> dict:
    return _currents(day, depth)["meta"]


@app.get("/api/surface/currents/data")
def surface_currents_data(day: str, depth: float = 0.0) -> Response:
    """float32 u then float32 v, (lat, lon) south row first, 0 on land."""
    c = _currents(day, depth)
    return Response(content=c["u"].tobytes() + c["v"].tobytes(),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


def _wind(day: str) -> dict:
    try:
        return marine.wind(day)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/wind/meta")
def wind_meta(day: str) -> dict:
    return _wind(day)["meta"]


@app.get("/api/wind/data")
def wind_data(day: str) -> Response:
    """float32 u then float32 v, 10 m wind at 12:00 UTC, (lat, lon) south row first."""
    w = _wind(day)
    return Response(content=w["u"].tobytes() + w["v"].tobytes(),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


@lru_cache(maxsize=8)
def _fishing(box: "cube.Box", day: str) -> dict:
    return fishing.assess(box, day)


@app.get("/api/fishing")
def fishing_zones(lon0: float, lon1: float, lat0: float, lat1: float, day: str) -> dict:
    """Indicative fishing zones and sea state over a box (fishing.py). Not an advisory."""
    try:
        return _fishing(cube.Box.parse(lon0, lon1, lat0, lat1), day)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@lru_cache(maxsize=16)
def _cube_currents(box: "cube.Box", day: str, depth: float) -> dict:
    return surface.regional_currents(box, day, depth)


def _cube_currents_checked(lon0, lon1, lat0, lat1, day, depth) -> dict:
    try:
        return _cube_currents(cube.Box.parse(lon0, lon1, lat0, lat1), day, round(depth, 1))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/cube/currents/meta")
def cube_currents_meta(lon0: float, lon1: float, lat0: float, lat1: float, day: str,
                       depth: float = 0.0) -> dict:
    return _cube_currents_checked(lon0, lon1, lat0, lat1, day, depth)["meta"]


@app.get("/api/cube/currents/data")
def cube_currents_data(lon0: float, lon1: float, lat0: float, lat1: float, day: str,
                       depth: float = 0.0) -> Response:
    """float32 u then v over the cube's box at the native level nearest `depth`."""
    c = _cube_currents_checked(lon0, lon1, lat0, lat1, day, depth)
    return Response(content=c["u"].tobytes() + c["v"].tobytes(),
                    media_type="application/octet-stream",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/cube/casts")
def cube_casts(variable: str, lon0: float, lon1: float, lat0: float, lat1: float, day: str,
               depth_max: float = 2000.0) -> dict:
    """Argo casts inside a cube's box around its day, for drawing (cubecasts.py). Every
    cast carries its QC flags, data mode and source file (hard rule 2)."""
    try:
        box = cube.Box.parse(lon0, lon1, lat0, lat1)
        return cubecasts.casts(variable, box, day, depth_max)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.get("/api/cube/profile")
def cube_profile(variable: str, platform: str, cycle: int, lon0: float, lon1: float,
                 lat0: float, lat1: float, day: str, depth_max: float = 2000.0) -> dict:
    """One cast against the cube's model on the cast's own day, through colocate.py."""
    try:
        box = cube.Box.parse(lon0, lon1, lat0, lat1)
        return cubecasts.compare(variable, platform, cycle, box, day, depth_max)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/api/chat")
async def chat(request: Request) -> dict:
    """The assistant (assistant.py). Body: {messages: [{role, content}], context: {...}}.

    Answers carry the tools that were called, any interface actions the model proposed
    (already whitelisted), and any numbers that could not be traced to a tool result.
    503 when the model is unreachable: the viewer shows that and carries on.
    """
    body = await request.json()
    try:
        return assistant.run(body.get("messages", []), body.get("context"))
    except assistant.AssistantUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Casts uploaded as delimited text, kept as the raw text and parsed per variable on use.
# In memory and per server process: an upload is for looking at, not an archive. Capped,
# because this is the one endpoint that takes arbitrary bytes from a client.
_UPLOADS: dict[str, str] = {}
# The assumptions the parser made for each file (units, pressure->depth, ...). Hard rule 5:
# they travel with the casts to the profile panel, not just back to the uploader.
_UPLOAD_NOTES: dict[str, list[str]] = {}
UPLOAD_MAX_BYTES = 10_000_000
UPLOAD_MAX_FILES = 8


def _uploaded(variable: str) -> list[argo.Profile]:
    out = []
    for name, text in _UPLOADS.items():
        try:
            out.extend(textcast.read_text(text, variable, source_name=name)[0])
        except textcast.TextCastError:
            continue  # e.g. a temperature-only file asked for salinity
    return out


@app.post("/api/casts")
async def upload_casts(request: Request, name: str = "upload.csv") -> dict:
    """Add casts from a delimited-text file (CSV, TSV, whitespace). See textcast.py.

    The brief asks for new observational streams to be ingestible "without significant
    re-engineering"; this is that, end to end: the casts appear on the globe, and clicking
    one co-locates it against the analysis like any float. Every cast is data_mode 'U'.
    """
    body = await request.body()
    if len(body) > UPLOAD_MAX_BYTES:
        raise HTTPException(413, f"file is {len(body)} bytes; the limit is {UPLOAD_MAX_BYTES}")
    if len(_UPLOADS) >= UPLOAD_MAX_FILES and name not in _UPLOADS:
        raise HTTPException(409, f"{UPLOAD_MAX_FILES} files already uploaded; restart to clear")
    text = body.decode("utf-8", errors="replace")
    safe = "".join(c for c in name if c.isalnum() or c in "._-")[:80] or "upload.csv"
    try:
        profiles, notes = textcast.read_text(text, "temperature", source_name=safe)
    except textcast.TextCastError as exc:
        raise HTTPException(422, str(exc)) from exc
    _UPLOADS[safe] = text
    _UPLOAD_NOTES[safe] = notes
    return {"name": safe, "casts": len(profiles),
            "levels": int(sum(p.depth.size for p in profiles)), "notes": notes}


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
                           ("glider", glider.load_window(centre, variable)),
                           ("text", _uploaded(variable))):
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
    for profiles in (argo.load_window(centre, variable), glider.load_window(centre, variable),
                     _uploaded(variable)):
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
        # Cyclone heat potential from the same pair, on the same levels (heat.py).
        "tchp": heat.compare(comparison) if variable == "temperature" else None,
        "assumptions": _UPLOAD_NOTES.get(found.source_file, []),
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
