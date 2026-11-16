"""clone-02 · Cut the sample: one speaker, cut on real pauses.

Reads out/voice-clone/transcript.json (from clone-01) and the recording it names. Writes the sample to clone
from, out/voice-clone/sample.wav, and out/voice-clone/cuts.json: which parts of the recording were used, and
which were dropped and why. It keeps one speaker: the one who speaks most, or the one you name.

A piece is a run of that speaker's words, up to a pause of a second or more. It is cut in the pauses around it,
never inside a word: up to 0.5 s before its first word and after its last, and never past the middle of the gap
to anyone's next word. Silence is added so every piece has 0.5 s of quiet at each end, and the pieces are joined
in order until the sample is two minutes long. A piece is dropped when:
- it is shorter than 1.5 s ("Yes."): too little of the voice;
- another speaker talks over it, or is less than 0.3 s away: the cut would catch their voice;
- the 50 ms at either cut is not quiet (20 dB below the piece's speech, or near the recording's background):
  the word timings are off, and the cut could land inside a word;
- it is clipped: 3 or more samples at full scale.

Reads 16-bit PCM WAV, mono or stereo (stereo is mixed down to mono). Convert anything else before clone-01,
for example: ffmpeg -i interview.m4a -ac 1 -c:a pcm_s16le interview.wav

Run: uv run python voice-clone/clone-02-cut.py [speaker_N]
"""
import array, json, math, pathlib, sys, wave

TRANSCRIPT = pathlib.Path("out/voice-clone/transcript.json")
SAMPLE = pathlib.Path("out/voice-clone/sample.wav")
CUTS = pathlib.Path("out/voice-clone/cuts.json")
PAD = 0.5            # seconds of quiet at each end of every piece
MIN_PAUSE = 0.3      # another speaker must be at least this far from a piece
LONG_PAUSE = 1.0     # a pause this long inside one speaker's words starts a new piece
MIN_PIECE = 1.5      # seconds of speech; shorter pieces are dropped
MAX_SAMPLE = 120     # seconds; the sample stops growing here
MAX_BYTES = 24 * 1024 * 1024  # under the API's 25 MB, with room for the form around the file
QUIET = 20           # a cut is quiet when its 50 ms are this many dB below the piece's speech,
BACKGROUND = 6       # or no more than this many dB above the recording's background


