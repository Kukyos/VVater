# User guide — the viewer, term by term

What every control does and what every word on screen means. Written for someone who
has never used an ocean data tool. The in-app assistant answers from this page.

## The Ocean Cube (Properties, top)

The cube is a block of ocean cut out of the planet and set down on the sea surface where
it came from, so you can look at it from the side. Every face is a slice through the data.

- **Start from** — a ready-made place and day: the Bay of Bengal, Cyclone Amphan before and
  after, the Arabian Sea's oxygen-poor layer, the Gulf Stream, the Kuroshio, the Agulhas,
  the 2015 El Niño, the Drake Passage. The line under it says why that one is interesting.
- **Variable** — what the colours show. Physics: temperature, salinity, currents, vertical
  velocity, density, speed of sound. Biogeochemistry: chlorophyll, oxygen, nitrate,
  phosphate, silicate, iron, pH, dissolved carbon, alkalinity, phytoplankton, primary
  production. All from Copernicus Marine models; density and sound speed are worked out
  from temperature and salinity.
- **Day** — any day from 1993 to about nine days ahead. The line under it says which model
  the day comes from. Days after today are a **forecast** and are marked in yellow.
- **Down to** — how deep the cube goes, down to the sea floor.
- **West, East, South, North** — the box, in degrees. **Draw a box** lets you drag one on
  the globe instead (Esc cancels). **Load cube** fetches it. A cube can be up to 100° wide.
- **Argo floats in the cube** — every float that measured inside the box within two days.
  Each is a stick, white at the top where it surfaced, coloured down its length by what it
  measured on the same colour bar as the cube. Red parts failed quality control. Behind a
  face a stick is drawn dashed. Click one to compare it with the model.

The first time a place or day is asked for it can take 5 to 20 seconds; after that it is
kept and opens at once.

## Cut & look

- **Top, Bottom** — cut the cube from above or below. The top face then shows the water at
  that depth.
- **West, East, South, North side** — move a side inwards; that wall now shows the inside.
- **Height** — how tall the cube is drawn. The ocean is a few kilometres deep and thousands
  wide, so depth is stretched; the number (×250 and so on) says by how much.
- **Stretched depth** — gives the upper ocean, where most change happens, more room. Off,
  depth is drawn evenly. The depth labels on the corner are always true depths.
- **Contours** — thin lines at round values, like height lines on a map.
- **Native levels only** — shows the model's own depth levels as bands, with nothing
  blended between them. Off, colours are blended between levels, as sections are usually
  drawn.
- **Whole cube** puts the cuts back; **Look at it** points the camera at the cube.

## Whole ocean

- **The whole ocean at the cube's top depth** — the rest of the planet painted with the same
  variable, day and colours as the cube. Grey land is land.
- **Animated currents** — moving streaks that follow that day's currents, over the whole
  ocean and on the cube's top. Faster water is brighter. They show the flow on that one day;
  they are not the path a drifting object would take over time.
- **Particles** — how many streaks. Fewer is faster on a slow computer.

## Probe (Inspector)

Hover over the cube to read the value, depth and position under the pointer. Click the cube
to draw that place's whole column, one dot per model level. Hover over a float stick for its
number, time, data mode and source file.

## INCOIS Bay volume

The older view of the Bay of Bengal, drawn from INCOIS's own analysis as a see-through
volume under the sea, with the residual and every glider cast. Tick it to switch to it; the
controls below (Layers, Properties) belong to it.

## Views (keys 1 to 4)

- **Region 3D** (1) — the working view, orbiting the cube. Drag to orbit, Shift- or right-drag to pan, scroll
  to zoom. Keyboard: **W A S D** move, **Q E** turn, **R F** zoom in and out, **↑ ↓** tilt.
  Zoom is limited, so you cannot get lost. *Reset camera* or **Home** goes back.
- **Map 2D** (2) — a flat map of the cube's top face (or, in the Bay volume, the depth
  slice).
- **Globe** (3) — the whole Earth with the region in the middle.
- **Fly** (4) — a plane over the sea at a fixed height, so you cannot fly into space.
  **W S** faster and slower, **A D** turn, **R F** climb and descend (between 8 and
  250 km), **↑ ↓** look up and down, drag to steer, **P** pause.

Panels fold away with **[** and **]**.

## Layers (INCOIS Bay volume)

- **Analysis** — the model's best estimate of the ocean, from INCOIS: temperature or
  salinity at every grid cell and depth. An estimate, not a measurement.
- **Residual vs observed** — measured minus modelled, placed in the grid cell where the
  measurement was taken. Red means the water was warmer than the model said, blue colder.
  Most cells are empty because nobody measured there; they are left empty, not guessed.

## Bay volume properties

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
