"""setup-01 · Ask the owner the 22 questions.

Asks all 22 questions in four rounds before anything is built, and writes the answers to site-assistant.yaml.
Each round is shown whole with its defaults, so the owner can accept it with one reply (Enter) or name the
questions to change. Questions marked "your answer" have no default and are always asked. Re-running edits the
existing site-assistant.yaml. Answers: text as typed; yes/no; numbers; a list as "a, b, c" (or "none");
anything structured in YAML flow style, such as [{label: Menu, path: /menu}].

Run: uv run python site-setup/setup-01-questions.py            (asks the owner)
     uv run python site-setup/setup-01-questions.py --defaults (writes the example answers, for a demo)
"""
import json, pathlib, sys
import yaml

EXAMPLE = pathlib.Path(__file__).parent / "site-assistant.example.yaml"
OUT = pathlib.Path("site-assistant.yaml")
ROUNDS = ["Who is speaking", "What it knows", "How it behaves", "Where it lives, money and data"]
# (number, round, question, fields). A field ending in "*" is the owner's own: it has no default.
QUESTIONS = [
    (1, 1, "Brand in the third person, or a named person in the first person?", ["persona.voice", "persona.name"]),
    (2, 1, "Name in the interface.", ["name*", "title*", "storeName*"]),
    (3, 1, "Designed voice or clone? Consent, recordings, approval of the sample.",
     ["voiceId", "voice.kind", "voice.consent", "voice.recordings", "voice.sampleApproved"]),
    (4, 1, "Words mispronounced and words misheard.", ["pronunciations*", "vocabulary*"]),
    (5, 2, "Where the content is, and a product catalogue; how often it changes; refresh on publish?",
     ["knowledge.source*", "knowledge.changes", "knowledge.refreshOnPublish",
      "catalogue.source", "catalogue.currency", "catalogue.enrich"]),
    (6, 2, "Pages it may point to, aliases, home, in-page anchors?", ["routes*"]),
    (7, 2, "Off limits, framing, redirects.", ["offLimits*", "redirects*"]),
    (8, 3, "House style: spelling, serial comma, brand spellings, tone.",
     ["style.spelling", "style.serialComma", "style.brandSpellings*", "style.tone"]),
    (9, 3, "Answer length for speech; longer allowed in text?",
     ["answerStyle.spokenMaxWords", "answerStyle.spokenMaxSentences", "answerStyle.textMaxWords"]),
    (10, 3, "Welcome lines; play on first tap; listen straight after?",
     ["welcomeMessage*", "welcome.playOnFirstTap", "welcome.autoListen", "welcome.back"]),
    (11, 3, "Acknowledgement phrases.", ["acknowledgements"]),
    (12, 3, "Offer to open the source page; navigate on request?", ["followUp.offerNavigation", "navigation.enabled"]),
    (13, 3, "Turn-based or live call; acceptable latency; barge-in?",
     ["mode", "acceptableDelaySeconds", "transportProviderId", "bargeIn"]),
    (14, 3, "Suggested prompts.", ["prompts*"]),
    (15, 3, "What it cannot do; where a contact request goes.",
     ["capabilities.tools", "capabilities.cannot*", "contact.path*", "contact.email*"]),
    (16, 4, "Placement: hero, dock, contact page, header?", ["placement"]),
    (17, 4, "Look: colours, type, light or dark, animation?", ["theme.inherit", "theme.colorScheme", "theme.animation"]),
    (18, 4, "Hosting and build; where environment variables go.", ["hosting.host*", "hosting.build*", "hosting.envVars*"]),
    (19, 4, "Browsers and devices; which device the owner tests on.", ["devices.browsers", "devices.ownerTestDevice"]),
    (20, 4, "Credit budget per month and per visitor; what shows at the limit; rate limits?",
     ["budget.monthlyCredits*", "budget.perVisitorCredits*", "budget.atLimitMessage",
      "rateLimits.questionsPerMinute", "rateLimits.clipsPerMinute"]),
    (21, 4, "Keep transcripts? Analytics? Consent for the mic and storage?",
     ["retention.keepTranscripts", "retention.keepDays", "retention.analytics", "retention.askMicConsent",
      "retention.askStorageConsent"]),
    (22, 4, "Who is told when it fails, and how?", ["alerts.who*", "alerts.how", "alerts.webhookUrl"]),
]


def get(doc, path):
    for key in path.split("."):
        doc = doc[key]
    return doc


def put(doc, path, value):
    *parents, last = path.split(".")
    for key in parents:
        doc = doc[key]
    doc[last] = value


def show(value):
    """A value on one line, in the YAML flow style an answer can be typed in."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        return "[" + ", ".join(show(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k}: {show(v)}" for k, v in value.items()) + "}"
    text = str(value)
    return json.dumps(text, ensure_ascii=False) if text == "" or any(c in text for c in ",:[]{}#\"'") else text


def parse(text, like):
    """Reads an answer as the same kind of value as `like` (the default or the example)."""
    if isinstance(like, bool):
        return text.lower() in ("y", "yes", "true")
    if isinstance(like, int):
        if not (text.isascii() and text.isdigit()):
            raise ValueError("a whole number")
        return int(text)
    if isinstance(like, list) and not text.startswith("["):
        return [] if text.lower() == "none" else [part.strip() for part in text.split(",") if part.strip()]
    return yaml.safe_load(text) if isinstance(like, (list, dict)) else text


def ask(prompt):
    try:
        return input(prompt).strip()
    except EOFError:
        return None


def main():
    editing = OUT.exists()
    answers = yaml.safe_load((OUT if editing else EXAMPLE).read_text())
    if "--defaults" not in sys.argv:
        for number, name in enumerate(ROUNDS, 1):
            questions = [q for q in QUESTIONS if q[1] == number]
            print(f"\nRound {number} of 4 · {name}")
            for n, _, text, fields in questions:
                own = not editing and any(f.endswith("*") for f in fields)
                print(f"  Q{n}. {text}" + ("  (your answer)" if own else ""))
                for f in fields:
                    hint = "e.g. " if not editing and f.endswith("*") else ""
                    print(f"       {f.rstrip('*')}: {hint}{show(get(answers, f.rstrip('*')))}")
            reply = ask("Questions to change (numbers, Enter keeps the defaults): ")
            change = {int(n) for n in (reply or "").replace(",", " ").split()}
            for n, _, text, fields in questions:
                for f in fields:
                    path, own = f.rstrip("*"), f.endswith("*") and not editing
                    if n not in change and not own:
                        continue
                    current = get(answers, path)
                    while True:
                        text_in = ask(f"  Q{n} {path} [{'' if own else show(current)}]: ")
                        if text_in is None and own:
                            sys.exit(f"Q{n} ({path}) needs the owner's answer.")
                        try:
                            if text_in:
                                put(answers, path, parse(text_in, current))
                        except ValueError:
                            print("  Please answer with a whole number.")
                            continue
                        if text_in or not own:
                            break
    OUT.write_text("# The owner's answers to the 22 questions (site-setup/setup-01-questions).\n"
                   + yaml.safe_dump(answers, sort_keys=False, allow_unicode=True, width=1000))
    print(f"\nWrote {OUT}: {len(QUESTIONS)} questions answered.")


if __name__ == "__main__":
    main()
