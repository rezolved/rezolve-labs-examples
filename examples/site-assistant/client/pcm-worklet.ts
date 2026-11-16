/**
 * Runs on the audio thread: the microphone's samples, resampled from the device's rate to 16 kHz, posted as 16-bit
 * PCM frames of 100 ms (3,200 bytes). Resampling here works in every browser; asking for a 16 kHz AudioContext
 * instead fails in some when the microphone runs at another rate.
 */
export {};

declare const sampleRate: number; // the AudioContext's rate, e.g. 48000
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: unknown): void;

const RATE = 16000;
const FRAME = RATE / 10;

class Pcm16 extends AudioWorkletProcessor {
  private readonly step = sampleRate / RATE; // input samples per output sample
  private at = 0; // where the next output sample falls, counted from this block's first sample (can be -1..0)
  private last = 0; // the previous block's last sample
  private out = new Int16Array(FRAME);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const x = inputs[0]?.[0];
    if (!x) return true;
    let t = this.at;
    for (; t < x.length - 1; t += this.step) {
      const i = Math.floor(t);
      const a = i < 0 ? this.last : x[i];
      const s = a + (x[i + 1] - a) * (t - i); // linear interpolation
      this.out[this.n++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
      if (this.n === FRAME) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(FRAME);
        this.n = 0;
      }
    }
    this.at = t - x.length;
    this.last = x[x.length - 1];
    return true;
  }
}

registerProcessor("pcm16", Pcm16);
