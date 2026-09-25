# The course — learner mode

The problem statement asks for the platform to serve "educating school and college students
about ocean dynamics" and "e-learning initiatives" (`01-problem-statement.md`, *Public
Outreach & Science Communication*). This is that: six short lessons for class 8 to 12,
run inside the viewer itself on real data.

## How it works

- **First visit**: a card offers the course or "explore on my own". The choice is
  remembered in the browser. Links to a particular view (`?scenario=`, `?box=`,
  `?immersive=`, `?view=`) do not get the offer; `?learn=1` always does, once.
- **Learner mode**: the docks, the timeline and the header tools step back; one card sits
  over the globe. The header's **Learn** button opens the lesson list at any time.
- **Every move a lesson makes** goes through the same action executor as the assistant
  (`viewer/src/main.ts`, `chatHooks.apply`), so a lesson can do nothing the assistant is
  not allowed to. Two actions exist only for lessons and are in neither whitelist:
  `show_cube` (hide the block for a surface lesson) and `look_down` (see a place from
  straight above).
- **Quiz answers are read from the data on screen** wherever the question is about the
  ocean (`learn/lessons.ts`): "is 500 m colder than the surface" is answered by the cube
  the student is looking at, and the explanation quotes the model's own values. Answers
  are checked in the browser, never by the language model.
- **Your city**: the typed name goes to `GET /api/geocode`, which asks Open-Meteo's free
  geocoder (no key; nothing else is sent). It was first called from the browser directly,
  and a privacy blocker in a real browser refused it ("Failed to fetch"), so the lookup is
  the server's. `GET /api/seastate` then finds the nearest sea cell of the
  Copernicus wave model (`marine.sea_state_near`) and returns its wave height and wind
  with the distance, so an inland city is told how many hundred kilometres away its
  nearest sea is, rather than given a made-up coast.
- **Progress** (lessons done, the place) is kept in `localStorage` only: no accounts,
  nothing on the server.
- The **assistant** is under "Ask a question" at the foot of the card while the course
  runs (the same panel, moved), and back in the Inspector afterwards.

Code: `viewer/src/learn/lessons.ts` (the course as data, and the readers that compute
answers), `viewer/src/learn/tour.ts` (the card). Self-check: `lessons.demo()` runs with the
viewer's other development checks.

## The lessons

| # | Lesson | Goal | What the student does | Answers from |
|---|---|---|---|---|
| 1 | Your ocean | Find the nearest sea and read today's waves and wind there. | Types their town; picks the Bay of Bengal on the globe. | `/api/seastate` (Copernicus waves, wind); the Bay cube's land mask for the pick. |
| 2 | The ocean is 3D | See the layers: a warm lid over cold deep water, and the thermocline. | Watches a block off their own coast being cut open. | The deepest column of that cube: surface vs ~500 m; depth of steepest cooling. |
| 3 | Rivers in the sea | See a current reverse with the monsoon. | Compares January and July south of Sri Lanka. | Mean eastward current, top 50 m, 78–88 °E × 3–7 °N, from each day's cube. |
| 4 | Cyclones run on warm water | See a cyclone take heat out of the sea. | Compares the Bay before and after Amphan; picks the landfall. | Mean surface temperature of the two scenario cubes. Landfall box around IMD's position. |
| 5 | Who measures the ocean? | Meet Argo, see a model checked against a float, and QC flags. | Clicks a float; reads model against measurement. | The float and its QC flags, as in the viewer. |
| 6 | Your turn | Learn the controls. | Panels return one at a time, ringed. | — |

## General statements in the lessons, and their sources

Everything else a lesson says about the ocean on screen is computed from the data then and
there. These few general facts are stated in words and are sourced here:

| Statement (lesson) | Source |
|---|---|
| Waves are made by wind; stronger, longer and farther-blowing wind makes bigger waves (1) | Standard wind-wave growth by wind speed, duration and fetch, e.g. WMO *Guide to Wave Analysis and Forecasting* (WMO-No. 702), ch. 1. |
| Sunlight warms only the top of the sea; below it a thermocline separates warm from cold water (2) | Any introductory oceanography text; the lesson's own quiz shows it in the student's cube. |
| South of Sri Lanka the current reverses with the monsoon (3) | Schott, F. A. & McCreary, J. P. (2001), *The monsoon circulation of the Indian Ocean*, Progress in Oceanography 51, 1–123 (Southwest and Northeast Monsoon Currents). The lesson's quiz shows it in GLORYS12 for 2020. |
| Tropical cyclones generally form only over water warmer than about 26 °C (4) | Gray, W. M. (1968), *Global view of the origin of tropical disturbances and storms*, Monthly Weather Review 96, 669–700. The same 26 °C is the base of the cyclone heat potential used in `heat.py`. |
| A cyclone cools the sea by stirring up cold water from below (4) | Price, J. F. (1981), *Upper ocean response to a hurricane*, Journal of Physical Oceanography 11, 153–175. |
| Amphan became a super cyclone and crossed the coast on 20 May 2020, in the Sundarbans (4) | India Meteorological Department, *Super Cyclonic Storm "Amphan" over the southeast Bay of Bengal (16–21 May 2020): a report*. |
| Argo floats: thousands, each diving and rising about every ten days, measuring on the way up (5) | Argo Program, argo.ucsd.edu, "How Argo floats work". |

No number from the evaluation harness is quoted in a lesson; nothing here needs
`13-eval-results.md`.

## Not done (see `11-deferred.md`)

D-43: no teacher view or class results, progress in one browser only. D-44: English only.
D-45: the geocoder is a third-party service behind our API; offline the place step falls back to Chennai.
