/**
 * The site assistant widget: the one ES module your server adds to every page (CONTRACT.md, "Serving the page").
 *
 * It reads the owner's settings from GET /api/site and wires the other modules together:
 * placement (data-site-assistant="hero | dock | contact | header"), the theme, the four states with their hints,
 * prompt chips, answers spoken in step with their text, the microphone loop, tap to interrupt, the welcome on the
 * first tap, the conversation kept across pages, consent, page navigation and #debug.
 */
import { ApiError, cancel, chat, getSite, messageFor, transcript, type Link, type Site } from "./api.js";
import { Clipper, spoken } from "./clips.js";
import { mark, showState, startTurn } from "./debug.js";
import { hooks } from "./hooks.js";
import { listen, micAllowed, wakeMic, warmMic, type Heard } from "./mic.js";
import { acceptsOffer, go, isHere, routeFor, routeRequested, type Target } from "./nav.js";
import { shrink } from "./photo.js";
import { Player } from "./player.js";
import { Store } from "./store.js";
import { Typer } from "./sync.js";
import { addStyles, applyTheme } from "./theme.js";

type State = "idle" | "listening" | "thinking" | "speaking";

const HINTS: Record<State, string> = {
  idle: "Type a question, or tap the microphone and speak.",
  listening: "Listening. Tap the microphone when you have finished.",
  thinking: "Thinking. Tap here to stop.",
  speaking: "Speaking. Tap here to stop.",
};

const ASK_MIC = "Use your microphone? While the assistant listens, what you say is sent to this site to be turned into text.";
const ASK_STORAGE = "Keep this conversation while you move between pages? It is kept in this browser tab only.";

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON = {
  mic: svg("M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3"),
  send: svg("M5 12h14M13 6l6 6-6 6"),
  voiceOn: svg("M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"),
  voiceOff: svg("M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6"),
  close: svg("M6 6l12 12M18 6L6 18"),
  photo: svg("M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"),
};

/** One question being answered. */
interface Answer { cancelled: boolean; typers: Typer[]; abort: AbortController }

class Widget {
  private state: State = "idle";
  private readonly player = new Player();
  private readonly store: Store;
  private chatId: string | null = null;
  private answer: Answer | null = null;
  private offer: Target | null = null; // the last page offered, for a "yes"
  private listening: AbortController | null = null;
  private loop = 0; // the microphone loop running, by number; a new number ends the old loop
  private looping = false;
  private welcoming: Promise<void> = Promise.resolve();
  private storageAsked = false;
  private warmed = false;
  private readonly mics: HTMLButtonElement[] = [];
  private readonly panel = el("section", "sa-root sa-panel");
  private readonly log = el("div", "sa-log");
  private readonly hint = el("p", "sa-hint");
  private readonly signal = el("div", "sa-signal");
  private readonly banner = el("div", "sa-banner");
  private readonly voice = iconButton("sa-mute", "", "");
  private launcher: HTMLButtonElement | null = null;

  constructor(private readonly site: Site) {
    this.store = new Store(site.retention.askStorageConsent);
    addStyles();
    this.buildPanel();
    this.place();
    this.player.onBlocked = () => this.note("Tap the speaker button to hear answers.");
    this.player.onInterrupted = () => this.interrupt();
    if (this.store.kept.open) this.open();
    this.setState("idle");
    void this.restore();
    if (site.welcome.playOnFirstTap && this.welcomeDue()) document.addEventListener("click", this.firstTap, true);
  }

  // ---- placement: hero and contact ask boxes, a header button, the dock

