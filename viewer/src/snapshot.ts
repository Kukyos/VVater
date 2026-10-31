/**
 * Replay of a recorded demo when the API cannot be reached (server/ocean/snapshot.py).
 *
 * The live backend is one machine (docs/11-deferred.md D-41). When it is down at page load,
 * or dies in the middle of a demo, every GET the viewer makes is looked up in
 * `/snapshot/manifest.json` by its path and raw query string, and answered with the exact
 * bytes the real API sent when the demo was recorded. A request that was not recorded is
 * reported as missing (503, "not in the offline snapshot"); nothing near it is substituted.
 *
 * Once a fallback has happened the page stays in snapshot mode: a server that answers one
 * request in three would make a demo flicker between live and recorded data.
 */

interface Entry { file: string; type: string }
interface Manifest { recorded_utc: string; entries: Record<string, Entry> }

const ROOT = `${import.meta.env.BASE_URL}snapshot/`;

let manifest: Promise<Manifest | undefined> | undefined;
let on = false;
const listeners: ((recorded: string) => void)[] = [];

/** The lookup key: path and query, as server/ocean/snapshot.py key_of builds it. */
export function keyOf(url: string, base = location.href): string {
  const u = new URL(url, base);
  return u.pathname + u.search;
}

function load(): Promise<Manifest | undefined> {
  manifest ??= globalThis.fetch(`${ROOT}manifest.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() as Promise<Manifest> : undefined))
    .catch(() => undefined);
  return manifest;
}

export const active = (): boolean => on;

/** Called once when snapshot mode starts, with the time the snapshot was recorded. */
export function onActivate(listener: (recorded: string) => void): void {
  listeners.push(listener);
}

/** Switch to snapshot mode if there is a snapshot. True when the page is now replaying. */
export async function activate(): Promise<boolean> {
  const m = await load();
  if (!m || !Object.keys(m.entries).length) return false;
  if (!on) {
    on = true;
    for (const l of listeners) l(m.recorded_utc);
  }
  return true;
}

/** The recorded answer to a GET, or a 503 that says it was not recorded. */
export async function replay(url: string): Promise<Response> {
  const m = await load();
  const key = keyOf(url);
  const hit = m?.entries[key];
  if (!hit) {
    console.info(`not in snapshot: ${key}`);
    return new Response(JSON.stringify({ detail: "not in the offline snapshot" }), {
      status: 503, statusText: "not in the offline snapshot",
      headers: { "content-type": "application/json" },
    });
  }
  const r = await globalThis.fetch(`${ROOT}${hit.file}`);
  return new Response(await r.arrayBuffer(), { status: 200, headers: { "content-type": hit.type } });
}

/** Key building, checked against the server's own examples (snapshot.py demo). */
export function demo(): void {
  const ok = (cond: boolean, what: string) => console.assert(cond, `snapshot: ${what}`);
  ok(keyOf("http://127.0.0.1:8011/api/meta") === "/api/meta", "no query");
  ok(keyOf("/api/cube/data?lon0=78&lon1=100.5&lat0=5&day=2018-08-25&n=12", "https://v-vater.vercel.app/")
     === "/api/cube/data?lon0=78&lon1=100.5&lat0=5&day=2018-08-25&n=12", "relative base, floats kept");
  ok(keyOf("/api/geocode?name=Bay%20of%20Bengal", "https://x.app/") === "/api/geocode?name=Bay%20of%20Bengal",
     "encoded query kept as sent");
}
