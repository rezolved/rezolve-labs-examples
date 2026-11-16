/**
 * speech · Correct misheard words in a transcript.
 *
 * Transcription writes what it hears, so a word the owner cares about can come back as a sound-alike: "Saltmarsh"
 * as "salt marsh". Transcription takes no word list, so your server corrects the transcript before it shows it or
 * sends it to the agent, and the agent's instructions name the spellings.
 *
 * The words are `vocabulary[]` and each `pronunciations[].word` in site-assistant.yaml (or the example). correct()
 * puts back a word's spelling where the transcript has it in another case, split by spaces or hyphens, or as one of
 * its sound-alikes: the optional `soundAlikes` map in the YAML, {word: [what transcription writes]}.
 *
 * With no text, each word is spoken in a test sentence, transcribed, and corrected; what was heard in its place is
 * printed as `soundAlikes` to add to the YAML. With a text, only that text is corrected (no calls). Both end with the
 * lines to add to the agent's instructions.
 *
 * Run: npx tsx speech/speech-sound-alikes.ts ["transcript to correct"]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "..", "site-setup", "site-assistant.example.yaml");
const LANGUAGE = "en-GB"; // the visitors' language, as a language-region locale
const TEST = "Tell me about {word}, please."; // the test sentence each word is spoken in
const PLACE = /^\W*tell me about (.+?)\W*please\W*$/i; // finds what was heard in the word's place

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors.
 * A FormData body is sent as multipart fields instead of JSON. */
async function labs(method: string, path: string, body?: unknown): Promise<Response> {
  const form = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, "User-Agent": UA, ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let line = `[labs] ${method} ${path} -> ${res.status} credits=${res.headers.get("X-Credits-Charged") ?? "-"}`;
  if (!res.ok) line += " body=" + (await res.clone().text()).slice(0, 300).replace(/\n/g, " ");
  console.log(line);
  return res;
}

/** The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why). */
async function data_of(res: Response | Promise<Response>, what: string): Promise<any> {
  const answer = await res;
  if (!answer.ok) fail(`${what}: see the body above.`);
  return (await answer.json()).data;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The transcript with each word spelled as the owner spells it, matched as whole words in any case. */
function correct(text: string, words: string[], alikes: Record<string, string[]>): string {
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    const forms = [[...word.replace(/ /g, "")].map(escape).join("[\\s-]?"), // "saltmarsh", "salt marsh", "salt-marsh"
      ...(alikes[word] ?? []).map(escape)];
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${forms.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
    text = text.replace(pattern, (_m: string, at: number, whole: string) => { // a capital only where a sentence starts
      const before = whole.slice(0, at).trimEnd();
      return !before || ".!?".includes(before.at(-1)!) ? word[0].toUpperCase() + word.slice(1) : word;
    });
  }
  return text;
}

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
console.log(`answers:   ${relative(process.cwd(), ANSWERS)}`);
const words: string[] = [...new Set<string>([...(site.vocabulary ?? []), ...(site.pronunciations ?? []).map((p: any) => p.word)])];
const alikes: Record<string, string[]> = // plus any heard below
  Object.fromEntries(words.map((w) => [w, [...(site.soundAlikes?.[w] ?? [])]]));
if (!words.length) fail("No vocabulary[] or pronunciations[] in the answers: no words to listen for.");
console.log(`words:     ${words.join(", ")}`);

const found: Record<string, string[]> = {};
if (process.argv[2] !== undefined) {
  console.log(`heard:     ${process.argv[2]}`);
  console.log(`corrected: ${correct(process.argv[2], words, alikes)}`);
} else {
  let voiceId: string = process.env.LABS_VOICE_ID || site.voiceId;
  if (!voiceId) {
    const voices = (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items;
    voiceId = voices.find((v: any) => v.isPublic && v.status === "ready").id;
  }
  console.log(`voice:     ${voiceId}`);
  for (const word of words) {
    const said = TEST.replace("{word}", word);
    const speech = await labs("POST", `/voice-audio/voices/${voiceId}/speech`, { text: said, outputFormat: "mp3_44100_64" });
    if (speech.status !== 200) continue;
    const form = new FormData();
    form.append("audio", new Blob([Buffer.from(await speech.arrayBuffer())], { type: "audio/mpeg" }), "said.mp3");
    form.append("language", LANGUAGE);
    const heard: string = (await data_of(labs("POST", "/transcription/voices/transcriptions", form), "Transcription failed")).text;
    const place = heard.match(PLACE);
    if (place && ![word.toLowerCase(), ...alikes[word].map((a) => a.toLowerCase())].includes(place[1].toLowerCase())) {
      alikes[word].push(place[1].toLowerCase());
      (found[word] ??= []).push(place[1].toLowerCase());
    }
    console.log(`said:      ${said}`);
    console.log(`heard:     ${heard}`);
    console.log(`corrected: ${correct(heard, words, alikes)}`);
  }
  if (Object.keys(found).length) {
    console.log("add to site-assistant.yaml:");
    console.log("soundAlikes:");
    for (const [word, heardAs] of Object.entries(found)) {
      console.log(`  ${JSON.stringify(word)}: [${heardAs.map((h) => JSON.stringify(h)).join(", ")}]`);
    }
  }
}

console.log("add to the agent's instructions:");
console.log(`- Spell these exactly as written: ${words.join(", ")}.`);
const misheard = words.flatMap((w) => alikes[w].map((h) => `"${h}" as ${w}`));
if (misheard.length) console.log(`- Visitors may speak, so a word can arrive misheard: read ${misheard.join(", ")}.`);
