/**
 * Learner mode: the course in `lessons.ts`, run in one floating card over the globe.
 *
 * The card is the only thing it adds to the screen. The docks, the timeline and the header
 * tools are hidden by one class on #app while it runs, and put back as they were when it
 * ends. Every move a lesson makes goes through the same action executor as the assistant,
 * so the course cannot do anything the assistant is not already allowed to do.
 *
 * Progress lives in this browser only (localStorage): no accounts, nothing sent anywhere.
 */

import * as api from "../api";
import type { ChatAction } from "../api";
import type { CubeController } from "../cube/controller";
import { type Ctx, DEFAULT_PLACE, LESSONS, type Place, type Quiz, type Step } from "./lessons";

export interface TourHooks {
  /** The assistant's executor: whitelisted, clamped. */
  run: (action: ChatAction) => Promise<void>;
  cube: CubeController;
  today: () => string;
  /** Open (true) or close both docks; returns what they were, to put back later. */
  docks: (open?: { left: boolean; right: boolean }) => { left: boolean; right: boolean };
  /** Calls back with the next place clicked on the globe; returns a cancel. */
  pick: (then: (lat: number, lon: number) => void) => () => void;
  /** The assistant's panel, borrowed into the card and handed back on exit. */
  chat: HTMLElement;
  /** The view on screen, to go back to when the course ends. */
  view: () => string;
}

interface Saved { seen?: boolean; done?: string[]; place?: Place; sea?: api.SeaState }

const KEY = "vvater.learn";
function load(): Saved {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved; } catch { return {}; }
}
function save(s: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not remembered, still works */ }
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (t: string | ((c: Ctx) => string), c: Ctx) => (typeof t === "string" ? t : t(c));

export class Tour {
  private card: HTMLElement;
  private body: HTMLElement;
  private saved = load();
  private ctx: Ctx;
  private lesson = 0;
  private step = 0;
  private docksBefore?: { left: boolean; right: boolean };
  private viewBefore = "region";
  private chatHome?: ParentNode | null;
  private cancelPick?: () => void;
  private waitTimer = 0;
  private run = 0;  // a newer step makes an older one's late results land nowhere

