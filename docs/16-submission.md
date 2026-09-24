# Submission — the idea deck

The portal wants the SIH 2026 template, six slides at most, "points / diagrams /
infographics / pictures" rather than paragraphs. The deck is built, not drawn.

```
python -m server.eval.run_eval --json            # numbers -> data/eval-latest.json
python submission/sih/figures.py                 # slide bodies as HTML, numbers read from the JSON
python submission/sih/render.py                  # HTML -> PNG, headless Chrome, 4000 x 1710
python submission/sih/figures.py --check         # fails if any body leaves an empty band
python submission/sih/build.py                   # template + bodies -> final/VVater-SIH2026.pptx
powershell -ExecutionPolicy Bypass -File submission/sih/topdf.ps1   # -> final/VVater-SIH2026.pdf
```

`SIH2026-IDEA-Presentation-Format.pptx` must sit in the repo root. It is the portal's
file, not ours, and is not committed.

## What the build does

- Keeps the template's masthead, SIH mark, footer and page numbers, because the portal
  requires the provided template.
- Fills the title page fields from `01-problem-statement.md`, styled like the team's
  PS 26047 deck (bulleted, Arial Bold, black), and the "IDEA TITLE" placeholder.
- Replaces the "Your Team Name" oval on every content slide with the VVater logo
  (`figures/logo.png`, the viewer's favicon rendered by `render.py logo`).
- Replaces each content slide's instruction box with one rendered body image.
- Slide 2 leads with what is new: the assistant (`shot-assistant.png`, cropped from
  `shot-workspace.png` by `figures.py`) and the Fly view.
- `build.py <path>` writes elsewhere, for when the deck is open in PowerPoint.
- Drops the template's seventh "important instructions" slide: six is the limit, title
  slide included.

Body text is part of an image, so it is not selectable and does not depend on the fonts
of whatever machine opens the file. Rewording is an edit to `figures.py` and a rerun.

## What each slide carries

| Slide | Plain-language layer | Technical layer |
|---|---|---|
| 2 Solution | the problem in three cards, "today vs with VVater", a glossary | the working prototype and its three views |
| 3 Technical | — | pipeline flowchart with its three real decisions; the stack, each choice against named alternatives |
| 4 Feasibility | what it needs to run at INCOIS | harness numbers, error by depth, model vs two instruments, risks met |
| 5 Impact | students, public, policy | forecaster numbers (TCHP difference, coverage) |
| 6 References | — | repository link, 18 sources, how the links were checked |

The check in `figures.py --check` only catches empty space. It cannot see overflow (the
body is `overflow: hidden`), so look at the rendered PNGs after any rewording.

## Link check, 2026-09-23

Every URL on slide 6 was fetched with `curl -L` and a browser user agent. All returned
200 except: the two brief FTP links (dead, and listed as dead); the AMS page behind the
Leipper & Volgenau DOI, which returns 403 to scripts while the DOI itself resolves (302 to
`journals.ametsoc.org`); FastAPI's site, which timed out once and returned 200 on retry.
An earlier form of that DOI (`...:HHCOTG...`) was wrong and 404'd; the correct suffix
from Crossref is `HHPOTG`. The repository `github.com/Kukyos/VVater` is public.

## Screenshots

`figures/shot-*.png` are captures of the running viewer, not mock-ups; `figures.py`
refuses to run without them. They are taken headless (puppeteer-core driving the installed
Chrome) at 1600 x 900, device scale 2, with Graphics forced to High through
`localStorage["vvater.graphics.v2"]` — left on Auto, a headless GPU tunes itself down to
45% resolution and every shot comes out soft. The dev build exposes `window.vvater`
(`setView`, `setDock`, `showProfile`, `setLayer`, `homeCamera`, `setMode`, `orbit`, `flight`), which is how each state
is reached. All start from the default state: analysis, 2018-08-30 step, slice 93 m,
currents on.

| Shot | State | Captured |
|---|---|---|
| workspace | left dock retracted, float 2902596 clicked; 1280 x 720 at scale 2.5 so the inspector reads at slide size | whole page |
| region | both docks retracted, Region 3D home camera | `#view` |
| map | docks retracted, Map 2D | `#view` |
| globe | docks retracted, Globe | `#view` |
| resid | currents off, Residual layer, range −2 to 2, opacity 0.9 | `#view` |
| simple | Simple mode, sea surface temperature, 2018-08-30 | whole page |
| fly | Fly view paused at 4.5°N 76.5°E, heading 055°, 110 km, looking 16° down | `#view` |

## Rules the deck follows

- Every number is read from `data/eval-latest.json`. A missing key crashes `figures.py`
  rather than printing a plausible wrong number (hard rule 1).
- Frame rates are not on any slide: they are measured per machine by the viewer and the
  harness does not produce them.
- Anything probed but not ingested is labelled that way on the references slide.
