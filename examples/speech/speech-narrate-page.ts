/**
 * Read a page aloud: its readable text, spoken in short parts, checked, joined into one MP3 and cached.
 *
 * Reads a page (a file or a URL; by default site-setup/sample-site/index.html) and keeps the text a visitor reads:
 * the <article>, else the <main>, else the body without its header and footer, and never scripts, styles,
 * navigation or forms. It splits that text at sentence ends into parts of at most 150 characters and speaks each one.
 * Designed, public and cloned voices can leave a passage out of a longer call without any error, so the parts are
 * short, and a part whose audio is too short for its text is spoken again with another seed. The clips are joined
 * into one MP3, named by a hash of the voice, the format and the parts, so an unchanged page costs nothing on the
 * next run: the file is already there.
 *
 * Uses LABS_VOICE_ID, or else the first ready public voice. --max N sets the longest part, up to 3,000 characters
 * (the most one call takes).
 *
 * Run: npx tsx speech/speech-narrate-page.ts [file or URL] [--max N]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // every call sends an explicit User-Agent
const LIMIT = 3000; // the most characters one speech call takes
const PART = 150; // the longest part; longer calls can come back with a passage missing
const TOO_FAST = 25; // characters a second; a part "spoken" faster than this is missing some of its text
const TRIES = 3; // times to speak a part before keeping what came back
const FORMAT = "mp3_44100_64"; // a constant 64 kbit/s, so 8 bytes of audio a millisecond

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** One Labs call, logged: method, path, status, X-Credits-Charged, and a body preview on errors. */
async function labs(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(API + path, {
    method,
    headers: { "X-API-KEY": KEY, "Content-Type": "application/json", "User-Agent": UA },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let line = `[labs] ${method} ${path} -> ${res.status} credits=${res.headers.get("X-Credits-Charged") ?? "-"}`;
  if (!res.ok) line += " body=" + (await res.clone().text()).slice(0, 300).replace(/\n/g, " ");
  console.log(line);
  return res;
}

/** labs() that tries again after a 429 (waiting Retry-After) or a 5xx (after 1, 2, 4 and 8 s). Neither is charged. */
async function retrying(method: string, path: string, body?: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await labs(method, path, body);
    const wait = res.status === 429 ? Number(res.headers.get("Retry-After") ?? 1)
      : res.status >= 500 && attempt < 4 ? 2 ** attempt : 0;
    if (!wait || attempt >= 29) return res;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

/** The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why). */
async function data_of(res: Response | Promise<Response>, what: string): Promise<any> {
  const answer = await res;
  if (!answer.ok) fail(`${what}: see the body above.`);
  return (await answer.json()).data;
}

/** The page's HTML, from a URL (logged like a Labs call) or a file. */
async function readPage(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return readFileSync(source, "utf8");
  const res = await fetch(source, { headers: { "User-Agent": UA } });
  console.log(`[page] GET ${source} -> ${res.status}`);
  if (res.status >= 400) fail("Could not read the page.");
  return res.text();
}

const NOISE = /<!--[\s\S]*?-->|<(head|script|style|noscript|template|svg|nav|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ARTICLE = /<article\b[^>]*>([\s\S]*)<\/article\s*>/i;
const MAIN = /<main\b[^>]*>([\s\S]*)<\/main\s*>/i;
const FRAME = /<(header|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_END = /<br\s*\/?>|<\/(p|h[1-6]|li|dt|dd|div|section|article|blockquote|figcaption|pre|tr|td|th)\s*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", euro: "€", pound: "£" };
const chars = (s: string) => [...s].length; // characters as the API counts them, not UTF-16 units

function entity(match: string, name: string): string {
  if (name[0] === "#") {
    const code = /^#[xX]/.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return ENTITIES[name] ?? match;
}

/** The words a visitor reads, one block after another. A block without a full stop (a heading, a list item)
 * gets one, so the voice pauses after it instead of running it into the next. */
function readableText(html: string): string {
  html = html.replace(NOISE, " ");
  const found = ARTICLE.exec(html) ?? MAIN.exec(html);
  html = (found ? found[1] : html.replace(FRAME, " ")).replace(BLOCK_END, "\n");
  const text = html.replace(/<[^>]*>/g, "").replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, entity);
  const blocks = text.split("\n").map((b) => b.replace(/\s+/g, " ").trim());
  return blocks.filter((b) => b).map((b) => (/[.!?…:;]["'”’)\]]*$/.test(b) ? b : b + ".")).join(" ");
}

/** Where to cut a sentence longer than `most`: after the last comma, semicolon or colon that fits, else at the
 * last space. Counts characters, not UTF-16 units. */
function cutAt(points: string[], most: number): number {
  for (let i = Math.min(most, points.length - 1) - 1; i > 0; i--) {
    if (",;:".includes(points[i]) && points[i + 1] === " ") return i + 1;
  }
  const space = points.lastIndexOf(" ", most);
  return space > 0 ? space : most;
}

/** The text in parts of at most `most` characters: whole sentences where they fit. */
function partsOf(text: string, most: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (let s of text.split(/(?<=[.!?…])\s+/)) {
    while (chars(s) > most) { // a sentence longer than a part
      if (current) {
        parts.push(current);
        current = "";
      }
      const points = [...s];
      const at = cutAt(points, most);
      parts.push(points.slice(0, at).join(""));
      s = points.slice(at).join("").trim();
    }
    if (!s) continue;
    if (current && chars(current) + 1 + chars(s) > most) {
      parts.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  return current ? [...parts, current] : parts;
}

/** The clip without the ID3 tag at its start, if it has one: joined clips keep only the first. */
function withoutTag(clip: Buffer): Buffer {
  if (clip.subarray(0, 3).toString("latin1") !== "ID3") return clip;
  const size = (clip[6] << 21) | (clip[7] << 14) | (clip[8] << 7) | clip[9]; // 7 bits a byte
  return clip.subarray(10 + size + (clip[5] & 0x10 ? 10 : 0)); // header, tag, and footer if flagged
}

/** The audio for one part, and the credits it cost. Audio too short for the text is made again, with another
 * seed if the voice takes one: the same request can give the same short clip again. */
async function speak(voice: any, part: string): Promise<[Buffer, number]> {
  let credits = 0;
  let clip = Buffer.alloc(0);
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const body: Record<string, unknown> = { text: part, outputFormat: FORMAT };
    if (attempt > 1 && voice.supportedSettings?.seed) body.seed = attempt;
    const res = await retrying("POST", `/voice-audio/voices/${voice.id}/speech`, body);
    if (res.status !== 200) fail("A part was refused: see the body above. No audio was saved.");
    credits += Number(res.headers.get("X-Credits-Charged") ?? 0);
    clip = Buffer.from(await res.arrayBuffer());
    const ms = Math.floor(withoutTag(clip).length / 8);
    if (chars(part) * 1000 <= TOO_FAST * ms) return [clip, credits];
    console.log(`short:   ${chars(part)} characters in ${ms} ms, so some of the text is missing`);
  }
  console.log(`warning: still short after ${TRIES} tries; listen to this part`);
  return [clip, credits];
}

const args = process.argv.slice(2);
const source = args.find((a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--max")) ?? "site-setup/sample-site/index.html";
const most = args.includes("--max") ? Math.min(Number(args[args.indexOf("--max") + 1]), LIMIT) : PART;
const text = readableText(await readPage(source));
const parts = partsOf(text, most);
if (!parts.length) fail(`${source} has no text to read.`);
console.log(`page:    ${source}, ${chars(text)} characters of text`);
console.log(`parts:   ${parts.length} of at most ${most} characters`);

const voiceId = process.env.LABS_VOICE_ID;
const voice = voiceId
  ? await data_of(labs("GET", `/voice-audio/voices/${voiceId}`), "Could not read the voice in LABS_VOICE_ID")
  : (await data_of(labs("GET", "/voice-audio/voices/list?pageSize=100"), "Could not list the voices")).items
    .find((v: any) => v.isPublic && v.status === "ready");
console.log(`voice:   ${voice.id.slice(0, 8)}… (${voice.voiceType}${voice.isPublic ? ", public" : ""})`);

const key = createHash("sha256").update([voice.id, FORMAT, ...parts].join("\n")).digest("hex").slice(0, 16);
const out = `out/narrate/${key}.mp3`;
let charged = 0;
if (existsSync(out)) {
  console.log(`cached:  ${out} is already there, so nothing is spoken`);
} else {
  mkdirSync("out/narrate", { recursive: true });
  writeFileSync(out.replace(/\.mp3$/, ".txt"), parts.join("\n") + "\n");
  const clips: Buffer[] = [];
  for (const [i, part] of parts.entries()) {
    const [clip, credits] = await speak(voice, part);
    clips.push(clips.length ? withoutTag(clip) : clip);
    charged += credits;
    console.log(`part ${i + 1}: ${chars(part)} characters: ` + part.split(" ").slice(0, 6).join(" ") + " …");
  }
  writeFileSync(out, Buffer.concat(clips));
  console.log(`saved:   ${out} and its text in ${out.replace(/\.mp3$/, ".txt")}`);
}
console.log(`credits: ${charged} for the page`);