  private place(): void {
    const { placement, contact } = this.site;
    const marked = (place: string) => [...document.querySelectorAll<HTMLElement>(`[data-site-assistant="${place}"]`)];
    const put = (place: string, fallback: Element | null, where: InsertPosition, make: () => HTMLElement) => {
      if (!placement.includes(place)) return;
      const spots = marked(place);
      if (spots.length) spots.forEach((spot) => spot.append(make()));
      else fallback?.insertAdjacentElement(where, make()); // no marked spot: a sensible place on a plain page
    };
    put("hero", isHere("/") ? document.querySelector("main h1, h1") : null, "afterend", () => this.askBox("hero"));
    put("contact", isHere(contact.path) ? document.querySelector("main") ?? document.body : null, "beforeend",
      () => this.askBox("contact"));
    put("header", document.querySelector("header nav") ?? document.querySelector("header"), "beforeend", () => {
      const b = this.root(el("button", "sa-header", this.site.title));
      b.type = "button";
      b.onclick = () => this.open();
      return b;
    });
    put("dock", document.body, "beforeend", () => {
      const b = (this.launcher = this.root(el("button", "sa-launch", this.site.title)));
      b.type = "button";
      b.hidden = !this.panel.hidden;
      b.onclick = () => this.open();
      return b;
    });
  }

  private root<T extends HTMLElement>(node: T): T {
    node.classList.add("sa-root");
    applyTheme(node, this.site.theme);
    return node;
  }

