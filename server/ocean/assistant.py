"""The assistant: questions about the data and the viewer, answered from the data.

A language model (through AIRouter, OpenAI-compatible chat completions) is given tools that call the
same functions the API serves -- an analysis value at a place and depth, the observation
list, one cast against the analysis, the harness numbers, a global surface value -- and a
guide to the interface (docs/17-user-guide.md). It answers from what the tools return.

Three things keep it inside this project's rules:

  * **Numbers come from tools.** The system prompt forbids any figure the tools did not
    return, and `unverified_numbers` checks the reply afterwards: every number in the
    answer must appear in a tool result or in the question. Anything else is returned to
    the viewer, which marks the answer as containing unverified figures. A model that
    invents a temperature is caught rather than trusted (hard rule 1, applied to chat).
  * **Depths go through the grid.** Tools take metres and report the native level they
    actually used (hard rule 4); observations always come back with their QC flags, data
    mode and source file (hard rule 2).
  * **The model cannot drive the viewer directly.** It may *propose* interface actions
    (`ui_action`), which are checked here against a whitelist with clamped arguments, and
    again in the browser, before anything moves.

The key never leaves the server. With no key, no network or a rate limit the endpoint
says so and nothing else in the viewer is affected.
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Callable

import numpy as np

from . import config, globalsurface

ROOT = Path(__file__).resolve().parents[2]
GUIDE = ROOT / "docs" / "17-user-guide.md"
EVAL = ROOT / "data" / "eval-latest.json"
ROUTER_URL = "https://api.airouter.in/v1"
# Fast, cheap, reliable at tool calls; tried in this order. Override with AI_ROUTER_MODEL.
DEFAULT_MODELS = "openai/gpt-4.1-mini,google/gemini-2.5-flash,deepseek/deepseek-v4-flash"
MAX_ROUNDS = 5          # tool rounds per question before giving up
MAX_HISTORY = 12        # messages of conversation kept
MAX_QUESTION = 2_000    # characters


class AssistantUnavailable(RuntimeError):
    """No key, no network, or the provider refused. Shown to the user as-is."""


# ------------------------------------------------------------------ UI actions

VIEWS = {"region", "map", "globe", "fly"}
LAYERS = {"field", "residual"}

# The controls the assistant may set, click or point at, by element id in viewer/index.html.
# The description is the model's menu; the browser checks again that the id is a control
# of its own page. Anything not listed here cannot be touched.
CONTROLS: dict[str, str] = {
    # sections (highlight only)
    "cube-section": "section: Ocean cube (box, variable, day, depth)",
    "cut-section": "section: Cut & look (slide the cube's faces in)",
    "ocean-section": "section: Whole ocean (surface colour, currents, winds)",
    "fishing-section": "section: For fishermen",
    "probe-section": "section: Probe (value under the cursor, column chart)",
    "bay-section": "section: INCOIS Bay volume (the v1 view, residual layer)",
    "chat-section": "section: this assistant",
    # the cube
    "cube-scenario": "select: a ready-made cube to start from",
    "cube-variable": "select: the cube's variable (temperature, salinity, speed, chlorophyll...)",
    "cube-day": "date input YYYY-MM-DD: the cube's day",
    "cube-depth": "select: down to 200, 500, 1000, 2000, 4000 or 6000 (sea floor) m",
    "cube-w": "number: west edge, degrees", "cube-e": "number: east edge, degrees",
    "cube-s": "number: south edge, degrees", "cube-n": "number: north edge, degrees",
    "cube-draw": "button: draw a box on the globe with the mouse",
    "cube-load": "button: load the cube for the box, day and variable",
    "cube-floats": "checkbox: Argo floats in the cube",
    "cut-top": "range 0-1000: cut the cube's top down", "cut-bottom": "range 0-1000: bottom",
    "cut-west": "range 0-1000: west side in", "cut-east": "range 0-1000: east side in",
    "cut-south": "range 0-1000: south side in", "cut-north": "range 0-1000: north side in",
    "cube-height": "range 5-80: vertical exaggeration of the cube (label 'Vertical ×')",
    "cube-opacity": "range 10-100: opacity of the cube's faces, percent",
    "cube-stretched": "checkbox: stretched depth", "cube-contours": "checkbox: contour lines",
    "cube-native": "checkbox: native levels only, no interpolation",
    "cut-reset": "button: whole cube (undo cuts)", "cube-home": "button: look at the cube",
    # the whole ocean
    "cube-only": "checkbox: only the cube, hide the rest of the world",
    "ocean-surface": "checkbox: the whole ocean coloured at the cube's top depth",
    "ocean-wind": "checkbox: animated ocean currents, whole ocean",
    "cube-wind": "checkbox: animated currents on the cube's top",
    "ocean-air": "checkbox: animated winds at 10 m",
    "ocean-density": "select: particle count 5000, 12000, 20000, 35000",
    "fish-on": "checkbox: likely fishing zones and sea state in the cube's box",
    "pfz-on": "checkbox: official INCOIS PFZ advisory points (India)",
    # colour
    "palette": "select: colour palette", "reverse": "checkbox: reverse the palette",
    "log": "checkbox: log colour scale", "range-min": "number: colour bar minimum",
    "range-max": "number: colour bar maximum",
    # the Bay volume and the header
    "bay-volume": "checkbox: show the INCOIS Bay analysis volume instead of the cube",
    "view-region": "button: Region 3D view", "view-map": "button: Map 2D view",
    "view-globe": "button: Globe view", "view-fly": "button: Fly view",
    "reset-view": "button: reset the camera", "immersive": "button: immersive view",
    "layer-residual": "button: residual vs observed (Bay volume only)",
    "gfx-tier": "select: graphics quality",
}


def check_action(action: str, args: dict) -> dict | None:
    """A proposed interface action, validated and clamped, or None if not allowed."""
    num = lambda k, lo, hi: min(max(float(args[k]), lo), hi)  # noqa: E731
    try:
        if action == "set_view" and args.get("view") in VIEWS:
            return {"action": action, "view": args["view"]}
        if action == "set_layer" and args.get("layer") in LAYERS:
            return {"action": action, "layer": args["layer"]}
        if action == "set_depth":
            return {"action": action, "depth_m": num("depth_m", 0, 2000)}
        if action == "fly_to":
            return {"action": action, "lat": num("lat", -80, 80), "lon": num("lon", -180, 180)}
        if action == "open_profile" and isinstance(args.get("platform"), str):
            return {"action": action, "platform": args["platform"][:64]}
        if action == "isotherm_20":
            return {"action": action}
        if action == "make_cube":
            out = {"action": action, "west": num("west", -180, 180), "east": num("east", -180, 180),
                   "south": num("south", -80, 90), "north": num("north", -80, 90)}
            if isinstance(args.get("variable"), str):
                out["variable"] = args["variable"][:32]
            if isinstance(args.get("day"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", args["day"]):
                out["day"] = args["day"]
            if args.get("depth_max") is not None:
                out["depth_max"] = int(num("depth_max", 200, 6000))
            return out
        if action in ("set_control", "click", "highlight") and args.get("target") in CONTROLS:
            out = {"action": action, "target": args["target"]}
            if action == "set_control":
                value = args.get("value")
                if not isinstance(value, (str, int, float, bool)):
                    return None
                out["value"] = value[:40] if isinstance(value, str) else value
            return out
        if action == "immersive":
            return {"action": action, "on": args.get("on") is not False}
        if action == "cinematic":
            return {"action": action}
    except (KeyError, TypeError, ValueError):
        return None
    return None


# ------------------------------------------------------------------ tools

def _depth_name(ds) -> str:
    return "depth" if "depth" in ds.coords else "ZAX"


def tool_value_at(lat: float, lon: float, depth_m: float, variable: str = "temperature",
                  date_: str | None = None) -> dict:
    """The analysis at the nearest grid cell and native level to a place and depth."""
    from . import api

    if variable not in ("temperature", "salinity"):
        return {"error": f"variable must be temperature or salinity, not {variable!r}"}
    start, end = api.DEFAULT_WINDOW
    ds, names = api._dataset(variable, config.DEFAULT_SOURCE, start, end)
    var = ds[names["value"]]
    z = _depth_name(ds)
    when = np.datetime64(date_ or config.DEMO_DATE.isoformat())
    cell = var.sel(time=when, method="nearest").sel(
        {"latitude": lat, "longitude": lon}, method="nearest").sel({z: depth_m}, method="nearest")
    err = None
    if names.get("error"):
        e = ds[names["error"]].sel(time=when, method="nearest").sel(
            {"latitude": lat, "longitude": lon}, method="nearest").sel({z: depth_m}, method="nearest")
        err = float(e.values)
    value = float(cell.values)
    return {
        "variable": variable,
        "value": None if not math.isfinite(value) else round(value, 2),
        "units": "degC" if variable == "temperature" else "PSU",
        "analysis_error": None if err is None or not math.isfinite(err) else round(err, 2),
        "grid_cell": {"lat": float(cell.latitude), "lon": float(cell.longitude)},
        "native_level_m": round(float(cell[z]), 1),
        "analysis_step": str(cell.time.values)[:10],
        "source": config.SOURCES[config.DEFAULT_SOURCE].title,
        "note": "NaN means land or below the sea floor" if not math.isfinite(value) else "",
    }


def tool_list_observations(kind: str = "all", limit: int = 15, only_rejected: bool = False) -> dict:
    """Casts in the demo window: position, time, QC, data mode, source file."""
    from . import argo, glider

    out = []
    for k, profiles in (("argo", argo.load_window(config.DEMO_DATE, "temperature")),
                        ("glider", glider.load_window(config.DEMO_DATE, "temperature"))):
        if kind not in ("all", k):
            continue
        for p in profiles:
            if only_rejected and not p.n_rejected:
                continue
            out.append({"kind": k, "platform": p.platform, "lat": round(p.lat, 2),
                        "lon": round(p.lon, 2), "time": str(p.time)[:16],
                        "levels": int(p.depth.size), "levels_rejected_by_qc": p.n_rejected,
                        "data_mode": p.data_mode, "source_file": p.source_file})
    out.sort(key=lambda c: -c["levels_rejected_by_qc"])
    n = max(1, min(int(limit), 40))
    return {"window_centre": config.DEMO_DATE.isoformat(), "total": len(out),
            "shown": min(len(out), n), "sorted_by": "levels rejected by QC, most first",
            "casts": out[:n]}


def tool_profile(platform: str) -> dict:
    """One cast against the analysis: the numbers the profile chart is drawn from."""
    from . import api

    result = api.profile(platform=platform, on=None, variable="temperature",
                         source=config.DEFAULT_SOURCE, t0=None, t1=None)
    s = result["summary"]
    keep = ("levels", "levels_compared", "levels_rejected", "bias", "rmse", "data_mode",
            "field_used", "source_file", "analysis_time", "time_offset_days", "qc_accepted")
    return {"platform": result["platform"], "lat": result["lat"], "lon": result["lon"],
            "time": result["time"], "summary": {k: s.get(k) for k in keep},
            "cyclone_heat_potential": result["tchp"]}


def tool_eval_summary() -> dict:
    """The harness's measured numbers (data/eval-latest.json), the ones the deck quotes."""
    e = json.loads(EVAL.read_text(encoding="utf-8"))
    return {k: e[k] for k in ("centre_date", "region", "argo", "glider", "depth_bands",
                              "residual", "tchp", "field_range_test", "currents") if k in e} | {
        "colocation": {k: v for k, v in e["colocation"].items() if k != "per_profile"}}


