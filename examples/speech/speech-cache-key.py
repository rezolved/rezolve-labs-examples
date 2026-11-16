"""speech · The cache key for a spoken clip.

A clip is the answer to one speech request, so its key covers everything that request sends: the voice id, the exact
text, the output format and the voice settings (and `seed` or `language`, when you send them). The text is tidied
before it is keyed *and* before it is sent, so the key always matches the request you sent: Unicode NFC, every run
of spaces, tabs and newlines made one space, and the ends trimmed. The voice id is lower-cased, empty settings are
dropped and whole numbers are written without a decimal point (1.0 is 1). The key is the SHA-256 of that request as
canonical JSON: sorted keys, no spaces, UTF-8.

Running it checks speech_body() and clip_key() against cache-key-vectors.json, the same file the TypeScript
twin checks, and prints pass or FAIL for each. With a text and a voice id it prints that line's key. No calls.

Run: uv run python speech/speech-cache-key.py ["text to say" <voiceId>]
"""
import hashlib, json, pathlib, re, sys, unicodedata

FORMAT = "mp3_44100_64"
SPACES = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")  # the same set in TS


def speech_body(text, output_format=FORMAT, voice_settings=None, seed=None, language=None):
    """The speech request, tidied. Send exactly this body, and key the clip with clip_key()."""
    body = {"text": SPACES.sub(" ", unicodedata.normalize("NFC", text)).strip(" "), "outputFormat": output_format}
    settings = {k: int(v) if isinstance(v, float) and v.is_integer() else v
                for k, v in sorted((voice_settings or {}).items()) if v is not None}
    if settings:
        body["voiceSettings"] = settings
    if seed is not None:
        body["seed"] = seed
    if language:
        body["language"] = language
    return body


def canonical(voice_id, body):
    """The voice id and the request as one line of JSON: sorted keys, no spaces, non-ASCII kept as it is."""
    return json.dumps({"voiceId": voice_id.strip().lower(), **body}, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def clip_key(voice_id, body):
    """The clip's key: SHA-256 of canonical(), as 64 hex characters. Use it as the file name."""
    return hashlib.sha256(canonical(voice_id, body).encode("utf-8")).hexdigest()


if len(sys.argv) > 2:
    body = speech_body(sys.argv[1])
    print(f"request:   {canonical(sys.argv[2], body)}")
    print(f"key:       {clip_key(sys.argv[2], body)}")
    sys.exit(0)

VECTORS = pathlib.Path(__file__).parent / "cache-key-vectors.json"
vectors = json.loads(VECTORS.read_text(encoding="utf-8"))["vectors"]
print(f"vectors:   speech/{VECTORS.name}")
failed = 0
for v in vectors:
    body = speech_body(v["text"], v.get("outputFormat", FORMAT), v.get("voiceSettings"), v.get("seed"), v.get("language"))
    ok = canonical(v["voiceId"], body) == v["canonical"] and clip_key(v["voiceId"], body) == v["key"]
    failed += not ok
    print(f"{'pass' if ok else 'FAIL':10} {v['key'][:12]}…  {v['name']}")
print(f"result:    {len(vectors) - failed} of {len(vectors)} pass")
sys.exit(1 if failed else 0)