  private askBox(place: string): HTMLElement {
    const box = this.root(el("div", `sa-box sa-at-${place}`));
    const form = el("form", "sa-ask");
    const input = el("input", "sa-input");
    input.placeholder = `Ask ${this.site.storeName} a question`;
    input.maxLength = this.site.limits.questionChars;
    input.setAttribute("aria-label", this.site.title);
    const mic = iconButton("sa-mic", "Speak", ICON.mic);
    const send = iconButton("sa-send", "Send", ICON.send);
    send.type = "submit";
    form.append(input, ...(this.site.photos ? this.photoButton(input) : []), mic, send);
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      this.player.unlock(); // a submit is a tap or a key press: the moment to unlock the voice
      this.open();
      void this.ask(text, false);
    };
    mic.onclick = () => this.micTap();
    for (const target of [input, mic]) {
      target.addEventListener("focus", () => this.warm());
      target.addEventListener("pointerenter", () => this.warm());
    }
    this.mics.push(mic);
    const chips = el("div", "sa-chips");
    for (const prompt of this.site.prompts) {
      const chip = el("button", "sa-chip", prompt);
      chip.type = "button";
      chip.onclick = () => {
        this.player.unlock();
        this.open();
        void this.ask(prompt, false);
      };
      chips.append(chip);
    }
    box.append(form, chips);
    return box;
  }

  /** The camera button, when the server takes photos: the visitor picks a photo, or takes one on a phone. */
  private photoButton(input: HTMLInputElement): HTMLElement[] {
    const pick = el("input", "");
    pick.type = "file";
    pick.accept = "image/*";
    pick.hidden = true;
    const button = iconButton("sa-photo", "Send a photo of a product", ICON.photo);
    button.onclick = () => {
      this.player.unlock();
      pick.click();
    };
    pick.onchange = async () => {
      const file = pick.files?.[0];
      pick.value = "";
      if (!file) return;
      this.open();
      let photo: string;
      try {
        photo = await shrink(file);
      } catch {
        return this.note("Sorry, I couldn't read that photo. Try a JPEG or PNG.");
      }
      const text = input.value.trim();
      input.value = "";
      void this.ask(text || "What is this?", false, photo);
    };
    return [button, pick];
  }

  private buildPanel(): void {
    const p = this.root(this.panel);
    p.hidden = true;
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", this.site.title);
    const title = el("button", "sa-title", this.site.title);
    title.type = "button";
    title.onclick = () => this.interrupt(); // tap to interrupt: the title, the signal line or the hint
    this.signal.onclick = this.hint.onclick = () => this.interrupt();
    this.voice.onclick = () => this.toggleVoice();
    const close = iconButton("sa-close", "Close", ICON.close);
    close.onclick = () => this.close();
    const head = el("div", "sa-head");
    head.append(title, this.voice, close);
    this.hint.setAttribute("aria-live", "polite");
    this.log.setAttribute("aria-live", "polite");
    this.banner.hidden = true;
    p.append(head, this.signal, this.hint, this.log, this.banner, this.askBox("panel"));
    document.body.append(p);
    this.showVoice();
  }

  private open(): void {
    this.panel.hidden = false;
    if (this.launcher) this.launcher.hidden = true;
    this.store.save({ open: true });
  }

  /** Closing the panel ends the microphone loop and stops the answer. */
  private close(): void {
    this.stopLoop();
    this.interrupt();
    this.panel.hidden = true;
    if (this.launcher) this.launcher.hidden = false;
    this.store.save({ open: false });
  }

  // ---- states and hints

  private setState(state: State): void {
    this.state = state;
    this.signal.dataset.state = state;
    this.hint.textContent = HINTS[state];
    this.mics.forEach((m) => m.setAttribute("aria-pressed", String(state === "listening")));
    showState(state, `voice ${this.store.kept.muted ? "off" : this.player.blocked ? "blocked" : "on"}`);
  }

  /** A hint that stays until the state next changes. */
  private note(text: string): void {
    this.hint.textContent = text;
  }

  private bubble(role: "user" | "assistant", text = ""): HTMLElement {
    const b = el("div", `sa-turn sa-${role}`, text);
    this.log.append(b);
    this.scroll();
    return b;
  }

  private scroll = () => {
    this.log.scrollTop = this.log.scrollHeight;
  };

  // ---- a question and its answer: the sentence is the unit, and the audio drives the text

  /** Asks one question. Resolves once its answer has been shown and spoken, or stopped. */
  async ask(text: string, spokenQuestion: boolean, photo?: string): Promise<void> {
    if (!photo && this.site.navigation.enabled && this.navigationRequest(text, spokenQuestion)) return;
    this.interrupt();
    this.offer = null;
    const question = this.bubble("user", text);
    if (photo) {
      const img = el("img", "sa-thumb");
      img.src = photo;
      img.alt = "Your photo";
      question.prepend(img);
    }
    const reply = this.bubble("assistant");
    reply.append(el("span", "sa-wait", "…"));
    const answer: Answer = (this.answer = { cancelled: false, typers: [], abort: new AbortController() });
    this.setState("thinking");
    startTurn(`ask (${spokenQuestion ? "spoken" : photo ? "photo" : "typed"}): ${text}`);
    if (!this.storageAsked) void this.askStorage();

    let clips = 0, ended = 0, streamDone = false, problem = "", acknowledged = false;
    const links: Link[] = []; // an answer can point to more than one page
    let typing = Promise.resolve(); // voice off: sentences type one after another at reading pace
    let allPlayed = () => {};
    const played = new Promise<void>((resolve) => (allPlayed = resolve));
    const check = () => { if (streamDone && ended === clips) allPlayed(); };

    const clipper = new Clipper(this.site.limits.speechChars, (parts) => {
      const n = clips++;
      const typer = new Typer(reply, parts, this.scroll);
      answer.typers.push(typer);
      if (this.store.kept.muted) { // the voice was turned off part-way: type instead
        typing = typing.then(() => typer.follow(null)).then(() => { ended++; check(); });
        return;
      }
      mark(`clip ${n} queued: ${parts.length} part(s), ${spoken(parts).length} chars`);
      this.player.say({
        text: spoken(parts),
        onStart: (audio) => {
          mark(`clip ${n} playing`);
          if (this.answer === answer) this.setState("speaking");
          void typer.follow(audio);
        },
        onEnd: (ok) => {
          mark(`clip ${n} ${ok ? "ended" : "not played"}`);
          typer.finish();
          ended++;
          check();
        },
      });
    });

    try {
      for await (const { event, data } of chat(text, this.chatId, answer.abort.signal, photo)) {
        if (event === "chat") this.setChat(data.chatId); // kept even if cancelled: the transcript has the turn
        if (event === "done") mark(`done${data.cancelled ? " (cancelled)" : ""}`);
        if (answer.cancelled) continue; // the server ends the stream at once after a cancel
        if (event === "tool") {
          mark(`tool ${data.name}`);
          const wait = reply.querySelector(".sa-wait");
          if (wait) wait.textContent = "Checking…";
          if (spokenQuestion && !acknowledged && !this.store.kept.muted) {
            acknowledged = true;
            this.acknowledge();
          }
        } else if (event === "sentence") {
          mark(`sentence ${data.index}: ${data.text}`);
          if (!this.store.kept.muted) clipper.add(data.text);
          else {
            const typer = new Typer(reply, [data.text], this.scroll);
            answer.typers.push(typer);
            typing = typing.then(() => typer.follow(null));
          }
        } else if (event === "link") {
          mark(`link ${data.path}`);
          if (!links.some((l) => l.path === data.path)) links.push(data);
        } else if (event === "error") {
          mark(`error ${data.code}`);
          problem = data.message || messageFor(data.code);
        }
      }
    } catch (err) {
      if (!answer.cancelled) {
        mark(`refused: ${(err as ApiError).code ?? (err as Error).name}`);
        problem = err instanceof ApiError ? err.message : messageFor("unavailable");
        if (err instanceof ApiError && ["budget_reached", "unavailable"].includes(err.code)) {
          links.push({ path: this.site.contact.path, label: "" }); // offer the contact page instead
        }
      }
    }
    if (!answer.cancelled) clipper.end();
    else new Typer(reply, clipper.drop()).finish(); // sentences held for the first clip: shown, not spoken
    streamDone = true;
    check();
    await Promise.all([played, typing]);

    reply.querySelector(".sa-wait")?.remove();
    if (problem) reply.append(el("span", "sa-note", problem));
    if (answer.cancelled) reply.append(el("span", "sa-note", "Stopped."));
    else if (this.site.followUp.offerNavigation) {
      this.offer = links.map((l) => this.offerLink(reply, l)).find(Boolean) ?? null; // a "yes" opens the first
    }
    this.scroll();
    if (this.answer === answer) {
      this.answer = null;
      this.setState("idle");
    }
  }

  /** A short "One moment." while the agent looks something up: one of the owner's clips, made in advance. */
  private acknowledge(): void {
    const lines = this.site.acknowledgements;
    if (!lines.length || this.player.busy) return;
    const line = lines[Math.floor(Math.random() * lines.length)];
    mark(`acknowledgement: ${line}`);
    this.player.say({ text: line });
  }

  /** Tap to interrupt: stop the voice at once and ask the server to stop sending the answer. */
  private interrupt(): void {
    const answer = this.answer;
    this.player.stop();
    if (!answer) {
      if (this.state === "speaking") this.setState("idle"); // the welcome
      return;
    }
    mark("interrupted");
    answer.cancelled = true;
    this.answer = null;
    const closeStream = () => answer.abort.abort(); // closing the stream cancels it too
    if (this.chatId) cancel(this.chatId).then((stopped) => stopped || closeStream(), closeStream);
    else closeStream(); // no chat id yet
    answer.typers.forEach((t) => t.finish()); // what has arrived is shown in full
    this.setState("idle");
  }

  private setChat(chatId: string): void {
    this.chatId = chatId;
    if (this.site.retention.keepTranscripts) this.store.save({ chatId });
  }

  // ---- voice on and off; the phone unlock is in player.ts

  private toggleVoice(): void {
    if (this.player.blocked) { // this tap unlocks the voice for the next answer
      this.player.unlock();
      this.setState(this.state);
      return;
    }
    const muted = !this.store.kept.muted;
    this.store.save({ muted });
    if (muted) this.player.stop();
    else this.player.unlock();
    this.showVoice();
  }

  private showVoice(): void {
    const muted = this.store.kept.muted;
    this.voice.innerHTML = muted ? ICON.voiceOff : ICON.voiceOn;
    this.voice.setAttribute("aria-label", muted ? "Turn the voice on" : "Turn the voice off");
    this.voice.title = this.voice.getAttribute("aria-label")!;
    this.voice.setAttribute("aria-pressed", String(!muted));
  }

  // ---- the microphone loop

  private micTap(): void {
    this.player.unlock(); // inside the tap: the voice and the audio context
    wakeMic();
    if (this.listening) { // tapped while listening: send what was heard, then stop the loop
      this.listening.abort();
      return;
    }
    if (this.state === "thinking" || this.state === "speaking") this.interrupt();
    void this.conversation();
  }

  /**
   * Listen, ask, hear the answer, listen again: until the visitor taps the microphone, closes the panel, or says
   * nothing twice. The microphone is off while the answer plays.
   */
  private async conversation(): Promise<void> {
    const loop = ++this.loop;
    this.looping = true;
    this.open();
    try {
      if (!(await this.micConsent())) return this.note("The microphone is off. You can type your question.");
      await this.welcoming;
      let silent = 0, again = false;
      while (loop === this.loop) {
        const live = this.bubble("user");
        live.classList.add("sa-live");
        this.listening = new AbortController();
        this.setState("listening");
        if (again) this.note("I didn't hear anything. Listening again.");
        let heard: Heard;
        try {
          heard = await listen({
            stop: this.listening.signal,
            onWords: (words) => { live.textContent = words; this.scroll(); },
            onLevel: (level) => this.signal.style.setProperty("--sa-level", level.toFixed(2)),
          });
        } catch (err) {
          this.setState("idle");
          return this.note(micProblem(err));
        } finally {
          this.listening = null;
          live.remove();
        }
        this.setState("idle");
        if (loop !== this.loop) return; // the panel was closed: drop what was heard
        again = !heard.text;
        if (!heard.text) {
          if (heard.ended === "tapped" || ++silent >= 2) return this.note("Tap the microphone to talk again.");
          continue;
        }
        silent = 0;
        if (heard.ended === "tapped") this.loop++; // answer this one, then stop
        await this.ask(heard.text, true);
      }
    } finally {
      if (loop === this.loop) this.loop++;
      this.looping = false;
    }
  }

  private stopLoop(): void {
    this.loop++;
    this.listening?.abort();
  }

  private async micConsent(): Promise<boolean> {
    if (!this.site.retention.askMicConsent || this.store.kept.micOk) return true;
    const ok = await this.consent("microphone");
    if (ok) this.store.save({ micOk: true });
    return ok;
  }

  /** Warm start: on the first focus of an ask box or the microphone, load what the first spoken question needs. */
  private warm(): void {
    if (this.warmed) return;
    this.warmed = true;
    mark("warm start");
    warmMic().catch(() => {}); // the resampler for the microphone
  }

  // ---- the welcome, on the first tap

  private welcomeDue(): boolean {
    return this.store.allowed ? !this.store.kept.welcomed : this.store.fresh;
  }

  /** The first tap anywhere on the page plays the welcome, once a visit. A tap on a link is left alone. */
  private firstTap = (e: Event): void => {
    const target = e.target as Element;
    if (target.closest?.("a[href]")) return; // the page is changing: don't start the welcome only to cut it off
    document.removeEventListener("click", this.firstTap, true);
    this.store.save({ welcomed: true });
    if (target.closest?.(".sa-chip, .sa-send, .sa-mute, .sa-close")) return; // a question is coming instead
    this.player.unlock(); // inside the tap
    this.welcoming = this.welcome();
  };

  private async welcome(): Promise<void> {
    const back = this.site.welcome.back && hooks().returning?.() === true;
    const line = back ? this.site.welcome.back : this.site.welcomeMessage;
    this.open();
    const typer = new Typer(this.bubble("assistant"), [line], this.scroll);
    mark("welcome");
    if (this.store.kept.muted) await typer.follow(null);
    else {
      await new Promise<void>((done) => this.player.say({
        text: line,
        onStart: (audio) => { this.setState("speaking"); void typer.follow(audio); },
        onEnd: () => { typer.finish(); done(); },
      }));
      if (this.state === "speaking") this.setState("idle");
    }
    // Listen straight after, but only if the browser won't prompt for the microphone (already allowed).
    if (this.site.welcome.autoListen && !this.looping && !this.panel.hidden && (await micAllowed())) {
      void this.conversation();
    }
  }

  // ---- consent and the conversation across pages

  private async consent(kind: "microphone" | "storage"): Promise<boolean> {
    const hook = hooks().consent;
    if (hook) return (await hook(kind)) === true;
    this.open();
    const card = el("div", "sa-consent", kind === "microphone" ? ASK_MIC : ASK_STORAGE);
    const yes = el("button", "", kind === "microphone" ? "Allow" : "Keep it");
    const no = el("button", "", kind === "microphone" ? "Not now" : "No, thanks");
    yes.type = no.type = "button";
    card.append(el("br", ""), yes, no);
    this.log.after(card); // under the conversation, so it doesn't move while an answer types out
    const ok = await new Promise<boolean>((resolve) => {
      yes.onclick = () => resolve(true);
      no.onclick = () => resolve(false);
    });
    card.remove();
    return ok;
  }

  private async askStorage(): Promise<void> {
    this.storageAsked = true;
    if (this.store.allowed || !this.site.retention.keepTranscripts) return;
    if (await this.consent("storage")) this.store.allow();
  }

  /** On a new page: the conversation so far, read back from the server. */
  private async restore(): Promise<void> {
    const chatId = this.store.kept.chatId;
    if (!chatId || !this.site.retention.keepTranscripts) return;
    try {
      const turns = await transcript(chatId);
      this.chatId = chatId;
      for (const turn of turns) {
        const b = this.bubble(turn.role, turn.text);
        if (turn.photo) b.append(el("span", "sa-note", "Sent with a photo"));
        if (!turn.link || !this.site.followUp.offerNavigation) continue;
        this.offer = this.offerLink(b, turn.link) ?? this.offer;
      }
      mark(`restored ${turns.length} turns`);
    } catch {
      this.store.save({ chatId: null }); // gone (for example the server restarted): start a new one
    }
  }

  // ---- page navigation

  /** The answer's "Read more" page, as a button, if it is one of the owner's routes and not this page. */
  private offerLink(into: HTMLElement, link: Link): Target | null {
    const target = routeFor(link.path, this.site.routes);
    if (!target || isHere(target.path)) return null;
    const button = el("button", "sa-offer", `Open ${target.route.label}`);
    button.type = "button";
    button.onclick = () => void this.openPage(target, false);
    into.append(button);
    return target;
  }

  /** "Take me to the menu", or "yes" after an offer: opens the page without asking the agent. */
  private navigationRequest(text: string, spokenQuestion: boolean): boolean {
    const route = routeRequested(text, this.site.routes);
    const target = route ? { route, path: route.path } : this.offer && acceptsOffer(text) ? this.offer : null;
    if (!target) return false;
    this.bubble("user", text);
    void this.openPage(target, spokenQuestion);
    return true;
  }

  private async openPage(target: Target, say: boolean): Promise<void> {
    this.stopLoop();
    this.interrupt();
    if (isHere(target.path)) return this.note(`You're on ${target.route.label} already.`);
    this.banner.textContent = `Opening ${target.route.label}…`;
    this.banner.hidden = false;
    mark(`navigate ${target.path}`);
    if (say && !this.store.kept.muted) { // a spoken request gets a spoken reply before the page changes
      await new Promise<void>((done) => {
        this.player.say({ text: `Opening ${target.route.label}.`, onEnd: () => done() });
        setTimeout(done, 4000);
      });
    } else {
      await new Promise((r) => setTimeout(r, 400)); // long enough to read the banner
    }
    go(target.path, this.site.routes);
    setTimeout(() => (this.banner.hidden = true), 1500); // a single-page app stays on this document
  }
}

function micProblem(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const name = (err as Error)?.name;
  if (name === "NotAllowedError") {
    return "The microphone is blocked for this site. Allow it in the browser's site settings, or type your question.";
  }
  if (name === "NotFoundError") return "No microphone was found. You can type your question.";
  return messageFor("unavailable");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function iconButton(className: string, label: string, icon: string): HTMLButtonElement {
  const b = el("button", `sa-icon ${className}`);
  b.type = "button";
  b.innerHTML = icon;
  if (label) {
    b.setAttribute("aria-label", label);
    b.title = label;
  }
  return b;
}

async function start(): Promise<void> {
  let site: Site;
  try {
    site = await getSite();
  } catch (err) {
    console.warn("[site-assistant] not started:", (err as Error).message);
    return;
  }
  new Widget(site);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void start());
else void start();
