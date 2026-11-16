"""speech · Correct misheard words in a transcript.

Transcription writes what it hears, so a word the owner cares about can come back as a sound-alike: "Saltmarsh"
as "salt marsh". Transcription takes no word list, so your server corrects the transcript before it shows it or
sends it to the agent, and the agent's instructions name the spellings.

The words are `vocabulary[]` and each `pronunciations[].word` in site-assistant.yaml (or the example). correct()
puts back a word's spelling where the transcript has it in another case, split by spaces or hyphens, or as one of
its sound-alikes: the optional `soundAlikes` map in the YAML, {word: [what transcription writes]}.

With no text, each word is spoken in a test sentence, transcribed, and corrected; what was heard in its place is
printed as `soundAlikes` to add to the YAML. With a text, only that text is corrected (no calls). Both end with the
lines to add to the agent's instructions.

Run: uv run python speech/speech-sound-alikes.py ["transcript to correct"]
"""
import json, os, pathlib, re, sys, urllib.error, urllib.request, uuid
import yaml

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
ANSWERS = pathlib.Path("site-assistant.yaml")
if not ANSWERS.exists():
    ANSWERS = pathlib.Path(__file__).parent.parent / "site-setup" / "site-assistant.example.yaml"
LANGUAGE = "en-GB"  # the visitors' language, as a language-region locale
TEST = "Tell me about {word}, please."  # the test sentence each word is spoken in
PLACE = re.compile(r"\W*tell me about (.+?)\W*please\W*", re.IGNORECASE)  # finds what was heard in the word's place


def multipart(form):
    """A multipart/form-data body and its Content-Type, from {name: text, or (file name, bytes, content type)}."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in form.items():
        if isinstance(value, tuple):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{value[0]}"\r\n'
                         f"Content-Type: {value[2]}\r\n\r\n".encode() + value[1] + b"\r\n")
        else:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    return b"".join(parts) + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def labs(method, path, body=None, form=None):
    """One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
    `form` sends multipart fields instead of a JSON body."""
    data, content_type = multipart(form) if form else (None if body is None else json.dumps(body).encode(), "application/json")
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={"X-API-KEY": KEY, "Content-Type": content_type, "User-Agent": UA})
    try:
        resp = urllib.request.urlopen(req, timeout=120)
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


def correct(text, words, alikes):
    """The transcript with each word spelled as the owner spells it, matched as whole words in any case."""
    for word in sorted(words, key=len, reverse=True):
        forms = [r"[\s-]?".join(map(re.escape, word.replace(" ", ""))),  # "saltmarsh", "salt marsh", "salt-marsh"
                 *map(re.escape, alikes.get(word) or [])]
        pattern = re.compile(rf"(?<!\w)(?:{'|'.join(forms)})(?!\w)", re.IGNORECASE)

        def spell(m, word=word):  # a capital only where a sentence starts
            before = m.string[:m.start()].rstrip()
            return word[0].upper() + word[1:] if not before or before[-1] in ".!?" else word
        text = pattern.sub(spell, text)
    return text


site = yaml.safe_load(ANSWERS.read_text(encoding="utf-8"))
print(f"answers:   {os.path.relpath(ANSWERS)}")
words = list(dict.fromkeys([*(site.get("vocabulary") or []), *(p["word"] for p in site.get("pronunciations") or [])]))
alikes = {w: list((site.get("soundAlikes") or {}).get(w) or []) for w in words}  # plus any heard below
if not words:
    sys.exit("No vocabulary[] or pronunciations[] in the answers: no words to listen for.")
print(f"words:     {', '.join(words)}")

found = {}
if len(sys.argv) > 1:
    print(f"heard:     {sys.argv[1]}")
    print(f"corrected: {correct(sys.argv[1], words, alikes)}")
else:
    voice_id = os.environ.get("LABS_VOICE_ID") or site.get("voiceId")
    if not voice_id:
        voices = data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")["items"]
        voice_id = next(v for v in voices if v["isPublic"] and v["status"] == "ready")["id"]
    print(f"voice:     {voice_id}")
    for word in words:
        said = TEST.format(word=word)
        status, _, audio = labs("POST", f"/voice-audio/voices/{voice_id}/speech", {"text": said, "outputFormat": "mp3_44100_64"})
        if status != 200:
            continue
        form = {"audio": ("said.mp3", audio, "audio/mpeg"), "language": LANGUAGE}
        heard = data_of(labs("POST", "/transcription/voices/transcriptions", form=form), "Transcription failed")["text"]
        place = PLACE.fullmatch(heard)
        if place and place.group(1).lower() not in [word.lower(), *(a.lower() for a in alikes[word])]:
            alikes[word].append(place.group(1).lower())
            found.setdefault(word, []).append(place.group(1).lower())
        print(f"said:      {said}")
        print(f"heard:     {heard}")
        print(f"corrected: {correct(heard, words, alikes)}")
    if found:
        print("add to site-assistant.yaml:")
        print("soundAlikes:")
        for word, heard_as in found.items():
            print(f"  {json.dumps(word, ensure_ascii=False)}: [{', '.join(json.dumps(h, ensure_ascii=False) for h in heard_as)}]")

print("add to the agent's instructions:")
print(f"- Spell these exactly as written: {', '.join(words)}.")
misheard = [f'"{h}" as {w}' for w in words for h in alikes[w]]
if misheard:
    print(f"- Visitors may speak, so a word can arrive misheard: read {', '.join(misheard)}.")
