/**
 * Turns an answer's sentences into speech clips, as they arrive.
 *
 * The first clip waits until it holds more than 150 characters: the agent's voice makes a line of up to about 150
 * characters whole before it sends any audio, so a longer first clip starts sooner. After that each sentence is its
 * own clip, so the text keeps in step with the voice sentence by sentence. No clip is longer than the server's
 * limit (`limits.speechChars`): a longer sentence is cut after a comma, semicolon or colon, else at a space.
 */
export const FIRST_CLIP = 150;

export class Clipper {
  private held: string[] | null = []; // sentences gathered for the first clip; null once it has gone

  /** `emit` gets the parts of one clip: the text to show, one entry per sentence or piece of one. */
  constructor(private readonly max: number, private readonly emit: (parts: string[]) => void) {}

  add(sentence: string): void {
    for (const part of fit(sentence, this.max)) {
      if (this.held === null) {
        this.emit([part]);
      } else if (this.held.length && spoken([...this.held, part]).length > this.max) {
        this.emit(this.held); // the first clip would be too long: send what is held, then this part
        this.held = null;
        this.emit([part]);
      } else {
        this.held.push(part);
        if (spoken(this.held).length > FIRST_CLIP) {
          this.emit(this.held);
          this.held = null;
        }
      }
    }
  }

  /** The answer was stopped: the sentences held for the first clip, never spoken. */
  drop(): string[] {
    const held = this.held ?? [];
    this.held = null;
    return held;
  }

  /** The answer has ended: a short answer is all in the first clip. */
  end(): void {
    if (this.held?.length) this.emit(this.held);
    this.held = null;
  }
}

/** The text a clip speaks. A list item has no full stop, and without one, joined items run together. */
export const spoken = (parts: string[]): string => parts.map((p) => (/[.!?…:;,]$/.test(p) ? p : p + ".")).join(" ");

/** Cuts `text` into pieces of at most `max` characters (a full stop may be added later, so one less). */
export function fit(text: string, max: number): string[] {
  const pieces: string[] = [];
  const limit = max - 1;
  while (text.length > limit) {
    const head = text.slice(0, limit + 1);
    let cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": ")) + 1;
    if (cut <= 0) cut = head.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    pieces.push(text.slice(0, cut).trim());
    text = text.slice(cut).trim();
  }
  if (text) pieces.push(text);
  return pieces;
}
