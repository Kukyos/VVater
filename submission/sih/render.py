"""Render every figure in figures/*.html to a PNG of the same name.

    python submission/sih/render.py [name ...]

Headless Chrome, because it is already on the machine, it honours the webfonts the
figures use, and it produces the same pixels every run. Sizes come from the svg's own
width/height attributes, so a figure is resized by editing the figure.
"""

import re
import subprocess
import time
import sys
from pathlib import Path

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
HERE = Path(__file__).resolve().parent / "figures"

# The slide bodies share one size: the area between the 2026 template's masthead and
# its footer bar, 13.33" x 5.70" at 300 dpi. See submission/sih/figures/deck.css.
BODY_SIZE = (4000, 1710)


def size_of(html: str) -> tuple[int, int]:
    """From the svg's own attributes for a diagram, or from the `body` rule for a
    full-slide composition, which is laid out in CSS rather than inside an svg."""
    # A slide body is whatever pulls in deck.css. It is one fixed size and it may
    # contain inline svg of its own, so this test has to come before the svg one.
    if "deck.css" in html:
        return BODY_SIZE
    svg = re.search(r'<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"', html)
    if svg:
        return int(svg.group(1)), int(svg.group(2))
    raise SystemExit("give the svg literal width and height, or link deck.css")


def render(path: Path) -> Path:
    width, height = size_of(path.read_text(encoding="utf-8"))
    out = path.with_suffix(".png")
    # Delete first: the poll below cannot tell a fresh screenshot from last run's,
    # so leaving the old file there lets a stale figure through.
    out.unlink(missing_ok=True)
    subprocess.run(
        [
            str(CHROME),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--default-background-color=00000000",  # transparent: the slide is the ground
            "--virtual-time-budget=10000",          # long enough for the webfonts
            f"--window-size={width},{height}",
            f"--screenshot={out}",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    # shortcut: chrome exits before the screenshot is flushed. Poll rather than sleep
    # a fixed amount — it is usually there on the first look.
    for _ in range(50):
        if out.exists() and out.stat().st_size > 0:
            break
        time.sleep(0.1)
    else:
        raise SystemExit(f"chrome produced nothing for {path.name}")
    print(f"{path.name:20} -> {out.name}  {width}x{height}")
    return out


if __name__ == "__main__":
    wanted = sys.argv[1:]
    files = [HERE / f"{n}.html" for n in wanted] if wanted else sorted(HERE.glob("*.html"))
    files = [f for f in files if f.name != "deck.css"]
    for f in files:
        render(f)