def tool_global_value(layer: str, lat: float, lon: float, day: str | None = None) -> dict:
    """A whole-Earth surface value (globalsurface.py): anywhere, surface only."""
    from . import globalsurface

    if layer not in globalsurface.LAYERS:
        return {"error": f"layer must be one of {sorted(globalsurface.LAYERS)}"}
    day = day or globalsurface.reference_day()
    if day not in globalsurface.days():
        return {"error": f"day must be one of {globalsurface.days()}"}
    s = globalsurface.surface(day, layer)
    ny, nx = s.values.shape
    row = round((s.lat_range[1] - lat) / (s.lat_range[1] - s.lat_range[0]) * (ny - 1))
    col = round((lon - s.lon_range[0]) / (s.lon_range[1] - s.lon_range[0]) * (nx - 1))
    value = float(s.values[min(max(row, 0), ny - 1), min(max(col, 0), nx - 1)])
    return {"layer": s.layer.title, "units": s.layer.units, "day": day,
            "value": None if not math.isfinite(value) else round(value, 3),
            "level_m": s.level_m, "note": "land" if not math.isfinite(value) else s.layer.note,
            "source": "Copernicus GLORYS12, 1/4 deg, surface only"}


def tool_fishing_zones(west: float, east: float, south: float, north: float,
                       day: str | None = None) -> dict:
    """Indicative fishing zones and sea state over a box (fishing.py), without the grid."""
    from datetime import date

    from . import cube, fishing

    day = day or date.today().isoformat()
    result = fishing.assess(cube.Box.parse(west, east, south, north), day)
    p = result["provenance"]
    return {"day": day, "spots": result["spots"], "counts": result["counts"],
            "rule": p["rule"], "sea_state_scale": p["sea_state_scale"], "missing": p["missing"],
            "not_an_advisory": p["not_an_advisory"]}


