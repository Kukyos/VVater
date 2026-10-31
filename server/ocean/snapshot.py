"""Record what the API answered, so the static site can replay it with no server.

The live site's backend is one machine (docs/11-deferred.md D-41). If it, or the venue
network, fails during a demo, the viewer falls back to a **snapshot**: the exact bytes the
API sent for a recorded walk through the demo, served as static files beside the site.

Recording is a switch on the real server, not a second code path that could drift from it:

    VVATER_RECORD=viewer/public/snapshot uvicorn server.ocean.api:app --port 8011

then click through the demo in the viewer. Every successful GET under /api/ is written as
one file, and `manifest.json` maps the request (path plus raw query string, exactly as the
browser sent it) to that file. The viewer (viewer/src/snapshot.ts) looks a request up by
the same key. Nothing is computed, filled or interpolated on replay: a request that was
not recorded is reported as missing, never answered with something near it.

    python -m server.ocean.snapshot     # self-check, no network
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

MANIFEST = "manifest.json"

# Requests that are never recorded: they change state or answer one person.
SKIP = ("/api/chat", "/api/casts")


def key_of(path: str, query: str) -> str:
    """The lookup key: path, then '?' and the raw query string when there is one. The
    viewer builds the same string from `URL.pathname + URL.search`."""
    return f"{path}?{query}" if query else path


def file_for(key: str, media_type: str) -> str:
    ext = ".json" if "json" in media_type else ".bin"
    return hashlib.sha1(key.encode()).hexdigest()[:20] + ext


def wanted(method: str, path: str, status: int) -> bool:
    return (method == "GET" and status == 200 and path.startswith("/api/")
            and not path.startswith(SKIP))


def record(root: Path, key: str, body: bytes, media_type: str) -> None:
    """Write one response and its manifest line. Synchronous on purpose: the read-modify-
    write of the manifest has no await inside it, so two requests cannot interleave."""
    root.mkdir(parents=True, exist_ok=True)
    name = file_for(key, media_type)
    (root / name).write_bytes(body)
    path = root / MANIFEST
    manifest = (json.loads(path.read_text("utf-8")) if path.exists()
                else {"recorded_utc": "", "entries": {}})
    manifest["entries"][key] = {"file": name, "type": media_type}
    manifest["recorded_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    path.write_text(json.dumps(manifest, indent=1, sort_keys=True), "utf-8")


def demo() -> None:
    import tempfile
    assert key_of("/api/meta", "") == "/api/meta"
    k = key_of("/api/cube/data", "lon0=78&lon1=100.5&lat0=5&day=2018-08-25&n=12")
    assert k == "/api/cube/data?lon0=78&lon1=100.5&lat0=5&day=2018-08-25&n=12"
    assert file_for(k, "application/octet-stream").endswith(".bin")
    assert file_for(k, "application/json").endswith(".json")
    assert file_for(k, "x") == file_for(k, "x"), "stable name"
    assert wanted("GET", "/api/meta", 200)
    assert not wanted("GET", "/api/meta", 404), "a failure is not replayed"
    assert not wanted("POST", "/api/chat", 200) and not wanted("GET", "/api/casts", 200)
    assert not wanted("GET", "/wms", 200), "only the viewer's API"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        record(root, "/api/meta", b'{"a":1}', "application/json")
        record(root, k, b"\x00\x01", "application/octet-stream")
        m = json.loads((root / MANIFEST).read_text("utf-8"))
        assert set(m["entries"]) == {"/api/meta", k}
        assert (root / m["entries"][k]["file"]).read_bytes() == b"\x00\x01"
    print("snapshot ok: keys, file names, what is recorded, manifest")


if __name__ == "__main__":
    demo()
