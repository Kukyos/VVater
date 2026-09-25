# Submission: the idea deck

The portal wants the SIH 2026 template, six slides at most, "points / diagrams /
infographics / pictures" rather than paragraphs. The deck is built, not drawn.

We assume the evaluator never opens the live site, so every slide shows the product in a
real capture. Every picture is a capture of the running build, cropped, never a mock-up.

```
python -m server.tools.measure_hosting           # hosting -> data/hosting-latest.json (~10-20 min, network)
python -m server.eval.run_eval --json            # numbers -> data/eval-latest.json (reads the hosting file)
node submission/sih/capture.cjs                  # screenshots, API and viewer running (below)
python submission/sih/figures.py                 # crops and slide bodies, numbers read from the JSON
python submission/sih/render.py                  # HTML -> PNG, headless Chrome, 4000 x 1710
python submission/sih/figures.py --check         # fails if any body leaves an empty band
python submission/sih/build.py                   # template + bodies -> final/VVater-SIH2026.pptx
python submission/sih/build_canva.py             # the editable copy -> final/VVater-SIH2026-canva.pptx
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
- Drops the template's seventh "important instructions" slide: six is the limit, title
  slide included.
- `build.py <path>` writes elsewhere, for when the deck is open in PowerPoint.

## What each slide carries

| Slide | Pictures | Text and numbers |
|---|---|---|
| 2 Solution | hero: the Amphan Bay cube cut open with its floats; four tiles for what is new: any ocean (Gulf Stream), floats inside the model, the planet on one colour bar, the assistant acting | one-line pitch; the two gaps the brief names |
| 3 Technical | a flowchart of how a cube is made (only the ARCO chunks the box touches are read; the chunk grid is drawn) with the float lane and every failing branch | the brief's requirements line by line against what is built; the stack |
| 4 Feasibility | the residual layer (where the INCOIS model is wrong) | four stat tiles (variables and days covered, cube open time, peak memory, casts co-located); error by depth; the risks we hit |
| 5 Impact | Amphan before and after; the fishing panel; a course card; the immersive view | one column each for forecasters, fishermen, students, outreach; what comes next |
| 6 References | none | the repository; 24 sources in three columns: data, standards and methods, what the course cites |

`figures.py --check` only catches empty space. It cannot see overflow (the body is
`overflow: hidden`), so look at the rendered PNGs after any rewording, and at the Canva
copy, whose Arial runs wider than IBM Plex.

## The numbers

Every number is read from `data/eval-latest.json`; a missing key crashes `figures.py`
(hard rule 1). The v2 figures come from `run_eval.v2_numbers()`:

- the catalogue: variable count, first and last day across every era
- the two Amphan cubes: levels, payload, open time from the disk cache, surface mean,
  and the cooling between them
- the Argo casts in the Amphan cube
- the hosting measurement, read from `data/hosting-latest.json`, which
  `server/tools/measure_hosting.py` writes; nothing is retyped

The cube's open time is measured with its chunks already in the disk cache, and the slide
says so. A cold open depends on Copernicus and the network and is not on any slide. Frame
rates are not on any slide either: the viewer measures them per machine and the harness
does not produce them.

## Screenshots

`submission/sih/capture.cjs` drives the installed Chrome headless with puppeteer-core,
which is not a project dependency:

```
npm i --prefix <somewhere> puppeteer-core
NODE_PATH=<somewhere>/node_modules node submission/sih/capture.cjs [shot ...]
```

It needs the API on :8011 and `npm run dev` on :5173 (the dev build exposes
`window.vvater`). Run `python -m server.tools.warm_scenarios` first, or the first capture
waits on Copernicus. Every shot is 1600 x 900 at device scale 2, Graphics forced to High
through `localStorage["vvater.graphics.v2"]` (left on Auto, a headless GPU tunes itself
down and every shot comes out soft), the course offer dismissed. It waits until no fetch
has been in flight for a few seconds, then lets the full-resolution frame land.

| Shot | State | Used on |
|---|---|---|
| hero | `amphan_before`, down to 1,000 m, south side cut in, floats on | 2 |
| float | the same, a float stick clicked: probe (QC, data mode, file) and profile | 2 |
| gulf | the Gulf Stream scenario, close | 2 |
| globe | the Gulf Stream scenario in Globe, winds on, camera over the Atlantic | 2 |
| assistant | the Bay; the assistant asked for an Arabian Sea oxygen cube and built it | 2 |
| amphan-before, amphan-after | the two Amphan scenarios, same camera, 28–31.5 °C bar | 5 |
| fishing | today's Bay, fishing zones and INCOIS PFZ on, the panel open | 5 |
| learn | the course, lesson 4, the quiz step | 5 |
| immersive | immersive, nine seconds into the cinematic | 5 |
| residual | *INCOIS Bay volume* ticked, currents off, the residual layer | 4 |
| fly, ui | Fly with terrain; the whole interface over the Arabian Sea oxygen cube | spares, not on a slide |

`SHOTS.tune` in the same file takes a query and a list of states from the environment,
for trying camera angles without editing the script.

`figures.py` crops each shot (`CROPS`, in the capture's own pixels) to
`figures/crop-*.jpg`. The crops are JPEG because the Canva copy embeds them as they are;
as PNG the Canva file was 32 MB. They are rebuilt on every run and not committed.

## The Canva copy

`python submission/sih/build_canva.py` writes `final/VVater-SIH2026-canva.pptx`, the same
six slides with every block editable: text boxes, cards and rules as rectangles, the
flowchart as shapes and arrows, the bar chart as rectangles. Only the screenshots and the
logo are pictures. Canva → Create a design → Import file → pick it.

It re-typesets nothing by hand. Headless Chrome lays out each `figures/body-*.html` with
Arial swapped in (present here and in Canva, so the measured widths hold), a probe script
reads back every box, text run, image and svg element, and each becomes a shape at the
same position. CSS generated content is not read: the green ticks before the brief's rows
on slide 3 are in the main deck only.

## Link check, 2026-09-25

Every URL on slide 6 was fetched with `curl -L` and a browser user agent. All returned
200 except the Leipper & Volgenau DOI, which returned 202 (the AMS page behind it refuses
scripted requests; the DOI resolves). The first PFZ link, `incois.gov.in/MarineFisheries`,
returned 404 and was replaced by the advisory page
`incois.gov.in/MarineFisheries/TextDataHome?mfid=1`. The two brief FTP links are dead and
listed as dead. The repository `github.com/Kukyos/VVater` is public. The course sources
without a URL (Gray 1968, Price 1981, Schott & McCreary 2001, the IMD Amphan report, WMO-No.
702) are cited by journal and page, as in `19-course.md`.

## Rules the deck follows

- Every number is read from `data/eval-latest.json`.
- A float on screen carries its QC legend, its probe line (QC count, data mode, source
  file) or a caption stating the QC rule (hard rule 2). The fishing panel's "not an INCOIS advisory" line is in the shot.
- Anything probed but not ingested is labelled that way on the references slide.
