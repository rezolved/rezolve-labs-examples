/**
 * setup-01 · Ask the owner the 22 questions.
 *
 * Asks all 22 questions in four rounds before anything is built, and writes the answers to site-assistant.yaml.
 * Each round is shown whole with its defaults, so the owner can accept it with one reply (Enter) or name the
 * questions to change. Questions marked "your answer" have no default and are always asked. Re-running edits the
 * existing site-assistant.yaml. Answers: text as typed; yes/no; numbers; a list as "a, b, c" (or "none");
 * anything structured in YAML flow style, such as [{label: Menu, path: /menu}].
 *
 * Run: npx tsx site-setup/setup-01-questions.ts            (asks the owner)
 *      npx tsx site-setup/setup-01-questions.ts --defaults (writes the example answers, for a demo)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "site-assistant.example.yaml");
const OUT = "site-assistant.yaml";
const ROUNDS = ["Who is speaking", "What it knows", "How it behaves", "Where it lives, money and data"];
// [number, round, question, fields]. A field ending in "*" is the owner's own: it has no default.
const QUESTIONS: [number, number, string, string[]][] = [
  [1, 1, "Brand in the third person, or a named person in the first person?", ["persona.voice", "persona.name"]],
  [2, 1, "Name in the interface.", ["name*", "title*", "storeName*"]],
  [3, 1, "Designed voice or clone? Consent, recordings, approval of the sample.",
    ["voiceId", "voice.kind", "voice.consent", "voice.recordings", "voice.sampleApproved"]],
  [4, 1, "Words mispronounced and words misheard.", ["pronunciations*", "vocabulary*"]],
  [5, 2, "Where the content is, and a product catalogue; how often it changes; refresh on publish?",
    ["knowledge.source*", "knowledge.changes", "knowledge.refreshOnPublish", "catalogue.source", "catalogue.currency"]],
  [6, 2, "Pages it may point to, aliases, home, in-page anchors?", ["routes*"]],
  [7, 2, "Off limits, framing, redirects.", ["offLimits*", "redirects*"]],
  [8, 3, "House style: spelling, serial comma, brand spellings, tone.",
    ["style.spelling", "style.serialComma", "style.brandSpellings*", "style.tone"]],
  [9, 3, "Answer length for speech; longer allowed in text?",
    ["answerStyle.spokenMaxWords", "answerStyle.spokenMaxSentences", "answerStyle.textMaxWords"]],
  [10, 3, "Welcome lines; play on first tap; listen straight after?",
    ["welcomeMessage*", "welcome.playOnFirstTap", "welcome.autoListen", "welcome.back"]],
  [11, 3, "Acknowledgement phrases.", ["acknowledgements"]],
  [12, 3, "Offer to open the source page; navigate on request?", ["followUp.offerNavigation", "navigation.enabled"]],
  [13, 3, "Turn-based or live call; acceptable latency; barge-in?",
    ["mode", "acceptableDelaySeconds", "transportProviderId", "bargeIn"]],
  [14, 3, "Suggested prompts.", ["prompts*"]],
  [15, 3, "What it cannot do; where a contact request goes.",
    ["capabilities.tools", "capabilities.cannot*", "contact.path*", "contact.email*"]],
  [16, 4, "Placement: hero, dock, contact page, header?", ["placement"]],
  [17, 4, "Look: colours, type, light or dark, animation?", ["theme.inherit", "theme.colorScheme", "theme.animation"]],
  [18, 4, "Hosting and build; where environment variables go.", ["hosting.host*", "hosting.build*", "hosting.envVars*"]],
  [19, 4, "Browsers and devices; which device the owner tests on.", ["devices.browsers", "devices.ownerTestDevice"]],
  [20, 4, "Credit budget per month and per visitor; what shows at the limit; rate limits?",
    ["budget.monthlyCredits*", "budget.perVisitorCredits*", "budget.atLimitMessage",
      "rateLimits.questionsPerMinute", "rateLimits.clipsPerMinute"]],
  [21, 4, "Keep transcripts? Analytics? Consent for the mic and storage?",
    ["retention.keepTranscripts", "retention.keepDays", "retention.analytics", "retention.askMicConsent",
      "retention.askStorageConsent"]],
  [22, 4, "Who is told when it fails, and how?", ["alerts.who*", "alerts.how", "alerts.webhookUrl"]],
];

const get = (doc: any, path: string) => path.split(".").reduce((d, key) => d[key], doc);

function put(doc: any, path: string, value: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  keys.reduce((d, key) => d[key], doc)[last] = value;
}

/** A value on one line, in the YAML flow style an answer can be typed in. */
function show(value: any): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(show).join(", ") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value).map(([k, v]) => `${k}: ${show(v)}`).join(", ") + "}";
  }
  const text = String(value);
  return text === "" || /[,:\[\]{}#"']/.test(text) ? JSON.stringify(text) : text;
}

