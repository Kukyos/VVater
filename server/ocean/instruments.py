"""Every in-situ instrument the viewer draws, in one dict.

This is the extensibility mechanism for observations, the in-situ twin of
`sources.PARSERS` for gridded fields (L11). An instrument is a loader that returns
`argo.Profile` casts for a day and a variable, the variables it can answer for, and how
the viewer should label and colour it. The API, the viewer's markers and legend, and the
assistant's tool all read this dict; none of them names an instrument.

Adding one — a CTD, a mooring, an ADCP — is a line here plus, when its files are not in a
format already read, one reader module. `docs/23-extending.md` walks through each case
with the files it touches.

    python -m server.ocean.instruments     # self-check: every entry answers, filters hold
"""

from dataclasses import dataclass
from datetime import date
from typing import Callable

import requests

from . import argo, config, glider, insitu, textcast
from .argo import Profile


@dataclass(frozen=True)
class Instrument:
    kind: str
    label: str                      # plural, for the legend: "Argo floats"
    one: str                        # singular, for a count of one: "Argo float"
    variables: frozenset[str]       # what it can be asked for; others are skipped, not errors
    load: Callable[[date, str], list[Profile]]
    colour: str                     # marker colour in the viewer, QC applied
    qc: str                         # whose flag vocabulary, in a phrase, for the legend
    # A cast whose QC was never run (data_mode 'U') must look different from one that
    # passed. Gold for every instrument, unless everything it emits is unevaluated.
    unevaluated: str = "#c9a227"
    size: int = 9                   # marker pixels; a glider emits many, so smaller
    # What the reader of a cast's file had to assume (hard rule 5), for the profile panel.
    notes: Callable[[Profile], list[str]] = lambda _p: []


# ------------------------------------------------------------------ uploads

# In memory and per server process: an upload is for looking at, not an archive.
UPLOADS: dict[str, str] = {}
# The assumptions the parser made for each file (units, pressure->depth, ...). Hard rule 5:
# they travel with the casts to the profile panel, not just back to the uploader.
UPLOAD_NOTES: dict[str, list[str]] = {}


def _uploaded(_centre: date, variable: str) -> list[Profile]:
    out = []
    for name, text in UPLOADS.items():
        try:
            out.extend(textcast.read_text(text, variable, source_name=name)[0])
        except textcast.TextCastError:
            continue  # e.g. a temperature-only file asked for salinity
    return out


# ------------------------------------------------------------------ the registry

INSTRUMENTS: dict[str, Instrument] = {i.kind: i for i in [
    Instrument("argo", "Argo floats", "Argo float", frozenset({"temperature", "salinity"}),
               lambda d, v: argo.load_window(d, v), "#4dd2ff",
               "Argo R/A/D with per-level flags"),
    Instrument("glider", "glider casts", "glider cast", frozenset({"temperature", "salinity"}),
               lambda d, v: glider.load_window(d, v), "#7ee787",
               "QARTOD, or unevaluated where never run", size=7),
    Instrument("mooring", "moorings", "mooring", frozenset({"temperature", "salinity", "u", "v"}),
               lambda d, v: insitu.load_window(config.INSITU_PLATFORMS["mooring"], d, v,
                                               nearest_only=True),
               "#ffa657", "Copernicus In Situ TAC flags; 0 = never checked",
               notes=lambda p: insitu.notes_for(insitu.CACHE / p.source_file)),
    Instrument("text", "uploaded casts", "uploaded cast", frozenset({"temperature", "salinity"}),
               _uploaded, "#ff7bd5", "none: a text file carries no agreed QC",
               unevaluated="#ff7bd5",
               notes=lambda p: UPLOAD_NOTES.get(p.source_file, [])),
]}

# What an instrument's loader may raise when its source is unreachable or its file is not
# what it should be. One such instrument must not take the others' markers with it.
UNAVAILABLE = (OSError, requests.RequestException, ValueError, KeyError)


def observations(centre: date, variable: str
                 ) -> tuple[list[tuple[Instrument, Profile]], dict[str, str]]:
    """Every cast of `variable` in the window, from every instrument that measures it, and
    the instruments that could not be read, with why."""
    casts: list[tuple[Instrument, Profile]] = []
    unavailable: dict[str, str] = {}
    for inst in INSTRUMENTS.values():
        if variable not in inst.variables:
            continue
        try:
            casts.extend((inst, p) for p in inst.load(centre, variable))
        except UNAVAILABLE as exc:
            unavailable[inst.kind] = f"{type(exc).__name__}: {exc}"[:200]
    return casts, unavailable


def find(platform: str, centre: date, variable: str) -> tuple[Instrument, Profile] | None:
    """One cast by its platform id. Instruments are asked in order and stop at the first
    hit, so the expensive ones are not read to find a float."""
    for inst in INSTRUMENTS.values():
        if variable not in inst.variables:
            continue
        try:
            profiles = inst.load(centre, variable)
        except UNAVAILABLE:
            continue
        for p in profiles:
            if p.platform == platform:
                return inst, p
    return None


def legend() -> list[dict]:
    """What the viewer needs to draw and label any instrument, including one it has never
    heard of."""
    return [{"kind": i.kind, "label": i.label, "one": i.one, "colour": i.colour, "qc": i.qc,
             "unevaluated": i.unevaluated, "size": i.size, "variables": sorted(i.variables)}
            for i in INSTRUMENTS.values()]


def demo() -> None:
    """No network for the filter logic; the real loaders are exercised by the eval."""
    calls: list[str] = []

    def fake(kind: str) -> Callable[[date, str], list[Profile]]:
        def load(_d: date, v: str) -> list[Profile]:
            calls.append(f"{kind}:{v}")
            return []
        return load

    def unreachable(_d: date, _v: str) -> list[Profile]:
        raise requests.ConnectionError("host did not answer")

    saved = dict(INSTRUMENTS)
    try:
        INSTRUMENTS.clear()
        INSTRUMENTS["ts"] = Instrument("ts", "t/s", "t/s", frozenset({"temperature", "salinity"}),
                                       fake("ts"), "#fff", "x")
        INSTRUMENTS["adcp"] = Instrument("adcp", "adcp", "adcp", frozenset({"u", "v"}),
                                         fake("adcp"), "#fff", "x")
        INSTRUMENTS["down"] = Instrument("down", "down", "down", frozenset({"temperature"}),
                                         unreachable, "#fff", "x")
        _, missing = observations(config.DEMO_DATE, "temperature")
        observations(config.DEMO_DATE, "u")
        assert calls == ["ts:temperature", "adcp:u"], calls  # each asked only for its own
        assert list(missing) == ["down"], "an unreachable instrument is reported, not fatal"
        assert find("nobody", config.DEMO_DATE, "salinity") is None
        assert [e["kind"] for e in legend()] == ["ts", "adcp", "down"]
    finally:
        INSTRUMENTS.clear()
        INSTRUMENTS.update(saved)
    assert set(INSTRUMENTS) >= {"argo", "glider", "mooring", "text"}
    assert all(e["colour"].startswith("#") and e["label"] for e in legend())
    print(f"instruments ok: {', '.join(INSTRUMENTS)}")


if __name__ == "__main__":
    demo()
