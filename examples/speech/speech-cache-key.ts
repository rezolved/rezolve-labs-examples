/**
 * speech · The cache key for a spoken clip.
 *
 * A clip is the answer to one speech request, so its key covers everything that request sends: the voice id, the
 * exact text, the output format and the voice settings (and `seed` or `language`, when you send them). The text is
 * tidied before it is keyed *and* before it is sent, so the key always matches the request you sent: Unicode NFC,
 * every run of spaces, tabs and newlines made one space, and the ends trimmed. The voice id is lower-cased, empty
 * settings are dropped and whole numbers are written without a decimal point (1.0 is 1). The key is the SHA-256 of
 * that request as canonical JSON: sorted keys, no spaces, UTF-8.
 *
 * Running it checks speechBody() and clipKey() against cache-key-vectors.json, the same file the Python twin
 * checks, and prints pass or FAIL for each. With a text and a voice id it prints that line's key. No calls.
 *
 * Run: npx tsx speech/speech-cache-key.ts ["text to say" <voiceId>]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = "mp3_44100_64";
const SPACES = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g; // the same set in Python

type SpeechBody = { text: string; outputFormat: string; voiceSettings?: Record<string, unknown>; seed?: number; language?: string };

/** The speech request, tidied. Send exactly this body, and key the clip with clipKey(). */
function speechBody(text: string, outputFormat = FORMAT, voiceSettings?: Record<string, unknown> | null,
  seed?: number | null, language?: string | null): SpeechBody {
  const body: SpeechBody = { text: text.normalize("NFC").replace(SPACES, " ").replace(/^ | $/g, ""), outputFormat };
  const settings = Object.entries(voiceSettings ?? {}).filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (settings.length) body.voiceSettings = Object.fromEntries(settings);
  if (seed !== null && seed !== undefined) body.seed = seed;
  if (language) body.language = language;
  return body;
}

/** JSON with sorted keys and no spaces. JSON.stringify already writes 1.0 as 1 and keeps non-ASCII as it is. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The voice id and the request as one line of JSON: sorted keys, no spaces, non-ASCII kept as it is. */
function canonical(voiceId: string, body: SpeechBody): string {
  return sortedJson({ voiceId: voiceId.trim().toLowerCase(), ...body });
}

/** The clip's key: SHA-256 of canonical(), as 64 hex characters. Use it as the file name. */
function clipKey(voiceId: string, body: SpeechBody): string {
  return createHash("sha256").update(canonical(voiceId, body), "utf8").digest("hex");
}

if (process.argv.length > 3) {
  const body = speechBody(process.argv[2]);
  console.log(`request:   ${canonical(process.argv[3], body)}`);
  console.log(`key:       ${clipKey(process.argv[3], body)}`);
  process.exit(0);
}

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "cache-key-vectors.json");
const vectors = JSON.parse(readFileSync(VECTORS, "utf8")).vectors;
console.log("vectors:   speech/cache-key-vectors.json");
let failed = 0;
for (const v of vectors) {
  const body = speechBody(v.text, v.outputFormat ?? FORMAT, v.voiceSettings, v.seed, v.language);
  const ok = canonical(v.voiceId, body) === v.canonical && clipKey(v.voiceId, body) === v.key;
  if (!ok) failed++;
  console.log(`${(ok ? "pass" : "FAIL").padEnd(10)} ${v.key.slice(0, 12)}…  ${v.name}`);
}
console.log(`result:    ${vectors.length - failed} of ${vectors.length} pass`);
process.exit(failed ? 1 : 0);
