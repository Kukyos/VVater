# User guide — the viewer, term by term

What every control does and what every word on screen means. Written for someone who
has never used an ocean data tool. The in-app assistant answers from this page.

## Two modes

- **Simple** — the whole ocean on a globe, one layer at a time: sea surface temperature,
  salinity, current speed, sea surface height, mixed layer depth, sea ice. A colour bar on
  the right gives the value of each colour; the timeline at the bottom steps through the
  dates, and ▶ plays them. Surface only. *Dive into the Bay of Bengal in 3D* switches to
  Advanced.
- **Advanced** — the Bay of Bengal as a 3D volume, 5 to 2,000 m deep, with every float and
  glider, the controls on the left and the inspector on the right.

## Views (Advanced; keys 1 to 4)

- **Region 3D** (1) — the working view. Drag to orbit, Shift- or right-drag to pan, scroll
  to zoom. Keyboard: **W A S D** move, **Q E** turn, **R F** zoom in and out, **↑ ↓** tilt.
  Zoom is limited, so you cannot get lost. *Reset camera* or **Home** goes back.
- **Map 2D** (2) — a flat map of the depth slice. The 3D volume cannot be drawn flat, so
  the map shows the horizontal section at the chosen depth.
- **Globe** (3) — the whole Earth with the region in the middle.
- **Fly** (4) — a plane over the sea at a fixed height, so you cannot fly into space.
  **W S** faster and slower, **A D** turn, **R F** climb and descend (between 8 and
  250 km), **↑ ↓** look up and down, drag to steer, **P** pause.

Panels fold away with **[** and **]**.

## Layers (Advanced)

- **Analysis** — the model's best estimate of the ocean, from INCOIS: temperature or
  salinity at every grid cell and depth. An estimate, not a measurement.
- **Residual vs observed** — measured minus modelled, placed in the grid cell where the
  measurement was taken. Red means the water was warmer than the model said, blue colder.
  Most cells are empty because nobody measured there; they are left empty, not guessed.

## Properties panel

- **Source** — which model: INCOIS Argo analysis (default, no account needed) or
  Copernicus GLORYS12 (finer grid, has currents).
- **Variable** — temperature (°C) or salinity (PSU, practical salinity units, roughly
  grams of salt per kilogram of water).
- **Slice depth** — cuts the volume at this depth so its top face shows the water there.
  Depths always come from the model's own levels, which are closer together near the
  surface.
- **Current streamlines** — lines that follow the water's flow at the slice depth, from
  Copernicus. Light cyan is slow, amber is fast. They show the pattern at one moment,
  not where a drifting object would end up.
- **Palette, Min, Max, Reverse, Log scale** — the colour bar: which colours, which values
  they span, and whether the scale is linear or logarithmic.
- **Opacity** — how solid the water looks.
- **Uncertainty fade** — the model reports its own error. Water it is unsure about is drawn
  fainter; at 0 this is switched off.
- **Isosurface and shell width** — draws a surface where the water equals one value, for
  example 20 °C.
- **Vertical ×** — stretches depth so the layers can be seen. The Bay is 2 km deep and
  about 2,400 km wide; at true scale it is a film.
- **20 °C isotherm** — shows where the water is 20 °C. How deep that surface lies is the
  standard stand-in for how much heat a cyclone can draw on.
- **Global sea-surface temperature** — the world's sea surface temperature around the box,
  on the same colour scale, fading out before the volume.
- **Add casts from a text file** — load your own measurements (CSV or TSV with latitude,
  longitude, time, depth or pressure, temperature). They are paired with the model like
  any float and marked unevaluated.
- **Graphics** — quality settings. *Auto* picks the best quality that keeps 60 frames a
  second on this machine; the picture sharpens to full resolution whenever it stops moving.

## Instruments and markers

- **Argo float** (blue dot) — a robot that sinks to 2,000 m every ten days and measures on
  the way up.
- **Glider** (green, or gold when unevaluated) — an underwater drone that saw-tooths along a
  track, measuring every few hours.
- **Uploaded cast** (pink) — a measurement from a file you added.
- Click any marker to draw its **profile**: measured values (blue line) against the model
  (orange line) from the surface down. Red circles are measurements that failed quality
  control; they are shown, never hidden.

## Words in the profile caption

- **QC flag** — the quality-control verdict on each measurement. Rejected levels are drawn
  red.
- **Data mode** — R real-time (automatic checks only), A adjusted, D delayed-mode (checked
  by a scientist, the most trusted), U unevaluated (no checks ever run).
- **Source file** — the exact file the numbers came from.
- **Bias** — the average of measured minus model. Negative means the model is too warm.
- **RMSE** — the typical size of the difference, whatever its sign.
- **Cyclone heat potential (TCHP)** — the heat stored in water warmer than 26 °C, in
  kilojoules per square centimetre. More heat is more fuel for a cyclone.
- **D26** — the depth where the water cools to 26 °C.

## The assistant

Ask about the data ("how warm is the water at 100 m off Chennai?", "which floats failed
quality control?") or about the viewer ("what does the residual show?"). It answers from
the data through the same functions the viewer uses. Figures it could not trace back to
the data are marked. It can also change the view for you — set a depth, open a float's
profile, switch views.
