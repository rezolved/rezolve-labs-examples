/**
 * The widget's look comes from the host page: its font, text colour, background and link colour are read from the
 * page's own CSS when the widget starts, so it matches the site with no settings. A site can set any of them itself:
 *
 *   :root { --site-assistant-accent: #a0522d; --site-assistant-bg: #fffaf3; }   (also -fg and -font)
 *
 * `theme.colorScheme` "auto" follows the page; "light" or "dark" uses the browser's own colours for that scheme.
 * `theme.animation: false`, or the visitor's reduced-motion setting, stops the signal line moving.
 */
import type { Site } from "./api.js";

/** Sets the host's colours on a widget root element. */
export function applyTheme(root: HTMLElement, theme: Site["theme"]): void {
  const page = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const link = document.querySelector("main a[href], nav a[href], header a[href], a[href]");
  const forced = theme.colorScheme !== "auto" || !theme.inherit;
  const bg = forced ? null : background();
  root.style.setProperty("--sa-host-font", body.fontFamily);
  root.style.setProperty("--sa-host-fg", bg ? body.color : "CanvasText");
  root.style.setProperty("--sa-host-bg", bg ?? "Canvas");
  root.style.setProperty("--sa-host-accent", link && !forced ? getComputedStyle(link).color : "LinkText");
  root.style.colorScheme = forced ? theme.colorScheme.replace("auto", "light dark")
    : page.colorScheme === "normal" ? "light" : page.colorScheme;
  root.classList.toggle("sa-still", !theme.animation);
}

/** The page's background: the first element up from <body> with an opaque one, else null. */
function background(): string | null {
  for (let node: Element | null = document.body; node; node = node.parentElement) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && c !== "transparent" && !/,\s*0\)$/.test(c)) return c;
  }
  return null;
}

/** Added once to <head>, before the site's own CSS so the site can override any rule. */
export function addStyles(): void {
  if (document.getElementById("site-assistant-css")) return;
  const style = Object.assign(document.createElement("style"), { id: "site-assistant-css", textContent: CSS });
  document.head.prepend(style);
}

