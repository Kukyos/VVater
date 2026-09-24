"""Pre-fetch every named scenario, so the demo opens instantly and works offline.

    python -m server.tools.warm_scenarios                 # every scenario
    python -m server.tools.warm_scenarios gulf_stream     # one

For each scenario it builds the scenario's own variable, temperature and salinity, and the
current components (u, v) the particles need, full depth. The ARCO chunks land in
data/cache/arco and stay there (docs/11-deferred.md D-31: no eviction). Roughly 80 MB per
variable per scenario cold.
"""

import sys
import time

import truststore

truststore.inject_into_ssl()

from server.ocean import config, cube  # noqa: E402  (TLS first, then anything that fetches)


def warm(s: config.Scenario) -> None:
    box = cube.Box.parse(*s.box)
    for variable in dict.fromkeys([s.variable, "temperature", "salinity", "u", "v"]):
        t = time.time()
        try:
            c = cube.build(variable, box, s.day, float(s.depth_max))
            print(f"  {variable:12s} {c.values.shape}  {time.time() - t:5.1f} s")
        except LookupError as exc:
            print(f"  {variable:12s} unavailable: {exc}")


def main(keys: list[str]) -> None:
    for s in config.SCENARIOS:
        if keys and s.key not in keys:
            continue
        print(f"{s.title} · {s.day}")
        warm(s)


if __name__ == "__main__":
    main(sys.argv[1:])
