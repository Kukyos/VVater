/**
 * The assistant panel. The model runs on the server (server/ocean/assistant.py); this
 * file keeps the conversation, shows the answers, and applies the interface actions the
 * server has already whitelisted -- after checking them again here, because the browser
 * should not trust a list of instructions just because it arrived from its own API.
 */

import { chat, type ChatAction } from "./api";

export interface ChatHooks {
  context: () => Record<string, unknown>;
  apply: (action: ChatAction) => Promise<void>;
}

const ALLOWED = new Set(["set_view", "set_layer", "set_depth", "fly_to", "open_profile",
  "isotherm_20", "make_cube", "set_control", "click", "highlight", "immersive", "cinematic"]);

const SUGGESTIONS = [
  "Make a cube of the Gulf Stream, down to 1,000 m",
  "Where should I fish near Chennai this week?",
  "Show me the winds",
  "How do I draw my own box?",
  "Show me INCOIS's fishing advisories",
  "Play the cinematic tour",
];

/** Minimal, safe formatting: escape everything, then allow **bold** and line breaks. */
function format(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

export class ChatPanel {
  readonly root: HTMLElement;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private send: HTMLButtonElement;
  private history: { role: "user" | "assistant"; content: string }[] = [];
  private busy = false;

  constructor(private hooks: ChatHooks) {
    this.root = document.createElement("div");
    this.root.className = "chat";
    this.root.innerHTML = `
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-suggest"></div>
      <form class="chat-form">
        <textarea rows="2" placeholder="Ask about the data or the viewer…" aria-label="Question"></textarea>
        <button type="submit" class="btn">Ask</button>
      </form>`;
    this.log = this.root.querySelector(".chat-log")!;
    this.input = this.root.querySelector("textarea")!;
    this.send = this.root.querySelector("button")!;
    const suggest = this.root.querySelector(".chat-suggest")!;
    for (const q of SUGGESTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q;
      b.addEventListener("click", () => void this.ask(q));
      suggest.append(b);
    }
    this.root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.ask(this.input.value);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.ask(this.input.value);
      }
    });
    this.add("assistant", "Ask me about the ocean data on screen, or about any control " +
      "or word in the viewer. Numbers I give come from the data; anything I cannot trace " +
      "back is marked.", []);
  }

  private add(role: "user" | "assistant" | "error", text: string, notes: string[]): HTMLElement {
    const item = document.createElement("div");
    item.className = `msg ${role}`;
    item.innerHTML = format(text) +
      (notes.length ? `<div class="msg-notes">${notes.map(format).join("<br>")}</div>` : "");
    this.log.append(item);
    this.log.scrollTop = this.log.scrollHeight;
    return item;
  }

  async ask(question: string): Promise<void> {
    const q = question.trim();
    if (!q || this.busy) return;
    this.busy = true;
    this.send.disabled = true;
    this.input.value = "";
    (this.root.querySelector(".chat-suggest") as HTMLElement).style.display = "none";
    this.add("user", q, []);
    this.history.push({ role: "user", content: q });
    const pending = this.add("assistant", "…", []);
    pending.classList.add("pending");
    try {
      const answer = await chat(this.history.slice(-12), this.hooks.context());
      pending.remove();
      const notes: string[] = [];
      if (answer.tools_used.length) {
        notes.push(`from: ${[...new Set(answer.tools_used)].join(", ").replaceAll("_", " ")}`);
      }
      if (answer.unverified.length) {
        notes.push(`⚠ not traced to the data: ${answer.unverified.join(", ")}`);
      }
      const applied: string[] = [];
      for (const action of answer.actions) {
        if (!ALLOWED.has(action.action)) continue;
        try {
          await this.hooks.apply(action);
          applied.push(action.action.replaceAll("_", " "));
        } catch {
          // An action that cannot apply (a platform not on screen) is skipped quietly.
        }
      }
      if (applied.length) notes.push(`changed: ${applied.join(", ")}`);
      const item = this.add("assistant", answer.reply || "(no answer)", notes);
      if (answer.unverified.length) item.classList.add("unverified");
      this.history.push({ role: "assistant", content: answer.reply });
    } catch (error) {
      pending.remove();
      this.history.pop();
      this.add("error", (error as Error).message, []);
    } finally {
      this.busy = false;
      this.send.disabled = false;
    }
  }
}