const CSS = `
.sa-root {
  --sa-font: var(--site-assistant-font, var(--sa-host-font));
  --sa-fg: var(--site-assistant-fg, var(--sa-host-fg));
  --sa-bg: var(--site-assistant-bg, var(--sa-host-bg));
  --sa-accent: var(--site-assistant-accent, var(--sa-host-accent));
  --sa-line: #8886;
  font-family: var(--sa-font); color: var(--sa-fg); line-height: 1.4;
}
.sa-root *, .sa-root { box-sizing: border-box; }
.sa-root button { font: inherit; color: inherit; cursor: pointer; }
.sa-box { margin: 1em 0; max-width: 36em; }
.sa-ask { display: flex; gap: .4em; align-items: center; margin: 0; }
.sa-ask input { flex: 1; min-width: 0; font: inherit; color: var(--sa-fg); background: var(--sa-bg);
  padding: .55em .9em; border: 1px solid var(--sa-line); border-radius: 999px; }
.sa-icon { flex: none; width: 2.5em; height: 2.5em; padding: 0; border-radius: 50%; border: 1px solid var(--sa-line);
  background: transparent; display: inline-grid; place-items: center; }
.sa-icon svg { width: 1.15em; height: 1.15em; }
.sa-send, .sa-mic[aria-pressed="true"] { background: var(--sa-accent); border-color: var(--sa-accent); color: var(--sa-bg); }
.sa-chips { display: flex; flex-wrap: wrap; gap: .4em; margin-top: .6em; }
.sa-chip { border: 1px solid var(--sa-line); background: transparent; border-radius: 999px; padding: .3em .85em; font-size: .9em; }
.sa-header { border: 1px solid var(--sa-line); background: transparent; border-radius: 999px; padding: .2em .8em; margin-left: .6em; }
.sa-launch { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; border: 0; border-radius: 999px;
  padding: .75em 1.2em; background: var(--sa-accent); color: var(--sa-bg); box-shadow: 0 2px 12px #0003; }
.sa-panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483001; width: min(400px, calc(100vw - 32px));
  max-height: min(600px, calc(100vh - 32px)); display: flex; flex-direction: column; gap: 8px; padding: 12px;
  background: var(--sa-bg); border: 1px solid var(--sa-line); border-radius: 14px; box-shadow: 0 8px 32px #0003; }
.sa-panel[hidden], .sa-launch[hidden], .sa-banner[hidden] { display: none; }
.sa-panel .sa-box { margin: 0; }
.sa-panel .sa-log:has(.sa-user) ~ .sa-box .sa-chips { display: none; }
.sa-head { display: flex; align-items: center; gap: .4em; }
.sa-title { flex: 1; text-align: left; background: none; border: 0; padding: 0; font-weight: 600; }
.sa-signal { height: 3px; border-radius: 3px; background: var(--sa-accent); opacity: .35; cursor: pointer;
  transition: transform .08s linear; }
.sa-signal[data-state="idle"] { animation: sa-breathe 3s ease-in-out infinite; }
.sa-signal[data-state="listening"] { opacity: 1; transform: scaleY(calc(1 + var(--sa-level, 0) * 3)); }
.sa-signal[data-state="thinking"] { opacity: .9; background: linear-gradient(90deg, transparent, var(--sa-accent), transparent)
  0 0 / 40% 100% no-repeat; animation: sa-sweep 1.1s linear infinite; }
.sa-signal[data-state="speaking"] { opacity: 1; animation: sa-pulse .9s ease-in-out infinite; }
@keyframes sa-breathe { 50% { opacity: .12; } }
@keyframes sa-sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
@keyframes sa-pulse { 50% { transform: scaleY(2.2); } }
.sa-still .sa-signal { animation: none; transition: none; }
@media (prefers-reduced-motion: reduce) { .sa-signal { animation: none !important; transition: none; } }
.sa-hint { margin: 0; font-size: .85em; opacity: .75; min-height: 1.2em; }
.sa-panel > * { flex-shrink: 0; }
.sa-panel > .sa-log { flex: 1 1 auto; flex-shrink: 1; min-height: 3em; overflow-y: auto; display: flex; flex-direction: column; gap: .5em; }
.sa-turn { padding: .5em .8em; border-radius: 12px; max-width: 90%; }
.sa-user { align-self: flex-end; background: #8882; }
.sa-assistant { align-self: flex-start; border: 1px solid var(--sa-line); }
.sa-live { opacity: .65; font-style: italic; }
.sa-wait, .sa-note { opacity: .6; }
.sa-note { display: block; font-size: .85em; margin-top: .3em; }
.sa-offer { display: block; margin-top: .45em; background: transparent; border: 1px solid var(--sa-accent);
  color: var(--sa-accent) !important; border-radius: 999px; padding: .2em .85em; font-size: .9em; }
.sa-banner { padding: .5em .8em; border-radius: 10px; background: var(--sa-accent); color: var(--sa-bg); }
.sa-consent { border: 1px solid var(--sa-line); border-radius: 10px; padding: .6em .8em; font-size: .9em; }
.sa-consent button { margin: .5em .5em 0 0; border: 1px solid var(--sa-line); background: transparent;
  border-radius: 999px; padding: .2em .85em; }
.sa-consent button:first-of-type { background: var(--sa-accent); border-color: var(--sa-accent); color: var(--sa-bg); }
.sa-debug { position: fixed; left: 8px; bottom: 8px; z-index: 2147483002; margin: 0; max-width: 52ch; max-height: 50vh;
  overflow: auto; padding: 8px; border-radius: 6px; background: #000d; color: #fff; font: 11px/1.35 ui-monospace, monospace;
  white-space: pre-wrap; }
@media (max-width: 480px) { .sa-panel { left: 8px; right: 8px; bottom: 8px; width: auto; } }
`;