/** Reads an answer as the same kind of value as `like` (the default or the example). */
function parse(text: string, like: unknown): unknown {
  if (typeof like === "boolean") return ["y", "yes", "true"].includes(text.toLowerCase());
  if (typeof like === "number") {
    if (!/^[0-9]+$/.test(text)) throw new RangeError("a whole number");
    return Number(text);
  }
  if (Array.isArray(like) && !text.startsWith("[")) {
    return text.toLowerCase() === "none" ? [] : text.split(",").map((p) => p.trim()).filter(Boolean);
  }
  return like !== null && typeof like === "object" ? YAML.parse(text, { version: "1.1" }) : text;
}

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

async function ask(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  const next = await lines.next();
  return next.done ? null : next.value.trim();
}

const editing = existsSync(OUT);
const answers = YAML.parse(readFileSync(editing ? OUT : EXAMPLE, "utf8"));
if (!process.argv.includes("--defaults")) {
  for (const [i, name] of ROUNDS.entries()) {
    const questions = QUESTIONS.filter((q) => q[1] === i + 1);
    console.log(`\nRound ${i + 1} of 4 · ${name}`);
    for (const [n, , text, fields] of questions) {
      const own = !editing && fields.some((f) => f.endsWith("*"));
      console.log(`  Q${n}. ${text}` + (own ? "  (your answer)" : ""));
      for (const f of fields) {
        const hint = !editing && f.endsWith("*") ? "e.g. " : "";
        console.log(`       ${f.replace(/\*$/, "")}: ${hint}${show(get(answers, f.replace(/\*$/, "")))}`);
      }
    }
    const reply = await ask("Questions to change (numbers, Enter keeps the defaults): ");
    const change = new Set((reply ?? "").replace(/,/g, " ").split(/\s+/).filter(Boolean).map(Number));
    for (const [n, , , fields] of questions) {
      for (const f of fields) {
        const path = f.replace(/\*$/, ""), own = f.endsWith("*") && !editing;
        if (!change.has(n) && !own) continue;
        const current = get(answers, path);
        for (;;) {
          const input = await ask(`  Q${n} ${path} [${own ? "" : show(current)}]: `);
          if (input === null && own) {
            console.error(`Q${n} (${path}) needs the owner's answer.`);
            process.exit(1);
          }
          try {
            if (input) put(answers, path, parse(input, current));
          } catch (e) {
            if (!(e instanceof RangeError)) throw e;
            console.log("  Please answer with a whole number.");
            continue;
          }
          if (input || !own) break;
        }
      }
    }
  }
}
writeFileSync(OUT, "# The owner's answers to the 22 questions (site-setup/setup-01-questions).\n"
  + YAML.stringify(answers, { version: "1.1", indentSeq: false, lineWidth: 0, singleQuote: true }));
console.log(`\nWrote ${OUT}: ${QUESTIONS.length} questions answered.`);
process.exit(0);
