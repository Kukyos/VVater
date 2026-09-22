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
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from . import argo, colocate, config, glider, sources, volume

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


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "region": config.REGION["name"], "demoDate": str(config.DEMO_DATE)}