def tool_incois_pfz(sector: str = "") -> dict:
    """INCOIS's own PFZ advisories (pfz.py), all sectors or those whose name matches."""
    from . import pfz

    a = pfz.advisories()
    want = sector.lower().strip()
    chosen = [s for s in a["sectors"] if not want or want in s["name"].lower()] or a["sectors"]
    return {"fetched_utc": a["fetched_utc"], "provenance": a["provenance"],
            "sectors": [{**{k: s[k] for k in ("name", "status", "valid_till", "source")},
                         "note": s.get("note"), "points": s["points"][:12],
                         "points_total": len(s["points"])} for s in chosen]}


def guide_sections() -> dict[str, str]:
    """docs/17-user-guide.md split at its ## headings."""
    text = GUIDE.read_text(encoding="utf-8") if GUIDE.exists() else ""
    parts = re.split(r"^## ", text, flags=re.M)[1:]
    out = {}
    for part in parts:
        heading, _, body = part.partition(chr(10))
        out[heading.strip()] = body.strip()
    return out


def tool_user_guide(topic: str = "") -> dict:
    """The sections of the user guide that mention the topic (all headings if none do).

    A tool rather than part of the system prompt: the provider's free tier allows 8,000
    tokens a minute, and sending the whole guide with every round used most of it."""
    sections = guide_sections()
    words = [w for w in re.findall(r"[a-z0-9]+", topic.lower()) if len(w) > 2]
    hits = {h: body for h, body in sections.items()
            if any(w in (h + " " + body).lower() for w in words)}
    chosen = hits or sections
    return {"sections": dict(list(chosen.items())[:3]), "all_headings": list(sections)}


