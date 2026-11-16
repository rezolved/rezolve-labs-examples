/**
 * The audio drives the text: a clip's words appear as its audio plays, typed out at the pace of the voice, and not
 * a moment before. Each part (a sentence, or a piece of a long one) gets its own <span>, added when the voice
 * reaches it, so the text on screen is always what has been said.
 *
 * The pace is `currentTime / duration`. A clip that is still streaming has no duration yet (it is Infinity until
 * the last byte arrives), so until then the pace is estimated at 14 characters a second. When the clip ends, is
 * stopped or fails, `finish()` shows all of its text: an interrupted answer is never left cut off.
 * With the voice off, text types at reading pace instead.
 */
const SPOKEN_PER_SECOND = 14;
const READ_PER_SECOND = 45;

export class Typer {
  private readonly spans: HTMLSpanElement[] = [];
  private readonly total: number;
  private done = false;

  constructor(private readonly into: HTMLElement, private readonly parts: string[], private readonly changed = () => {}) {
    this.total = parts.join("").length;
  }

  /** Types along with `audio`, or at reading pace when it is null. Resolves once all the text is shown. */
  follow(audio: HTMLAudioElement | null): Promise<void> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.done) return resolve();
        const progress = !audio ? ((performance.now() - t0) / 1000) * READ_PER_SECOND / this.total
          : audio.duration > 0 && isFinite(audio.duration) ? audio.currentTime / audio.duration
          : audio.currentTime * SPOKEN_PER_SECOND / this.total;
        if (progress >= 1 && !audio) {
          this.finish();
          return resolve();
        }
        this.show(Math.min(this.total, Math.ceil(progress * this.total))); // with audio, wait for finish()
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /** Shows all the text: its clip has ended, was stopped or failed. */
  finish(): void {
    this.done = true;
    this.show(Infinity);
  }

  private show(count: number): void {
    let left = count;
    this.parts.forEach((text, i) => {
      if (left <= 0) return; // the voice hasn't reached this part yet
      const span = this.spans[i] ?? (this.spans[i] = this.attach());
      span.textContent = left >= text.length ? text + " " : text.slice(0, left);
      left -= text.length;
    });
    this.changed();
  }

  private attach(): HTMLSpanElement {
    this.into.querySelector(".sa-wait")?.remove(); // the "…" goes when the first words appear
    return this.into.appendChild(document.createElement("span"));
  }
}
