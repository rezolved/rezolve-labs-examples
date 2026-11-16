/**
 * `#debug` in the page address: a panel with the widget's state and the time of each step since the last question
 * was sent (each server call, each sentence, each clip asked for, playing and ended), also logged to the console.
 * The steps are on `window.siteAssistantDebug` for scripted checks.
 */
interface Step { t: number; what: string }
declare global { interface Window { siteAssistantDebug?: { state: string; steps: Step[] } } }

const on = () => /(^#|&)debug\b/.test(location.hash);
const log = { state: "", steps: [] as Step[] };
let t0 = performance.now();
let box: HTMLPreElement | null = null;

/** Starts the clock for a new question. */
export function startTurn(what: string): void {
  t0 = performance.now();
  log.steps = [];
  mark(what);
}

export function mark(what: string): void {
  if (!on()) return;
  log.steps.push({ t: performance.now(), what });
  console.debug(`[site-assistant] +${since(performance.now())} ${what}`);
  render();
}

export function showState(state: string, detail = ""): void {
  log.state = detail ? `${state} (${detail})` : state;
  render();
}

const since = (t: number) => `${((t - t0) / 1000).toFixed(2)}s`;

function render(): void {
  if (!on()) {
    box?.remove();
    box = null;
    return;
  }
  window.siteAssistantDebug = log;
  if (!box) box = document.body.appendChild(Object.assign(document.createElement("pre"), { className: "sa-root sa-debug" }));
  box.textContent = [`state: ${log.state}`, ...log.steps.slice(-40).map((s) => `+${since(s.t)} ${s.what}`)].join("\n");
}

window.addEventListener("hashchange", render);