def tool_ui_action(action: str, **args) -> dict:
    checked = check_action(action, args)
    return {"accepted": checked is not None, "action": checked or action}


TOOLS: dict[str, tuple[Callable[..., dict], dict]] = {
    "value_at": (tool_value_at, {
        "description": "Bay of Bengal analysis (INCOIS) temperature or salinity at a place "
                       "and depth. Returns the native level actually used and the analysis "
                       "error. Region 78-100E, 5-23N, 5-2000 m.",
        "parameters": {"type": "object", "properties": {
            "lat": {"type": "number"}, "lon": {"type": "number"},
            "depth_m": {"type": "number"},
            "variable": {"type": "string", "enum": ["temperature", "salinity"]},
            "date_": {"type": "string", "description": "YYYY-MM-DD; nearest analysis step"}},
            "required": ["lat", "lon", "depth_m"]}}),
    "list_observations": (tool_list_observations, {
        "description": "Argo and glider casts near the demo date, with QC counts, data mode "
                       "and source file.",
        "parameters": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": ["all", "argo", "glider"]},
            "limit": {"type": "integer"},
            "only_rejected": {"type": "boolean"}}}}),
    "profile": (tool_profile, {
        "description": "One cast compared with the analysis: bias, RMSE, levels compared and "
                       "rejected, data mode, source file, cyclone heat potential.",
        "parameters": {"type": "object", "properties": {"platform": {"type": "string"}},
                       "required": ["platform"]}}),
    "eval_summary": (tool_eval_summary, {
        "description": "The project's measured results: error by depth band, residual "
                       "coverage, cyclone heat potential differences, counts.",
        "parameters": {"type": "object", "properties": {}}}),
    "global_value": (tool_global_value, {
        "description": "Global sea-surface value anywhere on Earth (temperature, salinity, "
                       "currents speed, sea_level, mixed_layer depth, sea_ice).",
        "parameters": {"type": "object", "properties": {
            "layer": {"type": "string", "enum": sorted(globalsurface.LAYERS)},
            "lat": {"type": "number"}, "lon": {"type": "number"},
            "day": {"type": "string"}}, "required": ["layer", "lat", "lon"]}}),
    "user_guide": (tool_user_guide, {
        "description": "How to use the viewer and what its words mean (views, controls, "
                       "keys, layers, QC, data mode, bias, RMSE, TCHP). Call it for any "
                       "question about the interface or a term.",
        "parameters": {"type": "object", "properties": {"topic": {"type": "string"}}}}),
    "fishing_zones": (tool_fishing_zones, {
        "description": "Indicative fishing zones (thermal fronts with chlorophyll) and the "
                       "sea state (forecast waves, observed wind) over a box, anywhere. "
                       "Keep the box near the coast asked about, about 5-15 degrees a side. "
                       "Always pass on its not_an_advisory line.",
        "parameters": {"type": "object", "properties": {
            "west": {"type": "number"}, "east": {"type": "number"},
            "south": {"type": "number"}, "north": {"type": "number"},
            "day": {"type": "string", "description": "YYYY-MM-DD; today if omitted"}},
            "required": ["west", "east", "south", "north"]}}),
    "incois_pfz": (tool_incois_pfz, {
        "description": "The official INCOIS Potential Fishing Zone advisories for Indian coastal "
                       "sectors, as INCOIS publishes them today: per point the landing centre, "
                       "direction, bearing, distance (km), depth (m), lat/lon, validity. "
                       "Sectors under cloud have none. For Indian waters prefer this over "
                       "fishing_zones, and say which one you quote.",
        "parameters": {"type": "object", "properties": {
            "sector": {"type": "string", "description": "e.g. Kerala, Gujarat, Andaman; "
                                                        "empty for all"}}}}),
    "ui_action": (tool_ui_action, {
        "description": "Change the viewer; applied when the user's browser receives the "
                       "answer. Call it once per change. "
                       "set_view{view: region|map|globe|fly}; fly_to{lat, lon} anywhere; "
                       "make_cube{west, east, south, north, variable?, day?, depth_max?} "
                       "builds an Ocean Cube anywhere (up to 100 x 80 degrees); "
                       "set_control{target, value} sets a control; click{target} presses a "
                       "button; highlight{target} rings a control in orange for five "
                       "seconds to show the user where it is; immersive{on}; cinematic{} "
                       "plays the camera tour. Bay volume only: set_layer{layer: "
                       "field|residual}, set_depth{depth_m}, open_profile{platform}, "
                       "isotherm_20{}. Targets: " +
                       "; ".join(f"{k} = {v}" for k, v in CONTROLS.items()),
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string"}, "view": {"type": "string"},
            "layer": {"type": "string"},
            "depth_m": {"type": "number"}, "lat": {"type": "number"},
            "lon": {"type": "number"}, "platform": {"type": "string"},
            "west": {"type": "number"}, "east": {"type": "number"},
            "south": {"type": "number"}, "north": {"type": "number"},
            "variable": {"type": "string"}, "day": {"type": "string"},
            "depth_max": {"type": "number"},
            "target": {"type": "string"},
            "value": {"type": "string", "description": "true/false for a checkbox"},
            "on": {"type": "boolean"}},
            "required": ["action"]}}),
}


