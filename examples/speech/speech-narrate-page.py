"""Read a page aloud: its readable text, spoken in short parts, checked, joined into one MP3 and cached.

Reads a page (a file or a URL; by default site-setup/sample-site/index.html) and keeps the text a visitor reads:
the <article>, else the <main>, else the body without its header and footer, and never scripts, styles,
navigation or forms. It splits that text at sentence ends into parts of at most 150 characters and speaks each one.
Designed, public and cloned voices can leave a passage out of a longer call without any error, so the parts are
short, and a part whose audio is too short for its text is spoken again with another seed. The clips are joined
into one MP3, named by a hash of the voice, the format and the parts, so an unchanged page costs nothing on the
next run: the file is already there.

Uses LABS_VOICE_ID, or else the first ready public voice. --max N sets the longest part, up to 3,000 characters
(the most one call takes).

Run: uv run python speech/speech-narrate-page.py [file or URL] [--max N]
"""
import hashlib, json, os, pathlib, re, sys, urllib.error, urllib.request

sys.stdout.reconfigure(line_buffering=True)
for d in pathlib.Path(__file__).resolve().parents:  # the nearest .env above this file
    if (d / ".env").exists():
        for line in (d / ".env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() and not k.lstrip().startswith("#"):
                os.environ.setdefault(k.strip(), v.strip())
        break
KEY = os.environ.get("LABS_API_KEY") or sys.exit("Set LABS_API_KEY in .env (copy env.example).")
API = os.environ.get("LABS_BASE_URL") or "https://api.rezolvelabs.com/api/v1"
UA = "labs-playbook-examples/1.0"  # every call sends an explicit User-Agent
LIMIT = 3000  # the most characters one speech call takes
PART = 150  # the longest part; longer calls can come back with a passage missing
TOO_FAST = 25  # characters a second; a part "spoken" faster than this is missing some of its text
TRIES = 3  # times to speak a part before keeping what came back
FORMAT = "mp3_44100_64"  # a constant 64 kbit/s, so 8 bytes of audio a millisecond


def labs(method, path, body=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=180)
    except urllib.error.HTTPError as e:
        resp = e
    data = resp.read()
    print(f"[labs] {method} {path} -> {resp.status} credits={resp.headers.get('X-Credits-Charged', '-')}"
          + ("" if resp.status < 400 else " body=" + data.decode(errors="replace")[:300].replace("\n", " ")))
    return resp.status, resp.headers, data


def data_of(answer, what):
    """The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why)."""
    status, _, body = answer
    if status >= 300:
        sys.exit(f"{what}: see the body above.")
    return json.loads(body)["data"]


def read_page(source):
    """The page's HTML, from a URL (logged like a Labs call) or a file."""
    if not re.match(r"https?://", source):
        return pathlib.Path(source).read_text(encoding="utf-8", errors="replace")
    try:
        resp = urllib.request.urlopen(urllib.request.Request(source, headers={"User-Agent": UA}), timeout=60)
    except urllib.error.HTTPError as e:
        resp = e
    print(f"[page] GET {source} -> {resp.status}")
    if resp.status >= 400:
        sys.exit("Could not read the page.")
    return resp.read().decode("utf-8", errors="replace")


NOISE = re.compile(r"<!--[\s\S]*?-->|<(head|script|style|noscript|template|svg|nav|aside|form)\b[^>]*>[\s\S]*?</\1\s*>", re.I)
ARTICLE = re.compile(r"<article\b[^>]*>([\s\S]*)</article\s*>", re.I)
MAIN = re.compile(r"<main\b[^>]*>([\s\S]*)</main\s*>", re.I)
FRAME = re.compile(r"<(header|footer)\b[^>]*>[\s\S]*?</\1\s*>", re.I)
BLOCK_END = re.compile(r"<br\s*/?>|</(p|h[1-6]|li|dt|dd|div|section|article|blockquote|figcaption|pre|tr|td|th)\s*>", re.I)
ENTITIES = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ", "ndash": "–", "mdash": "—",
            "hellip": "…", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "copy": "©", "euro": "€", "pound": "£"}


def entity(m):
    name = m.group(1)
    if name[0] == "#":
        code = int(name[2:], 16) if name[1] in "xX" else int(name[1:])
        return chr(code) if 0 < code <= 0x10FFFF else m.group(0)
    return ENTITIES.get(name, m.group(0))


