# Portal form: final submission text

The text entered on the SIH portal for the final submission. Every number comes from the
deck (`final/VVater-SIH2026-finalv2`), and every deck number comes from `13-eval-results.md`.
Lengths on 2026-09-30: title 86 of 100, abstract 2,627 of 10,000, description 9,729 of 50,000 characters.

## Idea Title (max 100)

<!-- title -->
VVater: cut the ocean open in 3D, and see where the model and the real floats disagree
<!-- /title -->

## Technology Bucket

Big Data Analysis

## Idea Template

`submission/sih/final/VVater-SIH2026-finalv2.pdf`

## Abstract / Summary (max 10,000)

<!-- abstract -->
Picture the sea as a cake. Every map of it shows only the icing: the surface. The part that matters for cyclones, fishing and climate is underneath, in the layers, and forecasters have had to piece it together from 2D plots in several different programs.

VVater lets you cut a 3D block out of the ocean and look at it from the side, like a slice of cake. Draw a box anywhere on Earth, pick any day from 1993 up to the forecast, choose from 23 variables (temperature, salinity, currents, oxygen, chlorophyll, nutrients and more), and the block appears on a 3D globe, coloured at every depth the model actually has. Then cut into it from any side to see inside.

Real instruments stand inside the same block. Argo floats appear as upright sticks where they actually sampled. Click one and you get its readings beside the model's, on the same day. Gliders, RAMA moorings and your own CTD files work the same way. Every reading keeps its quality flag and source file; a bad reading is shown in red, never quietly dropped.

Putting the two together showed us something a single number hides. Below 300 m, the INCOIS model and the instruments agree well. In the top 300 m, the warm layer a cyclone feeds on, an independent glider finds the model off by 2.89 °C. The 3D view makes that visible at a glance.

It is built for four kinds of people:
- Forecasters: compare the Bay of Bengal before and after Cyclone Amphan (14 and 22 May 2020) and see the cold wake the storm left; the box's mean surface is 0.77 °C cooler afterwards.
- Fishermen: INCOIS's own fishing-zone advisories, all fourteen sectors as published, next to today's waves and wind.
- Students: a six-lesson course for classes 8 to 12, on real data, where quiz answers are read from the cube on screen.
- The public: an immersive view and a cinematic tour of a day of the planet's currents and winds, for exhibitions.

There is also an AI assistant. Ask in plain words ("show me oxygen in the Arabian Sea") and it builds the view for you. It can only reach data through our own API, and any number it cannot trace is flagged on screen. In our test it built the asked-for cube 5 times out of 5, with a median reply time of 4.6 seconds.

It runs in any browser with nothing to install. Nothing has to be downloaded or archived first: it reads only the pieces of the Copernicus and INCOIS data a box needs, straight from where they are published. A cached view opens in 0.08 s, and the whole server peaked at 639 MB of memory over a full test session.

It is open source, and every number we quote is produced by a test script in the repository: github.com/Kukyos/VVater
<!-- /abstract -->

## Idea Description (max 50,000)

<!-- description -->
THE PROBLEM, IN ONE PICTURE

The ocean is not a flat sheet. The temperature a cyclone feels, the depth where fish gather, the layers with too little oxygen: all of it happens below the surface, in three dimensions. INCOIS already produces this data every day, as 3D model outputs and as readings from Argo floats and gliders. But there has been no single place, in a web browser, where you can see the model's 3D ocean and the real measurements together. Forecasters switch between separate tools, look at flat slices, and try to join them up in their heads.

The problem statement lists five gaps: no 3D web view of model fields, no way to see floats and gliders beside the model, no proper controls for variable, depth, time and colour, no easy way to add new data, and no tools for quick understanding. VVater answers all five in one working platform.

WHAT VVATER IS

A website where you cut a block out of the ocean and look at it from the side.

