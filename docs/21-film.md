# The film

A film of the running build, about **6⅓ minutes**, cut in code with Remotion. Most of it is
the viewer itself, recorded from the local build. Cards carry the brief's own words and the
measured numbers. One narrator, ElevenLabs' **Charlotte**, reads every line.

It renders as **two copies with the same picture and timing**: `out/vvater-film.mp4` with
the narration, and `out/vvater-film-no-voice.mp4` without it. The scenes are sized to
Charlotte's read either way.

The script to read, with timecodes, is **`21-film-script.md`**. It is generated from
`video/script.json` by `node video/check.mjs`, so it cannot drift from the cut.

The live site, **v-vater.vercel.app**, is on the end card; the last line points at it. The live
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
npm run narrate                  # Charlotte reads what changed, and each scene is sized to its line
npm run check                    # numbers, pacing, clip lengths; writes 21-film-script.md
npm run studio                   # preview
npm run render                   # check, render, then both copies (about 45 min)
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

**Mouse and keyboard are real input events.** The box-drawing and assistant clips drive
Puppeteer's mouse and keyboard frame by frame: the box is dragged on the globe, the question
is typed one character a frame and Ask is pressed. Headless Chrome draws no pointer, so the
film's pointer is a small arrow that follows the events the page receives. Anything
those actions wait on (the block loading, the assistant answering) happens on the real
clock between frames, so **a wait is shorter in the film than it was**. Nothing on screen is
staged: the reply and the block are what the running system returned.

**Scene lengths live in one place.** `script.json` gives each clip its seconds.
`capture.cjs` records to that length, the film sizes each scene from it, and `check.mjs`
fails if a recorded clip does not match, or if a scene cannot hold its narration from half
a second in.

## The voice

`video/narrate.mjs` sends each scene's line to ElevenLabs as **Charlotte**
(`6fZce9LFNG3iEITDfqZZ`, `eleven_multilingual_v2`), using `ELEVENLABS_API_KEY` from `.env`,
and writes `video/public/voice/<scene>.mp3`. A line re-renders only when its text or the
voice changes: the hash of both sits in `public/voice/narration.json`. The mp3s are
committed, so a render needs no credits.

`--fit` then sizes each scene to its line: half a second in, a second and a half after.
Cards are set to exactly that, never under their `minSeconds` reading time. Clip scenes only
grow, and the clips that grew are listed to be recorded again.

The screen keeps the spelling; `speak` in `script.json` holds how a word is *said*:
**VVater is said "Water"**. The last line points at the link on screen rather than
spelling a URL aloud.

To use your own voice instead, drop `public/voice/<scene>.wav` in place of that scene's
mp3. `check.mjs` measures whatever is there.

There are **no subtitles**. The on-screen text is titles, labels and numbers only.

## The cut

| Act | Scenes | What is on screen |
|---|---|---|
| Opening | `open`, `title`, `index`, `brief` | The immersive cinematic; the title; **the index**: nine tiles on one screen, each looping two seconds of its section with its title under it, lit in the order the line names them; the brief's own sentence. |
| The block | `tilt`, `cut`, `draw`, `controls` | Amphan's Bay from above, tilted to the side, the south side cut in; a box dragged on the globe with the mouse and its block appearing; the properties panel scrolled top to bottom. |
| Floats inside the model | `floats`, `float-click` | Argo sticks in the open section; one clicked, its panel with QC flag, data mode and file. |
| Before and after | `amphan` | Same box, camera and 28–31.5 °C bar, 14 and 22 May 2020. |
| Anywhere, any day | `anywhere` | Arabian Sea oxygen, Gulf Stream, El Niño, Agulhas, Drake Passage. |
| The whole ocean | `globe`, `dawn`, `fly`, `views` | The globe with currents and winds; the cinematic's sunrise; Fly up Sri Lanka's east coast with the sea as imagery; the four views clicked in turn. |
| How it is built | `stack` | Browser, server, data: the card, about 30 s. |
| For fishermen | `fishing` | INCOIS PFZ advisories and the indicative layer, labelled not-an-advisory. |
| Where the model is wrong | `bands`, `qc` | RMSE by depth against floats and an independent glider; 44.42 °C and the range test. |
| For students / Ask it | `learn`, `assistant` | Lesson 4 on Amphan; a question typed, answered, and its block built live. |
| Measured / Not yet / End | `evidence`, `notyet`, `end` | The harness numbers and the command; what is not done; the live link and repository. |

**Fly has the ocean colour layer off.** From a plane, the 1/4° temperature cells read as
blocks along the coast; the sea is shown as imagery, with the currents over it.

## Checks before it ships

- [ ] `npm run check` passes: numbers, pacing, every clip at its length.
- [ ] v-vater.vercel.app answers, with the laptop serving (D-41).
- [ ] No IDE, terminal, notification or second window in any frame. The capture is
      headless, so none can appear.
- [ ] Watched once, end to end, with sound.

The INCOIS Bay volume and residual views (v1) were in the first cut and were taken out: next
to the cube they read as an older product. Their finding stays, as the `bands` card.
