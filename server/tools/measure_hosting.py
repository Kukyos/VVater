"""What a host needs: RAM, CPU, disk and bytes sent over one cold-cache viewer session.

Runs a copy of `server/` from a temp directory so the cache starts empty, as on a fresh
host, and the repo's own `data/cache` is untouched. Touches every scenario cube, casts, one
Argo profile, currents, wind, fishing, PFZ, the whole-ocean layers, the INCOIS volume, Argo.

    python -m server.tools.measure_hosting [ZARR_CONCURRENCY]   # ~20 min, needs network

Results in docs/18-deploy.md, "What a host needs". Needs psutil (not in requirements.txt).
"""
import json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
import psutil

REPO = Path(__file__).resolve().parents[2]
HERE = Path(tempfile.gettempdir()) / "vvater-measure"
PORT = 8013
if HERE.exists():
    shutil.rmtree(HERE)
HERE.mkdir()
shutil.copytree(REPO / "server", HERE / "server", ignore=shutil.ignore_patterns("__pycache__"))
if (REPO / ".env").exists():
    shutil.copy(REPO / ".env", HERE / ".env")

env = dict(os.environ, ZARR_CONCURRENCY=sys.argv[1] if len(sys.argv) > 1 else "32")
t_start = time.time()
proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "server.ocean.api:app",
                         "--host", "127.0.0.1", "--port", str(PORT)], cwd=HERE, env=env,
                        stdout=subprocess.DEVNULL, stderr=open(HERE / "server.log", "w"))
samples = []  # (t, rss, cpu_percent)
stop = False

def sampler():
    p.cpu_percent()
    while not stop:
        try:
            samples.append((time.time() - t_start, p.memory_info().rss, p.cpu_percent(), p.num_threads()))
        except psutil.Error:
            break
        time.sleep(0.2)

def get(path, **q):
    url = f"http://127.0.0.1:{PORT}{path}" + ("?" + urllib.parse.urlencode(q) if q else "")
    c0 = sum(p.cpu_times()[:2]); t0 = time.time()
    try:
        with urllib.request.urlopen(url, timeout=600) as r:
            body = r.read(); status = r.status
    except urllib.error.HTTPError as e:
        body = e.read(); status = e.code
    except Exception as e:
        body = str(e).encode(); status = "ERR"
    dt = time.time() - t0; cpu = sum(p.cpu_times()[:2]) - c0
    rss = p.memory_info().rss / 2**20
    log.append({"path": path, "q": q, "status": status, "s": round(dt, 1), "cpu_s": round(cpu, 1),
                "kb": round(len(body) / 1024), "rss_mb": round(rss)})
    print(f"{status} {dt:6.1f}s cpu {cpu:5.1f}s {len(body)/1024:8.0f} KB rss {rss:5.0f} MB  {path} {q}", flush=True)
    try:
        return json.loads(body)
    except Exception:
        return None

log = []
while True:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2); break
    except Exception:
        time.sleep(0.5)
boot = time.time() - t_start
# The venv's python.exe on Windows is a launcher; the server is whoever holds the port.
p = psutil.Process(next(c.pid for c in psutil.net_connections("tcp")
                        if c.laddr.port == PORT and c.status == psutil.CONN_LISTEN))
threading.Thread(target=sampler, daemon=True).start()
idle_rss = p.memory_info().rss / 2**20
print(f"boot {boot:.1f}s, idle {idle_rss:.0f} MB")

# The viewer's startup, then a session that touches every feature once.
get("/api/meta")
cat = get("/api/catalog") or {}
layers = get("/api/global/layers") or {}
days = layers.get("days") or []
if days:
    for layer in ("temperature", "salinity"):
        get("/api/global/meta", layer=layer, day=days[-1]); get("/api/global/data", layer=layer, day=days[-1])
get("/api/pfz")
for s in cat.get("scenarios", []):
    lon0, lon1, lat0, lat1 = s["box"]
    box = dict(lon0=lon0, lon1=lon1, lat0=lat0, lat1=lat1, day=s["day"])
    get("/api/cube/meta", variable="temperature", **box)
    get("/api/cube/data", variable="temperature", **box)
    casts = get("/api/cube/casts", variable="temperature", **box) or {}
    first = (casts.get("casts") or [None])[0]
    if first:
        get("/api/cube/profile", variable="temperature", platform=first.get("platform"),
            cycle=first.get("cycle", 0), **box)
    get("/api/cube/currents/meta", **box); get("/api/cube/currents/data", **box)
    get("/api/wind/meta", day=s["day"]); get("/api/wind/data", day=s["day"])
    get("/api/fishing", **box)
bay = cat.get("scenarios", [{}])[0]
if bay:
    lon0, lon1, lat0, lat1 = bay["box"]
    get("/api/cube/data", variable="salinity", lon0=lon0, lon1=lon1, lat0=lat0, lat1=lat1, day=bay["day"])
    get("/api/surface/meta", variable="temperature", day=bay["day"]); get("/api/surface/data", variable="temperature", day=bay["day"])
# INCOIS Bay volume + Argo path
m = get("/api/meta") or {}
get("/api/volume/meta", variable="temperature", source=m.get("defaultSource", ""), time_index=0)
get("/api/volume/data", variable="temperature", source=m.get("defaultSource", ""), time_index=0, n=200000)
get("/api/observations", on=m.get("demoDate", ""), variable="temperature")
# Repeat the Bay cube: the warm path
if bay:
    get("/api/cube/data", variable="temperature", lon0=lon0, lon1=lon1, lat0=lat0, lat1=lat1, day=bay["day"])

time.sleep(3)
settled = p.memory_info().rss / 2**20
stop = True
total_cpu = sum(p.cpu_times()[:2])
p.kill(); proc.terminate()

peak = max(s[1] for s in samples) / 2**20
busy = [s[2] for s in samples if s[2] > 1]
disk = sum(f.stat().st_size for f in (HERE / "data").rglob("*") if f.is_file()) / 2**20 if (HERE / "data").exists() else 0
out = {
    "zarr_concurrency": env["ZARR_CONCURRENCY"], "boot_s": round(boot, 1), "idle_mb": round(idle_rss),
    "peak_mb": round(peak), "settled_mb": round(settled), "max_threads": max(s[3] for s in samples),
    "cpu_total_s": round(total_cpu, 1), "wall_s": round(time.time() - t_start, 1),
    "cpu_pct_p50": sorted(busy)[len(busy)//2] if busy else 0, "cpu_pct_max": max(busy) if busy else 0,
    "cores": psutil.cpu_count(), "sent_mb": round(sum(r["kb"] for r in log) / 1024, 1),
    "cache_disk_mb": round(disk), "requests": log,
}
(HERE.parent / f"vvater-measure-{env['ZARR_CONCURRENCY']}.json").write_text(json.dumps(out, indent=1))
print(json.dumps({k: v for k, v in out.items() if k != "requests"}, indent=1))