1. Draw a box anywhere on the globe.
2. Pick a day, anywhere from 1993 up to the forecast.
3. Pick a variable: temperature, salinity, density, sound speed, currents, oxygen, chlorophyll, nutrients, pH, carbon, and more. There are 23 in all, plus machine-learning estimates of chlorophyll, particle backscatter and organic carbon.
4. The block appears on a 3D globe, standing on the sea surface, coloured at every depth the model really has. We never invent depth levels the data does not have.
5. Slide any side, the top or the bottom inwards, and the faces become cross-sections through the inside.
6. Press Play and it steps through time, day by day.

The rest of the planet is painted with the same variable and the same colour bar, with that day's currents flowing over it as moving particles. So you always see your block in context.

REAL INSTRUMENTS INSIDE THE MODEL

This is the heart of the idea. The model is a best guess; instruments are what the ocean actually said. VVater puts both in one scene.

- Argo floats (core and biogeochemical) stand inside the block as upright sticks, at the place and depth they sampled.
- Click a float and a chart opens: its readings down the water column, with the model's values for the same spot and the same day drawn beside them. Where the two lines split, the model is wrong.
- Gliders, RAMA moorings and CTD casts come in the same way. You can also drop in your own CSV file of casts and it appears on the globe.
- Every reading carries its quality flag, its data mode (real-time or checked) and the file it came from. Readings that fail quality control are drawn in red, never removed. In the Bay, 510 of 11,525 float levels fail QC, and you can see every one of them.

WHAT WE FOUND BY USING IT

We compared the INCOIS Bay of Bengal analysis with 29 Argo profiles and 98 glider casts, level by level.

- Below 300 m, the model and the instruments agree: errors of 0.19 to 0.35 °C.
- In the top 300 m, the error jumps. Against Argo it is 1.26 °C. Against an independent glider, whose data the model never used, it is 2.89 °C.

The top 300 m is exactly the warm layer a cyclone feeds on. A single average across all depths hides this completely. The 3D view shows it straight away. That is the argument for this platform in one result.

We also check the model itself, not just the instruments. On one day the INCOIS analysis had 6 cells reading above 40 °C at depth, which is physically impossible there. VVater masks them and counts them in a provenance panel, instead of drawing them as if they were real.

WHO IT IS FOR

Forecasters and disaster management.
Open Cyclone Amphan: the Bay of Bengal on 14 May 2020, before the storm, and on 22 May, after it. Same colour bar, same camera. The cold wake the cyclone churned up is plain to see, and the box's mean surface temperature is 0.77 °C lower afterwards. A 20 °C isotherm preset shows the depth of warm water, a standard measure of how much heat is available to a cyclone, and cyclone heat potential is worked out for each float.

Fishermen and fisheries officers.
INCOIS's own Potential Fishing Zone advisories, all fourteen sectors, exactly as published, shown next to today's waves and wind. Our own fishing indicator is clearly labelled "not an advisory", so the official word always comes first.

Students and teachers.
A six-lesson course for classes 8 to 12, built on the same live data forecasters use. Lessons cover why cyclones need warm water, how a cyclone cools the sea, how the monsoon current reverses, and how floats work. Quiz answers are read from the cube on screen, never made up by a language model.

The public and policymakers.
An immersive view and a cinematic tour: one day of the whole planet's currents and winds, made for exhibitions, outreach events and awareness campaigns. There is also a Fly view, a few kilometres above the sea and coast, as a pilot would see it.

AN ASSISTANT THAT DOES THINGS, NOT JUST TALKS

Type a question in plain words, like "show me oxygen in the Arabian Sea", and the assistant builds that view: it picks the box, the variable and the depth, and opens the cube. It can also open a float's profile, switch views and turn on the 20 °C isotherm.

We were careful with it. The assistant can only get data through our own API tools, so it sees what the user sees. Any number in its reply that cannot be traced to a tool result is flagged on screen. In our test it built the requested cube 5 times out of 5, with a median reply time of 4.6 seconds.

HOW IT WORKS

The website (what you see):
- CesiumJS and WebGL for the 3D globe and the cube, written in TypeScript with Vite.
- Runs in any modern browser on any computer. Only the link is needed; nothing to install.

