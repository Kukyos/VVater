# First user test

**2026-09-27.** Ten classmates (engineering students) used the live site and rated it out
of 10. Recorded as reported by the team, not produced by the eval harness; the deck quotes
it as a first informal test and says who the testers were.

| # | Rating | Comment |
|---|---:|---|
| 1 | 10 | |
| 2 | 10 | his father is a fisherman |
| 3 | 9 | the interface could look less complicated without going through the tutorial |
| 4 | 10 | |
| 5 | 10 | |
| 6 | 10 | |
| 7 | 10 | loved the visuals |
| 8 | 9 | the assistant was rate-limited |
| 9 | 9 | the assistant was rate-limited |
| 10 | 10 | |

**Mean 9.7 / 10** (seven 10s, three 9s).

## What it found

- **The assistant hit its rate limit for 2 of 10.** The per-visitor and per-day caps in
  `api.py` are there to bound cost on a prepaid key; for a class or a jury using it at
  once they were too tight. The per-visitor cap was raised from 40 to 200 an hour on 2026-09-27; the 1,500 a day stays. Whether the two refusals came from this cap or from the model provider was not recorded.
- **The interface looks busy before the tutorial (1 of 10).** The Learn course and the
  first-visit hints exist; a simpler first view is the fix.

## What it is not

Classmates are not the target users. The planned test is with INCOIS forecasters,
fisheries officers and a class 8–12 group, with timed tasks, not ratings.