def readable_text(html):
    """The words a visitor reads, one block after another. A block without a full stop (a heading, a list item)
    gets one, so the voice pauses after it instead of running it into the next."""
    html = NOISE.sub(" ", html)
    found = ARTICLE.search(html) or MAIN.search(html)
    html = BLOCK_END.sub("\n", found.group(1) if found else FRAME.sub(" ", html))
    text = re.sub(r"&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);", entity, re.sub(r"<[^>]*>", "", html))
    blocks = [re.sub(r"\s+", " ", b).strip() for b in text.split("\n")]
    return " ".join(b if re.search(r"[.!?…:;][\"'”’)\]]*$", b) else b + "." for b in blocks if b)


def cut_at(sentence, most):
    """Where to cut a sentence longer than `most`: after the last comma, semicolon or colon that fits, else at the
    last space."""
    for i in range(min(most, len(sentence) - 1) - 1, 0, -1):
        if sentence[i] in ",;:" and sentence[i + 1] == " ":
            return i + 1
    space = sentence.rfind(" ", 0, most + 1)
    return space if space > 0 else most


def parts_of(text, most):
    """The text in parts of at most `most` characters: whole sentences where they fit."""
    parts, current = [], ""
    for s in re.split(r"(?<=[.!?…])\s+", text):
        while len(s) > most:  # a sentence longer than a part
            if current:
                parts.append(current)
                current = ""
            at = cut_at(s, most)
            parts.append(s[:at])
            s = s[at:].strip()
        if not s:
            continue
        if current and len(current) + 1 + len(s) > most:
            parts.append(current)
            current = s
        else:
            current = f"{current} {s}" if current else s
    return parts + [current] if current else parts


def without_tag(clip):
    """The clip without the ID3 tag at its start. Every clip has one; joined clips keep only the first."""
    if clip[:3] != b"ID3":
        return clip
    size = clip[6] << 21 | clip[7] << 14 | clip[8] << 7 | clip[9]  # 7 bits a byte
    return clip[10 + size + (10 if clip[5] & 0x10 else 0):]  # header, tag, and footer if flagged


def speak(voice, part):
    """The audio for one part, and the credits it cost. Audio too short for the text is made again, with another
    seed if the voice takes one: the same request can give the same short clip again."""
    credits = 0
    for attempt in range(1, TRIES + 1):
        body = {"text": part, "outputFormat": FORMAT}
        if attempt > 1 and (voice.get("supportedSettings") or {}).get("seed"):
            body["seed"] = attempt
        status, headers, clip = labs("POST", f"/voice-audio/voices/{voice['id']}/speech", body)
        if status != 200:
            sys.exit("A part was refused: see the body above. No audio was saved.")
        credits += int(headers.get("X-Credits-Charged") or 0)
        ms = len(without_tag(clip)) // 8
        if len(part) * 1000 <= TOO_FAST * ms:
            return clip, credits
        print(f"short:   {len(part)} characters in {ms} ms, so some of the text is missing")
    print(f"warning: still short after {TRIES} tries; listen to this part")
    return clip, credits


args = sys.argv[1:]
source = next((a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--max")),
              "site-setup/sample-site/index.html")
most = min(int(args[args.index("--max") + 1]), LIMIT) if "--max" in args else PART
text = readable_text(read_page(source))
parts = parts_of(text, most) or sys.exit(f"{source} has no text to read.")
print(f"page:    {source}, {len(text)} characters of text")
print(f"parts:   {len(parts)} of at most {most} characters")

voice_id = os.environ.get("LABS_VOICE_ID")
if voice_id:
    voice = data_of(labs("GET", f"/voice-audio/voices/{voice_id}"), "Could not read the voice in LABS_VOICE_ID")
else:
    voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
    voice = next(v for v in voices if v["isPublic"] and v["status"] == "ready")
print(f"voice:   {voice['id'][:8]}… ({voice['voiceType']}{', public' if voice['isPublic'] else ''})")

key = hashlib.sha256("\n".join([voice["id"], FORMAT, *parts]).encode()).hexdigest()[:16]
out = pathlib.Path(f"out/narrate/{key}.mp3")
charged = 0
if out.exists():
    print(f"cached:  {out} is already there, so nothing is spoken")
else:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".txt").write_text("\n".join(parts) + "\n", encoding="utf-8")
    audio = b""
    for i, part in enumerate(parts, 1):
        clip, credits = speak(voice, part)
        audio += without_tag(clip) if audio else clip
        charged += credits
        print(f"part {i}: {len(part)} characters: " + " ".join(part.split(" ")[:6]) + " …")
    out.write_bytes(audio)
    print(f"saved:   {out} and its text in {out.with_suffix('.txt')}")
print(f"credits: {charged} for the page")