The server (what does the work):
- Python, with FastAPI.
- Step 1: fetch only the chosen box, never the whole ocean. The data is read piece by piece from the Copernicus Marine cloud stores and from INCOIS's ERDDAP server.
- Step 2: keep a copy on disk, so the same view opens instantly next time. A cached Amphan cube opens in 0.08 s and sends 1.15 MB to the browser.
- Step 3: check quality. Hide impossible values; keep each float's QC flag.
- Step 4: build the 3D block on the model's real depth levels, and derive density and sound speed with the TEOS-10 seawater standard.
- Over a full test session from a cold start, the server answered 97 of 97 requests and peaked at 639 MB of memory. One small server is enough.

The data (all public, all tested):
- Copernicus Marine GLORYS12 and the global analysis and forecast, physics and biogeochemistry.
- INCOIS ERDDAP: the Argo 10-day analysis for the Bay of Bengal, with per-cell error.
- Ifremer Argo ERDDAP and the Argo GDAC for floats anywhere.
- U.S. IOOS Glider DAC for gliders.
- Copernicus Marine In Situ TAC for moorings, CTD, ADCP and HF-radar.
- INCOIS Potential Fishing Zone advisories, and NOAA GFS winds.

The two FTP links given in the problem statement are blocked on normal networks, so we found and tested HTTPS sources for the same data.

EVERYTHING THE BRIEF ASKED FOR, BY NAME

- 3D volumetric rendering across the full water column: yes.
- Depth-slice views: yes, cut from any side.
- Isosurface extraction: yes, including the 20 °C isotherm, in the INCOIS Bay volume.
- Time-step animation: yes, Play.
- Argo, glider, CTD and BGC data on the globe: yes, click any float or glider for a depth-vs-value chart with timestamps.
- NetCDF and text parsers: yes. Both paths give identical results on the same 222 casts.
- Colour bar editor: palette, min/max range, linear or log scale.
- Variable selector, layer opacity, vertical exaggeration: yes.
- Modern JavaScript frontend with a lightweight REST API backend: yes.
- Easy to extend: a new model variable is one line in a catalogue; a new sensor is one entry in a registry. That is how the moorings and the machine-learning products were added.
- Open standards: an OGC WMS endpoint for the Bay layers, and CF conventions for NetCDF, read carefully because real files do not always follow them. WCS is on our roadmap for INCOIS deployment.

WHAT IS NEW HERE

- Floats inside the model: observation and model in one 3D scene, compared on the same day.
- No archive to build: any day since 1993, anywhere, read directly from the source a box at a time.
- The model gets checked too: impossible values are masked and counted, and INCOIS's own error estimate is drawn so uncertain water looks faint.
- An assistant that acts, with its numbers checked against the data.
- A course on live data, for schools.
- A flight view and an immersive view for outreach.

BEING HONEST ABOUT LIMITS

We keep a public list of everything that is not finished, with the reason. A few examples:
- There is no public HF-radar or ADCP data for the Bay yet. The readers are built and tested on real files from elsewhere, ready for INCOIS data.
- Currents are drawn as moving particles over the map, not inside the 3D block.
- WCS is not built yet; WMS is.
We would rather say this plainly than claim something that does not work.

COST AND SUSTAINABILITY

- All the data is free and public; nothing is bought or stored in bulk.
- Open source, no licences. A static website plus one server.
- The only running cost is the AI assistant's calls, and questions are capped per visitor.
- Changing a data source means changing one fetch function.
- A test script re-reads every source and regenerates every number we quote.

ROADMAP

- Now: built and working, including the machine-learning products.
- 3 months: a pilot with INCOIS and with schools.
- 6 months: running on INCOIS servers, with single sign-on and OGC WCS.
- 12 months: HF-radar and more ocean basins.

LINKS

Source code, documentation and every measured number: github.com/Kukyos/VVater
<!-- /description -->
