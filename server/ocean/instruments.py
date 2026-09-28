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

from . import argo, config, glider, insitu, textcast
from .argo import Profile


@dataclass(frozen=True)
class Instrument:
    kind: str
    label: str                      # plural, for the legend: "Argo floats"
    variables: frozenset[str]       # what it can be asked for; others are skipped, not errors
    load: Callable[[date, str], list[Profile]]
    colour: str                     # marker colour in the viewer, QC applied
    qc: str                         # whose flag vocabulary, in a phrase, for the legend
    # A cast whose QC was never run (data_mode 'U') must look different from one that
    # passed. Gold for every instrument, unless everything it emits is unevaluated.
    unevaluated: str = "#c9a227"
    size: int = 9                   # marker pixels; a glider emits many, so smaller


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
    Instrument("argo", "Argo floats", frozenset({"temperature", "salinity"}),
               lambda d, v: argo.load_window(d, v), "#4dd2ff",
               "Argo R/A/D with per-level flags"),
    Instrument("glider", "glider casts", frozenset({"temperature", "salinity"}),
               lambda d, v: glider.load_window(d, v), "#7ee787",
               "QARTOD, or unevaluated where never run", size=7),
    Instrument("mooring", "moorings", frozenset({"temperature", "salinity", "u", "v"}),
               lambda d, v: insitu.load_window(config.INSITU_PLATFORMS["mooring"], d, v,
                                               nearest_only=True),
               "#ffa657", "Copernicus In Situ TAC flags; 0 = never checked"),
    Instrument("text", "uploaded casts", frozenset({"temperature", "salinity"}),
               _uploaded, "#ff7bd5", "none: a text file carries no agreed QC",
               unevaluated="#ff7bd5"),
]}


def observations(centre: date, variable: str) -> list[tuple[Instrument, Profile]]:
    """Every cast of `variable` in the window, from every instrument that measures it."""
    return [(inst, p) for inst in INSTRUMENTS.values() if variable in inst.variables
            for p in inst.load(centre, variable)]


def find(platform: str, centre: date, variable: str) -> tuple[Instrument, Profile] | None:
    """One cast by its platform id. Instruments are asked in order and stop at the first
    hit, so the expensive ones are not read to find a float."""
    for inst in INSTRUMENTS.values():
        if variable not in inst.variables:
            continue
        for p in inst.load(centre, variable):
            if p.platform == platform:
                return inst, p
    return None


def notes(inst: Instrument, profile: Profile) -> list[str]:
    """What the reader of this cast's file had to assume, for the profile panel."""
    if inst.kind == "text":
        return UPLOAD_NOTES.get(profile.source_file, [])
    if inst.kind == "mooring":
        return insitu.notes_for(insitu.CACHE / profile.source_file)
    return []


def legend() -> list[dict]:
    """What the viewer needs to draw and label any instrument, including one it has never
    heard of."""
    return [{"kind": i.kind, "label": i.label, "colour": i.colour, "qc": i.qc,
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

    saved = dict(INSTRUMENTS)
    try:
        INSTRUMENTS.clear()
        INSTRUMENTS["ts"] = Instrument("ts", "t/s", frozenset({"temperature", "salinity"}),
                                       fake("ts"), "#fff", "x")
        INSTRUMENTS["adcp"] = Instrument("adcp", "adcp", frozenset({"u", "v"}),
                                         fake("adcp"), "#fff", "x")
        observations(config.DEMO_DATE, "temperature")
        observations(config.DEMO_DATE, "u")
        assert calls == ["ts:temperature", "adcp:u"], calls  # each asked only for its own
        assert find("nobody", config.DEMO_DATE, "salinity") is None
        assert [e["kind"] for e in legend()] == ["ts", "adcp"]
    finally:
        INSTRUMENTS.clear()
        INSTRUMENTS.update(saved)
    assert set(INSTRUMENTS) >= {"argo", "glider", "mooring", "text"}
    assert all(e["colour"].startswith("#") and e["label"] for e in legend())
    print(f"instruments ok: {', '.join(INSTRUMENTS)}")


if __name__ == "__main__":
    demo()