def system_prompt(context: dict) -> str:
    return f"""You are the assistant inside VVater, a browser viewer for INCOIS ocean data.
You answer two kinds of question: about the data, and about how to use the viewer.

Rules you must follow:
- Every number you state must come from a tool result in this conversation. If you do not
  have a number from a tool, say you do not know or call a tool. Never estimate.
- When you mention a float or glider cast, give its QC situation, data mode and source file.
- Depths: say which native level the tool used, not only the depth asked for.
- The analysis is a model estimate, not a measurement. Say which one you are quoting.
- Keep answers short: two to five sentences, plain words, units always.
- If showing something would help, call ui_action. Say in your answer what you changed.
- When the user asks how to do something, do it for them if you can, and highlight the
  control involved so they learn where it is. When you only explain, still highlight it.
- The Ocean Cube works anywhere on Earth, any day from 1993 to ten days ahead, from the
  sea surface to the floor (Copernicus). make_cube builds one. The INCOIS Bay volume
  (78-100E, 5-23N, 5-2000 m, demo date {config.DEMO_DATE}) is the older view; value_at,
  list_observations, profile and the residual layer are about it only.
- Fishing questions: for Indian waters call incois_pfz first (the official advisory);
  anywhere, fishing_zones gives the indicative zones and the sea state. Say which you quote;
  fishing_zones is indicative, not an INCOIS advisory.

- For anything about the interface or a term, call user_guide first.

What the user is looking at right now: {json.dumps(context)[:1500]}"""


