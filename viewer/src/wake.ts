/**
 * The live site's backend is a laptop behind ngrok (docs/11-deferred.md D-41). When it is
 * off, every request fails and the page would open broken. Instead: say so, and let the
 * visitor ping the team, who start the server within 30 minutes. The page keeps checking
 * and carries on by itself once the API answers.
 *
 * The ping is an ntfy push (ntfy.sh, no account): the team's phone subscribes to TOPIC in
 * the ntfy app. Plain-text POST with query parameters, so the browser sends no preflight.
 */
import { BASE, healthy } from "./api";

// ponytail: the topic ships in the public bundle, so anyone who reads it can ping or
// subscribe. The random name stops guessing, not reading; a Vercel function holding a
// secret is the upgrade if that is ever abused.
export const TOPIC = "vvater-wake-d83b0af66b99";
const SENT_KEY = "vvater.wake.sent";
const WAIT_MS = 30 * 60_000;
const POLL_MS = 30_000;

const stored = (): number => {
  try { return Number(localStorage.getItem(SENT_KEY)) || 0; } catch { return 0; }
};
const remember = (t: number): void => {
  try { localStorage.setItem(SENT_KEY, String(t)); } catch { /* private window: no cooldown */ }
};
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Resolves once the API answers. Local development never waits: there is nobody to ping. */
export async function awaitServer(): Promise<void> {
  if (/localhost|127\.0\.0\.1/.test(BASE) || await healthy()) return;

  const card = document.createElement("div");
  card.id = "wake";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "The server is off");
  card.innerHTML = `
    <b class="wake-title">The ocean server is asleep</b>
    <p>VVater's data server runs on our team's computer, and it is switched off right now.</p>
    <div class="wake-body" aria-live="polite"></div>
    <p class="wake-small">Meanwhile, the code, the docs and every measured number:
      <a href="https://github.com/Kukyos/VVater" target="_blank" rel="noopener">github.com/Kukyos/VVater</a></p>`;
  document.body.append(card);
  const body = card.querySelector<HTMLElement>(".wake-body")!;

  const waiting = (at: number) => {
    body.innerHTML = `<p><b>Message sent at ${clock(at)}.</b> We'll start the server within
      30 minutes. Keep this tab open: it checks every 30 seconds and opens by itself.</p>`;
  };
  const ask = (error = "") => {
    body.innerHTML = `<p>Press the button and we get a message on our phone. We'll start
      the server within 30 minutes.</p>
      ${error ? `<p class="wake-error">The message did not go through (${error}). Please try again.</p>` : ""}
      <button class="btn on wake-send">Message server</button>`;
    const button = body.querySelector<HTMLButtonElement>(".wake-send")!;
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Sending…";
      const at = Date.now();
      const q = new URLSearchParams({ title: "VVater: start the server", priority: "high",
                                      tags: "ocean", click: location.href });
      try {
        const r = await fetch(`https://ntfy.sh/${TOPIC}?${q}`, {
          method: "POST",
          body: `A visitor at ${clock(at)} (their time) is waiting for the server. Run serve.bat.`,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        remember(at);
        waiting(at);
      } catch (e) {
        ask((e as Error).message);
      }
    });
  };

  const sent = stored();
  if (Date.now() - sent < WAIT_MS) waiting(sent); else ask();

  await new Promise<void>((resolve) => {
    const timer = window.setInterval(async () => {
      if (!(await healthy())) return;
      window.clearInterval(timer);
      card.remove();
      resolve();
    }, POLL_MS);
  });
}