def read_wav(path):
    """(16-bit mono samples, frame rate) of a WAV file. Stereo is mixed down to mono."""
    try:
        with wave.open(str(path)) as w:
            width, rate, channels, raw = w.getsampwidth(), w.getframerate(), w.getnchannels(), w.readframes(w.getnframes())
    except (wave.Error, EOFError) as e:
        sys.exit(f"{path} is not a WAV this script reads ({e}): convert it first (see the top of this file).")
    if width != 2:
        sys.exit(f"{path} has {8 * width}-bit samples: convert it to 16-bit PCM first (see the top of this file).")
    samples = array.array("h", raw)
    if sys.byteorder == "big":
        samples.byteswap()
    if channels > 1:
        samples = array.array("h", (sum(samples[i:i + channels]) // channels for i in range(0, len(samples), channels)))
    return samples, rate


def level(samples):
    """The RMS level of some samples, in dBFS; -120 for silence."""
    rms = math.sqrt(sum(x * x for x in samples) / len(samples)) if samples else 0
    return 20 * math.log10(rms / 32768) if rms else -120.0


def fade(piece, n):
    """Ramps the first and last n samples from and to zero, so a cut never clicks."""
    for i in range(min(n, len(piece) // 2)):
        piece[i] = piece[i] * i // n
        piece[-1 - i] = piece[-1 - i] * i // n


def clock(seconds):
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


if not TRANSCRIPT.exists():
    sys.exit(f"No {TRANSCRIPT}: run clone-01-transcribe.py first.")
transcript = json.loads(TRANSCRIPT.read_text())
samples, rate = read_wav(transcript["recording"])
seconds = {}
for s in transcript["segments"]:
    seconds[s["speaker"]] = seconds.get(s["speaker"], 0) + (s["endMs"] - s["startMs"]) / 1000
speaker = sys.argv[1] if len(sys.argv) > 1 else max(seconds, key=seconds.get)
if speaker not in seconds:
    sys.exit(f"No {speaker} in the transcript. Speakers: {', '.join(seconds)}.")
step = int(0.05 * rate)
frames = sorted(level(samples[i:i + step]) for i in range(0, len(samples) - step, step))
background = frames[len(frames) // 10]  # the level of the quietest tenth of the recording
print(f"speaker:  {speaker}, {seconds[speaker]:.1f} s of speech; "
      + ", ".join(f"{k} {v:.1f} s" for k, v in seconds.items() if k != speaker))

# Every word, in order, with its speaker. A segment without word timings counts as one long word.
words = sorted(({"speaker": s["speaker"], "text": w["text"], "start": w["startMs"] / 1000, "end": w["endMs"] / 1000}
                for s in transcript["segments"]
                for w in s["words"] or [{"text": s["text"], "startMs": s["startMs"], "endMs": s["endMs"]}]),
               key=lambda w: w["start"])
runs = []  # [first, last] word index of each run of the speaker's words
for i, w in enumerate(words):
    if w["speaker"] != speaker:
        continue
    if runs and runs[-1][1] == i - 1 and w["start"] - words[i - 1]["end"] < LONG_PAUSE:
        runs[-1][1] = i
    else:
        runs.append([i, i])

out, used, dropped = array.array("h"), [], []
for first, last in runs:
    start, end = words[first]["start"], words[last]["end"]
    text = " ".join(w["text"] for w in words[first:last + 1])
    before = max((w["end"] for w in words[:first]), default=None)  # the end of anyone's word before this run
    after = words[last + 1]["start"] if last + 1 < len(words) else None
    lead = min(PAD, start if before is None else (start - before) / 2)
    tail = min(PAD, len(samples) / rate - end if after is None else (after - end) / 2)
    lo, hi = int((start - lead) * rate), int((end + tail) * rate)
    speech = level(samples[int(start * rate):int(end * rate)])
    clipped = samples[lo:hi].count(32767) + samples[lo:hi].count(-32768)
    grown = len(out) + hi - lo + int((2 * PAD - lead - tail) * rate)  # the sample's length with this piece in it
    why = None
    if end - start < MIN_PIECE:
        why = f"too short ({end - start:.1f} s)"
    elif before is not None and start - before < MIN_PAUSE:
        why = f"{words[first - 1]['speaker']} " + ("talks over it" if start < before else f"{start - before:.2f} s before it")
    elif after is not None and after - end < MIN_PAUSE:
        why = f"{words[last + 1]['speaker']} " + ("talks over it" if after < end else f"{after - end:.2f} s after it")
    elif max(level(samples[lo:lo + step]), level(samples[hi - step:hi])) > max(speech - QUIET, background + BACKGROUND):
        why = "not quiet at a cut: the word timings may be off"
    elif clipped >= 3:
        why = f"clipped ({clipped} samples at full scale)"
    elif grown / rate > MAX_SAMPLE or 2 * grown > MAX_BYTES:
        why = f"not needed: the sample is already {len(out) / rate:.0f} s"
    if why:
        dropped.append({"from": start, "to": end, "why": why, "text": text})
        if not why.startswith("not needed"):
            print(f"dropped:  {clock(start)}–{clock(end)} {why}: \"{text[:50]}\"")
        continue
    piece = samples[lo:hi]
    fade(piece, int(0.01 * rate))
    out += array.array("h", bytes(2 * int((PAD - lead) * rate)))  # silence up to 0.5 s before the piece
    used.append({"from": start, "to": end, "at": round(len(out) / rate + lead, 3), "text": text})  # at: its first word
    out += piece + array.array("h", bytes(2 * int((PAD - tail) * rate)))  # and after it

if not used:
    sys.exit("No piece was kept: see the reasons above. Try another speaker, or a cleaner recording.")
if sys.byteorder == "big":
    out.byteswap()
SAMPLE.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(SAMPLE), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(out.tobytes())
CUTS.write_text(json.dumps({"recording": transcript["recording"], "speaker": speaker, "language": transcript["language"],
                            "sample": str(SAMPLE), "seconds": len(out) / rate, "used": used, "dropped": dropped}, indent=1))
print(f"used:     {len(used)} pieces, " + ", ".join(f"{clock(u['from'])}–{clock(u['to'])}" for u in used))
if spare := sum(d["why"].startswith("not needed") for d in dropped):
    print(f"spare:    {spare} later pieces were not needed: the sample was full")
print(f"saved:    {SAMPLE} ({len(out) / rate:.1f} s, {SAMPLE.stat().st_size / 1e6:.1f} MB) and {CUTS}")
print("next:     clone-03-report.py, for the owner to approve before anything is paid")