# ------------------------------------------------------------------ verification

_NUMBER = re.compile(r"(?<![\w.])[-−]?\d+(?:[.,]\d+)*(?:\.\d+)?")


def _numbers(text: str) -> set[float]:
    out = set()
    for match in _NUMBER.findall(text):
        try:
            out.add(float(match.replace("−", "-").replace(",", "")))
        except ValueError:
            continue
    return out


def unverified_numbers(reply: str, evidence: list[str]) -> list[str]:
    """Numbers in the reply that appear in no tool result and not in the question.

    Matched at the precision the reply uses, so "28.9" is supported by 28.93 in a tool
    result. Small integers (0-10) and years are exempt: they are counts of things and
    dates far more often than claims.
    """
    known = set()
    for text in evidence:
        known |= _numbers(text)
    bad = []
    for token in _NUMBER.findall(reply):
        try:
            value = float(token.replace("−", "-").replace(",", ""))
        except ValueError:
            continue
        if value.is_integer() and (0 <= abs(value) <= 10 or 1900 <= value <= 2100):
            continue
        decimals = len(token.split(".")[1]) if "." in token else 0
        tolerance = 0.5 * 10 ** -decimals
        if not any(abs(value - k) <= tolerance + 1e-9 or abs(value + k) <= tolerance + 1e-9
                   for k in known):
            bad.append(token)
    return bad


# ------------------------------------------------------------------ the loop

Transport = Callable[[dict], dict]


def models() -> list[str]:
    """The models to try, in order: `AI_ROUTER_MODEL` is a comma-separated list."""
    return [m.strip() for m in os.environ.get("AI_ROUTER_MODEL", DEFAULT_MODELS).split(",") if m.strip()]


def router_transport(payload: dict) -> dict:
    """AIRouter (OpenAI-compatible, prepaid). A model that is rate-limited, down or
    refuses is skipped for the next one in `models()`; the first answer wins."""
    import requests

    key = os.environ.get("AI_ROUTER_KEY")
    if not key:
        raise AssistantUnavailable("the assistant needs AI_ROUTER_KEY in .env")
    body = {k: v for k, v in payload.items() if not k.startswith("_")}
    url = os.environ.get("AI_ROUTER_URL", ROUTER_URL).rstrip("/") + "/chat/completions"
    failures = []
    for model in models():
        try:
            response = requests.post(url, json={**body, "model": model}, timeout=45,
                                     headers={"Authorization": f"Bearer {key}"})
        except requests.RequestException as exc:
            failures.append(f"{model}: {type(exc).__name__}")
            continue
        if response.status_code in (401, 402, 403):
            # A key or balance problem is the same for every model.
            raise AssistantUnavailable(f"the model router refused the key or the balance "
                                       f"is used up ({response.status_code})")
        if response.status_code >= 400:
            failures.append(f"{model}: {response.status_code}")
            continue
        return response.json()
    raise AssistantUnavailable("no language model answered (" + "; ".join(failures) + ")")


