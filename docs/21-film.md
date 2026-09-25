# The film

A **6½-minute** film of the running build, cut in code with Remotion. Most of it is the
viewer itself, recorded from the local build. Cards carry the brief's own words and the
measured numbers. The voice is ours, recorded against the finished picture.

The script to read, with timecodes, is **`21-film-script.md`**. It is generated from
`video/script.json` by `node video/check.mjs`, so it cannot drift from the cut.

The live site, **v-vater.vercel.app**, is on the end card and in the last line. The live
backend runs on the demo laptop through ngrok (`11-deferred.md` D-41), so the link only
works while that laptop is serving. Check it before the film goes anywhere.

---

## The rules the film keeps

They are the project's rules, applied to a video.

- **No number the harness did not produce.** Every number said or shown is written as
  digits in `script.json`, and `check.mjs` matches each one against
  `data/eval-latest.json` at the precision written. A number that is not a harness figure
  must be listed under `sourced` with the file it comes from: 2,562 glider datasets, 14
  PFZ sectors, the 28–31.5 °C Amphan colour bar and a handful of others. Scenario dates and
  depths are read from `config.SCENARIOS`. The cards draw their numbers from the JSON
  (`video/src/data.ts`) and never type them.
- **Floats appear with their QC.** The float scene clicks a stick and holds on its panel:
  quality flag, data mode and source file on every level. The spoken line gives the
  rejected-level count, **201**, and says they are drawn, not dropped.
- **Never more levels than the source has.** The cut scene says the Amphan block has 35
  native levels and never one more.
- **The glider is real.** `ru29` is a Rutgers deployment read from the IOOS Glider DAC.
  Nothing in the film is synthetic. ("Synthetic" in Argo's `ArgoFloats-synthetic-BGC` is
  Argo's name for merged profiles, not made-up data.)
- **Forecasts say forecast, indicators say not-an-advisory.** Both labels are in the
  viewer's own frame, and the capture keeps the viewer's provenance line, date and status
  bar in every shot.
- **Honest about the gaps.** One card, `notyet`, names what is not done: gliders are
  nearly absent here, Europe's glider archive is not connected, and a depth-aware range
  test needs a published limit.

## How the footage is made

```
start.bat                        # API on :8011, viewer on :5173 (local; the frames are better)
cd video
npm install
node capture.cjs                 # every clip -> public/clips/*.mp4 (about an hour)
node capture.cjs globe fly       # or just some
npm run check                    # numbers, pacing, clip lengths; writes 21-film-script.md
npm run studio                   # preview
npm run render                   # check, then render -> out/vvater-film.mp4 (about 45 min)
```

The render needs neither the API nor the viewer: only the clips. It runs two frames at a
time; at four it ran the laptop out of memory partway through. Close the servers and the
browser before rendering.

**The clips are frame-stepped, not screen-recorded.** Before the page loads,
`capture.cjs` replaces `performance.now` and `requestAnimationFrame` with a virtual clock.
Data is fetched and settled on the real clock first. Then, for each frame of a clip, the
script moves the camera, advances the clock by exactly 1/30 s, and photographs the page.
A frame that takes 400 ms to draw still lands 1/30 s after the one before it, so the
currents move at their real speed and the camera never stutters, however slow the GPU is.
Frames go straight into ffmpeg: 1920×1080, 30 fps, H.264 CRF 16.

Graphics are forced to High with render-on-demand off and pause-on-move off. On Auto, a
headless GPU tunes itself down. Pause-on-move would hide the currents for every frame of
every camera move.

**A cut needs a few renders per frame.** Moving a cut rebuilds the cube's faces, and new
primitives and textures take a few renders to appear. Moved every frame with no gap, they
are never drawn, and the block renders white. The cut clip gives each frame eight renders
with the clock held before it is photographed (`rebuild` in `record()`).

**Scene lengths live in one place.** `script.json` gives each clip its seconds.
`capture.cjs` records to that length, the film sizes each scene from it, and `check.mjs`
fails if a recorded clip does not match. A line is checked against its scene at 2.3
words a second plus a second of air. That is a steady, unhurried read. A line that does
not fit fails the check, and the fix is a longer clip or fewer words.

## Recording the voice

1. Run `npm run studio` and watch the cut once with `21-film-script.md` open.
2. Record **one file per scene**, named for the scene id: `video/public/voice/tilt.wav`,
   `video/public/voice/cut.wav`, and so on (wav, mp3 or m4a). Leave half a second of
   silence at the start.
3. `npm run check` finds them, fails any that run longer than their scene, and writes
   `src/voice.json`. The film plays each one from the start of its scene.
4. `npm run render`.

One file per scene means a fluffed line costs one retake, not the whole narration. A
scene without a file is silent, so the film can be rendered at any point along the way.

There are **no subtitles**. The words actually spoken will not match the script word for
word, and captions drawn from the script would drift from the voice. The on-screen text is
titles, labels and numbers only.

## The cut

| Act | Scenes | What is on screen |
|---|---|---|
| Opening | `open`, `title`, `brief` | The immersive cinematic: the planet, then down to the Bay. The title. The brief's own sentence, verbatim. |
| The block | `tilt`, `cut` | Amphan's Bay from above (a map), tilted to the side (a block), then the south side cut inwards. |
| Floats inside the model | `floats`, `float-click` | Argo sticks in the open section; one clicked, its panel with QC flag, data mode and file. |
| Before and after | `amphan` | Same box, camera and 28–31.5 °C bar, 14 and 22 May 2020. |
| Anywhere, any day | `anywhere` | Five scenarios: Arabian Sea oxygen, Gulf Stream, El Niño, Agulhas, Drake Passage. |
| The whole ocean | `globe`, `water` | The globe in the cube's colours with currents and winds; the cinematic's low skim over the Bay. |
| For fishermen | `fishing` | INCOIS PFZ advisories and the indicative layer, labelled not-an-advisory. |
| Where the model is unsure / wrong | `volume`, `residual`, `bands` | The INCOIS Bay volume, the residual volume, the RMSE-by-depth card. |
| The model needs checking too | `qc` | 44.42 °C, the range test, and the 18 cells it cannot catch. |
| For students / Ask it | `learn`, `assistant` | Lesson 4 on Amphan; the assistant building a cube. |
| Measured / Not yet / End | `evidence`, `notyet`, `end` | The harness numbers and the command; what is not done; the live link and repository. |

## Checks before it ships

- [ ] `npm run check` passes: numbers, pacing, every clip at its length.
- [ ] v-vater.vercel.app answers, with the laptop serving (D-41).
- [ ] No IDE, terminal, notification or second window in any frame. The capture is
      headless, so none can appear. Recorded voice files contain only the voice.
- [ ] Watched once, end to end, with sound.