  constructor(private hooks: TourHooks) {
    // The sea point is kept with the place; its waves are re-read whenever lesson 1 runs.
    this.ctx = { place: this.saved.place ?? DEFAULT_PLACE, sea: this.saved.sea, cube: hooks.cube,
                 today: hooks.today(), memo: {} };
    this.card = document.createElement("div");
    this.card.id = "learn";
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "Ocean course");
    this.card.innerHTML = `
      <div class="learn-head"><b class="learn-title"></b><span class="learn-dots"></span>
        <button class="learn-x" title="Leave the course">✕</button></div>
      <div class="learn-body" aria-live="polite"></div>
      <div class="learn-foot">
        <button class="btn learn-back">‹ Back</button>
        <button class="btn learn-menu">Lessons</button>
        <button class="btn learn-next">Next ›</button></div>
      <details class="learn-ask"><summary>Ask a question</summary></details>`;
    this.body = this.card.querySelector(".learn-body")!;
    this.card.querySelector(".learn-x")!.addEventListener("click", () => this.exit());
    this.card.querySelector(".learn-back")!.addEventListener("click", () => this.go(-1));
    this.card.querySelector(".learn-next")!.addEventListener("click", () => this.go(1));
    this.card.querySelector(".learn-menu")!.addEventListener("click", () => this.menu());
    document.getElementById("view")!.append(this.card);
  }

  get active(): boolean { return document.getElementById("app")!.classList.contains("learn"); }

  /** First visit (or ?learn=1): offer the course. Otherwise nothing. */
  offer(force = false): void {
    if (this.saved.seen && !force) return;
    this.enter();
    this.frame("Welcome", "");
    this.body.innerHTML = `<p>This is the real ocean, measured by instruments and worked out by computer models.</p>
      <p>Would you like a short course? Six lessons, a few minutes each, with a quick
      question at the end of most. You can leave any time, and come back with the
      <b>Learn</b> button at the top.</p>
      <div class="learn-choices"><button class="btn on" data-go="start">Start learning</button>
      <button class="btn" data-go="skip">Explore on my own</button></div>`;
    this.body.querySelector("[data-go=start]")!.addEventListener("click", () => this.open(this.nextLesson()));
    this.body.querySelector("[data-go=skip]")!.addEventListener("click", () => this.exit());
    this.markSeen();
  }

  /** The Learn button: the lesson list. */
  toggle(): void {
    if (this.active) { this.exit(); return; }
    this.enter();
    this.menu();
  }

  private enter(): void {
    if (this.active) return;
    this.markSeen();
    const app = document.getElementById("app")!;
    this.viewBefore = this.hooks.view();
    this.docksBefore = this.hooks.docks({ left: false, right: false });
    app.classList.add("learn");
    this.chatHome = this.hooks.chat.parentNode;
    this.card.querySelector(".learn-ask")!.append(this.hooks.chat);
    void this.hooks.run({ action: "set_view", view: "globe" });
  }

  exit(): void {
    this.stop();
    this.run += 1;
    document.getElementById("app")!.classList.remove("learn");
    void this.hooks.run({ action: "show_cube", on: true })
      .then(() => this.hooks.run({ action: "set_view", view: this.viewBefore }));
    if (this.docksBefore) this.hooks.docks(this.docksBefore);
    this.chatHome?.append(this.hooks.chat);
  }

  private markSeen(): void {
    this.saved.seen = true;
    save(this.saved);
  }

  private nextLesson(): number {
    const i = LESSONS.findIndex((l) => !this.saved.done?.includes(l.id));
    return i < 0 ? 0 : i;
  }

  private frame(title: string, dots: string): void {
    this.card.querySelector(".learn-title")!.textContent = title;
    this.card.querySelector(".learn-dots")!.textContent = dots;
    this.card.classList.toggle("in-step", false);
  }

  private menu(): void {
    this.stop();
    this.run += 1;
    this.frame("Lessons", "");
    const done = new Set(this.saved.done ?? []);
    this.body.innerHTML = `<ol class="learn-list">${LESSONS.map((l, i) =>
      `<li><button data-i="${i}">${done.has(l.id) ? "✓ " : ""}${esc(l.title)}</button>
       <span>${esc(l.goal)}</span></li>`).join("")}</ol>`;
    this.body.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((b) =>
      b.addEventListener("click", () => this.open(Number(b.dataset.i))));
  }

  private open(lesson: number, step = 0): void {
    this.lesson = lesson;
    this.step = step;
    this.ctx.memo = {};
    this.ctx.today = this.hooks.today();  // the catalogue's today, known only after it loads
    // Every lesson starts with the cube on screen; one that is about the surface alone
    // hides it in its own first step.
    void this.hooks.run({ action: "show_cube", on: true }).then(() => this.show());
  }

  private go(delta: number): void {
    const steps = LESSONS[this.lesson].steps;
    const next = this.step + delta;
    if (next < 0) return;
    if (next >= steps.length) {
      const done = new Set(this.saved.done ?? []);
      done.add(LESSONS[this.lesson].id);
      this.saved.done = [...done];
      save(this.saved);
      if (this.lesson + 1 < LESSONS.length) this.open(this.lesson + 1);
      else this.finish();
      return;
    }
    this.step = next;
    void this.show();
  }

  private finish(): void {
    this.frame("Well done", "");
    this.body.innerHTML = `<p>That is the whole course. Everything you used is still here:
      the panels are back, and the ocean is yours to explore.</p>
      <div class="learn-choices"><button class="btn on" data-go="close">Close</button></div>`;
    this.body.querySelector("[data-go=close]")!.addEventListener("click", () => {
      this.docksBefore = { left: true, right: true };  // the last lesson opened them
      this.exit();
    });
  }

  private stop(): void {
    this.cancelPick?.();
    this.cancelPick = undefined;
    window.clearInterval(this.waitTimer);
  }

  /** Run a step's actions, wait for the cube, then say it and ask what it asks. */
  private async show(): Promise<void> {
    this.stop();
    const ticket = ++this.run;
    const l = LESSONS[this.lesson];
    const s = l.steps[this.step];
    this.frame(l.title, `${this.step + 1} / ${l.steps.length}`);
    this.card.classList.toggle("in-step", true);
    this.setNav(false);
    this.body.innerHTML = `<p class="learn-busy">…</p>`;
    try {
      for (const a of s.do?.(this.ctx) ?? []) await this.hooks.run(a);
      // The cube loads in the background; a step about it must wait for it.
      for (let p = this.hooks.cube.loading; ; p = this.hooks.cube.loading) {
        await p;
        if (p === this.hooks.cube.loading) break;
      }
      if (ticket !== this.run) return;
      s.after?.(this.ctx);
    } catch (error) {
      if (ticket !== this.run) return;
      this.body.innerHTML = `<p class="learn-bad">${esc((error as Error).message)}</p>`;
    }
    if (ticket !== this.run) return;
    this.body.innerHTML = `<p>${esc(text(s.say, this.ctx))}</p>`;
    if (s.place) this.askPlace(ticket);
    else if (s.quiz) this.askQuiz(s.quiz, ticket);
    else if (s.wait) this.waitFor(s, ticket);
    else this.setNav(true);
  }

  private setNav(next: boolean): void {
    (this.card.querySelector(".learn-back") as HTMLButtonElement).disabled = this.step === 0;
    const n = this.card.querySelector(".learn-next") as HTMLButtonElement;
    n.disabled = !next;
    const last = this.step === LESSONS[this.lesson].steps.length - 1;
    n.textContent = last ? (this.lesson === LESSONS.length - 1 ? "Finish" : "Next lesson ›") : "Next ›";
  }

  private askPlace(ticket: number): void {
    const form = document.createElement("form");
    form.className = "learn-place";
    form.innerHTML = `<input type="text" placeholder="e.g. ${esc(DEFAULT_PLACE.name)}" aria-label="Your town or city"
        value="${esc(this.saved.place?.name.split(",")[0] ?? "")}" />
      <button class="btn on" type="submit">Go</button>
      <button class="btn" type="button" data-skip>Skip</button>
      <div class="hint learn-note">Only the name you type is sent, to our server and on to a free place-name search (Open-Meteo).</div>`;
    this.body.append(form);
    const input = form.querySelector("input")!;
    const note = form.querySelector(".learn-note")!;
    input.focus();
    const use = async (place: Place) => {
      note.textContent = `Looking at the sea near ${place.name}…`;
      this.ctx.place = place;
      try {
        this.ctx.sea = await api.getSeaState(place.lat, place.lon, this.ctx.today);
      } catch {
        this.ctx.sea = undefined;
      }
      this.saved.place = place;
      this.saved.sea = this.ctx.sea;
      save(this.saved);
      if (ticket === this.run) this.go(1);
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      note.textContent = "Searching…";
      try {
        const hit = await api.geocode(input.value);
        if (ticket !== this.run) return;
        if (hit) await use(hit);
        else note.textContent = `No place called “${input.value}” found. Try a bigger town nearby.`;
      } catch (error) {
        note.textContent = `${(error as Error).message}. Press Skip to use ${DEFAULT_PLACE.name}.`;
      }
    });
    form.querySelector("[data-skip]")!.addEventListener("click", () => void use(DEFAULT_PLACE));
  }

  private waitFor(s: Step, ticket: number): void {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = s.wait!.hint;
    this.body.append(hint);
    this.waitTimer = window.setInterval(() => {
      if (ticket !== this.run || !s.wait!.until(this.ctx)) return;
      window.clearInterval(this.waitTimer);
      hint.textContent = "✓";
      this.setNav(true);
    }, 300);
  }

  private askQuiz(q: Quiz, ticket: number): void {
    const box = document.createElement("div");
    box.className = "learn-quiz";
    box.innerHTML = `<p class="learn-q">${esc(text(q.q, this.ctx))}</p>`;
    this.body.append(box);
    const verdict = (right: boolean) => {
      const p = document.createElement("p");
      p.className = right ? "learn-good" : "learn-bad";
      p.textContent = `${right ? "Right." : "Not quite."} ${text(q.why, this.ctx)}`;
      box.append(p);
      this.setNav(true);
    };
    if (q.kind === "choice") {
      const options = typeof q.options === "function" ? q.options(this.ctx) : q.options;
      const answer = typeof q.answer === "function" ? q.answer(this.ctx) : q.answer;
      const row = document.createElement("div");
      row.className = "learn-choices";
      options.forEach((o, i) => {
        const b = document.createElement("button");
        b.className = "btn";
        b.textContent = o;
        b.addEventListener("click", () => {
          row.querySelectorAll("button").forEach((x, j) => {
            x.disabled = true;
            if (j === answer) x.classList.add("right");
          });
          if (i !== answer) b.classList.add("wrong");
          verdict(i === answer);
        });
        row.append(b);
      });
      box.append(row);
    } else {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Click on the globe.";
      box.append(hint);
      this.cancelPick = this.hooks.pick((lat, lon) => {
        if (ticket !== this.run) return;
        this.cancelPick = undefined;
        const [w, e, s, n] = q.box;
        hint.textContent = `You clicked ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ` +
          `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}.`;
        const inBox = lon >= w && lon <= e && lat >= s && lat <= n;
        const d = this.hooks.cube.data;
        const wet = !q.sea || (!!d && Number.isFinite(d.valueAt({ lon, lat, depth: 0 })));
        if (inBox && !wet) hint.textContent += " That is land.";
        verdict(inBox && wet);
      });
    }
  }
}