def run(messages: list[dict], context: dict | None = None,
        transport: Transport = router_transport) -> dict:
    """One question in, one answer out, with the tool calls made on the way."""
    history = [m for m in messages if m.get("role") in ("user", "assistant")
               and isinstance(m.get("content"), str)][-MAX_HISTORY:]
    if not history or history[-1]["role"] != "user":
        raise ValueError("the last message must be the user's question")
    for m in history:
        m["content"] = m["content"][:MAX_QUESTION]

    convo: list[dict] = [{"role": "system", "content": system_prompt(context or {})}, *history]
    # What the model may quote from: the question, the screen state, the guide (its
    # numbers are facts about the viewer, like the flight altitude limits), tool results.
    evidence = [history[-1]["content"], json.dumps(context or {})]
    actions: list[dict] = []
    used: list[str] = []
    schema = [{"type": "function", "function": {"name": n, **spec}} for n, (_, spec) in TOOLS.items()]

    for _ in range(MAX_ROUNDS):
        reply = transport({"messages": convo, "tools": schema, "temperature": 0.2})
        message = reply["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        if not calls:
            # The model sometimes leaves its own citation marks (【2†L1-L4】); they point at
            # nothing the user can see.
            text = re.sub(r"\s*【[^】]*】", "", message.get("content") or "").strip()
            return {"reply": text, "actions": actions, "tools_used": used,
                    "unverified": unverified_numbers(text, evidence)}
        convo.append({"role": "assistant", "content": message.get("content") or "",
                      "tool_calls": calls})
        for call in calls:
            name = call["function"]["name"]
            used.append(name)
            try:
                args = json.loads(call["function"].get("arguments") or "{}")
                fn = TOOLS[name][0]
                result = fn(**args)
            except KeyError:
                result = {"error": f"no tool {name!r}"}
            except Exception as exc:  # a bad argument must not end the conversation
                result = {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
            if name == "ui_action" and result.get("accepted"):
                actions.append(result["action"])
            text = json.dumps(result, default=str)[:12_000]
            evidence.append(text)
            convo.append({"role": "tool", "tool_call_id": call["id"], "content": text})
    return {"reply": "I could not finish that within the tool budget; try a narrower question.",
            "actions": actions, "tools_used": used, "unverified": []}


def demo() -> None:
    assert unverified_numbers("It is 28.9 °C at 50 m", ['{"value": 28.93, "native_level_m": 50.0}']) == []
    assert unverified_numbers("It is 31.4 °C", ['{"value": 28.93}']) == ["31.4"]
    assert unverified_numbers("3 floats in 2018", []) == []
    assert re.sub(r"\s*【[^】]*】", "", "Jakhau 46-51 km 【2†L7-L12】.") == "Jakhau 46-51 km."
    assert check_action("set_depth", {"depth_m": 99999}) == {"action": "set_depth", "depth_m": 2000.0}
    assert check_action("run_shell", {}) is None
    assert check_action("set_view", {"view": "space"}) is None
    assert check_action("highlight", {"target": "cube-draw"}) == {"action": "highlight", "target": "cube-draw"}
    assert check_action("click", {"target": "body"}) is None, "only listed controls"
    assert check_action("set_control", {"target": "fish-on", "value": {"x": 1}}) is None
    cube_ = check_action("make_cube", {"west": -80, "east": -60, "south": 30, "north": 45,
                                       "day": "2026-09-01; drop", "depth_max": 1e6})
    assert cube_["depth_max"] == 6000 and "day" not in cube_, cube_
    assert check_action("make_cube", {"west": 0, "east": 10, "south": 0, "north": 10,
                                      "day": "2026-09-01"})["day"] == "2026-09-01"
    assert "Views (keys 1 to 4)" in tool_user_guide("fly")["sections"]
    print("assistant demo ok")


if __name__ == "__main__":
    demo()
