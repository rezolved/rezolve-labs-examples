/**
 * setup-03 · Build the agent's instructions from the answers.
 *
 * Builds the instructions from site-assistant.yaml every time, never by editing the old text, so no rule is lost:
 * persona (Q1), business (Q2), spellings (Q4, Q8), off-limits topics and redirects (Q7), house style (Q8), answer
 * length (Q9), what it cannot do and the contact page (Q15), and the pages it may point to (Q6, Q12), which end an
 * answer with a plain "Read more: /path" line. Checks the 20,000-character limit, then saves the text as the
 * prompt of the agent's flow: an agent's instructions can't be changed with PATCH. The save is a new flow
 * version, live at once; there is no publish step (setup-05 saves one to roll back to). An open chat may keep the
 * old instructions, so test each change in a new chat.
 *
 * Run: npx tsx site-setup/setup-03-build-instructions.ts [--dry-run]   (--dry-run prints the text only)
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
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works
const LIMIT = 20000; // characters, on create and on a flow save alike
const ANSWERS = existsSync("site-assistant.yaml")
  ? "site-assistant.yaml" : join(dirname(fileURLToPath(import.meta.url)), "site-assistant.example.yaml");

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

/** The `data` of a successful answer. If the call failed, stops with `what` (the log line above says why). */
async function data_of(res: Response | Promise<Response>, what: string): Promise<any> {
  const answer = await res;
  if (!answer.ok) fail(`${what}: see the body above.`);
  return (await answer.json()).data;
}

const SYMBOLS: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" }; // the price example in the product desk's instructions

/** The whole instructions text, from the answers alone: the agent's, or with desk=true its product desk's, the
 * step setup-06 adds for the catalogue. The two differ only in where their answers come from. handoff=false leaves
 * out the hand-off to a desk the agent doesn't have yet. */
function build(site: any, desk = false, handoff = true): string {
  const { storeName: store, persona, style, answerStyle: size } = site;
  const catalogue = site.catalogue ?? {};
  const contact = site.contact.path;
  const pages = site.followUp.offerNavigation && site.navigation.enabled && site.routes.length > 0;
  const lines = persona.voice === "person"
    ? [`You are ${persona.name}, speaking in the first person for ${store} on its website. `
      + "The welcome has introduced you: don't introduce yourself again in an answer."]
    : [`You are the website assistant for ${store}. Speak for the business as "we".`];
  if (desk) {
    lines.push("", `Answer questions about ${store}'s products from the catalogue you search. Name each product exactly `
      + "as the catalogue does, capitals included. Give "
      + `prices in ${catalogue.currency} with the currency's symbol, such as `
      + `${SYMBOLS[catalogue.currency] ?? catalogue.currency + " "}4.50, not its code. Never name a `
      + `product, price or detail the search didn't return; if nothing fits, say so and offer the contact page `
      + `(${contact}). The visitor sees and hears only your words: never mention a screen, cards or pictures.`);
  } else {
    lines.push("", "Answer only from the knowledge base and these instructions. If the answer is not there, say you "
      + `don't know and offer the contact page (${contact}).`);
    if (catalogue.source && handoff) { // the catalogue is the desk's: a step can't search pages and products
      lines.push("For any question about a product, its price or what we sell, call transfer_to_product_desk and "
        + "say nothing yourself.");
    }
  }
  lines.push("", "How to answer:",
  `- Your answers are read aloud. Use at most ${size.spokenMaxWords} words in ${size.spokenMaxSentences} `
    + `sentence${size.spokenMaxSentences === 1 ? "" : "s"}. If the visitor asks for more detail, use up to `
    + `${size.textMaxWords} words.`,
  "- Write plain sentences only: no markdown, lists, headings, bold, links or emoji.",
  `- Tone: ${style.tone}. Use ${style.spelling} spelling, ${style.serialComma ? "with" : "without"} the serial comma.`);
  // each once, in order; the desk names products as the catalogue spells them, so it keeps the brand's only
  const spellings = [...new Set([...style.brandSpellings, ...(desk ? [] : site.vocabulary)])];
  if (spellings.length) lines.push(`- Spell these exactly as written: ${spellings.join(", ")}.`);
  const heard = Object.entries<string[]>(site.soundAlikes ?? {}).flatMap(([word, alikes]) => alikes.map((a) => `read "${a}" as ${word}`));
  if (heard.length) { // for a transcript that reaches the agent uncorrected (see speech/speech-sound-alikes)
    lines.push(`- Visitors may speak, so a word can arrive misheard: ${heard.join("; ")}.`);
  }
  if (site.offLimits.length) {
    lines.push("", "Off limits:", ...site.offLimits.map((t: string) => `- Do not discuss ${t}. Say politely that you can't help with that.`));
  }
  if (site.redirects.length) {
    lines.push("", "Redirects:", ...site.redirects.map((r: any) => `- If asked about ${r.topic}, say: "${r.say}"`
      + (pages && r.path ? ` End with "Read more: ${r.path}".` : "")));
  }
  if (site.capabilities.cannot.length) {
    lines.push("", "What you cannot do:", ...site.capabilities.cannot.map((c: string) => `- You cannot ${c}.`),
      `- When asked, say so plainly and offer the contact page (${contact}).`);
  }
  if (pages) {
    lines.push("", "Pages: when one of these pages answers the question, end your answer with a last line of its own, "
      + '"Read more: <path>", with the path exactly as listed. Never invent a path; leave the line out when '
      + "no page fits.",
    ...site.routes.map((r: any) => `- ${r.path}: ${r.label}` + (r.aliases.length ? ` (also: ${r.aliases.join(", ")})` : "")));
  }
  return lines.join("\n") + "\n";
}

const site = YAML.parse(readFileSync(ANSWERS, "utf8"));
const instructions = build(site);
const deskText = site.catalogue?.source ? build(site, true) : null;
const chars = (s: string) => [...s].length; // characters, as the limit counts them (not UTF-16 units)
const length = Math.max(chars(instructions), chars(deskText ?? ""));
console.log(`answers:  ${relative(process.cwd(), ANSWERS)}`);
console.log(`built:    ${chars(instructions)} characters (limit ${LIMIT})` + (deskText ? `; the product desk ${chars(deskText)}` : ""));
if (length > LIMIT) {
  fail(`Too long by ${length - LIMIT} characters: shorten the answers, or move facts into the knowledge base (setup-04).`);
}
if (process.argv.includes("--dry-run")) {
  process.stdout.write("\n" + instructions);
  if (deskText) process.stdout.write("\n--- the product desk ---\n" + deskText);
  process.exit(0);
}

const agent = process.env.LABS_AGENT_ID || fail("Set LABS_AGENT_ID in .env (setup-02 makes one).");
let res!: Response;
for (const attempt of [1, 2]) { // a 409 means someone saved since we read: read again and reapply
  const flow = await data_of(labs("GET", `/developer-platform/agents/${agent}/flow`), "Could not read the agent's flow");
  if (!flow.nodes.length) fail("This agent has no flow yet: create it with instructions (setup-02).");
  const entry = flow.nodes.find((n: any) => n.type === "initial") ?? flow.nodes[0];
  const desk = flow.nodes.find((n: any) => n.data.product_search_collection);
  let text = instructions;
  if (deskText && !desk) { // no desk yet: a hand-off to it would fail, so the pages answer everything for now
    text = build(site, false, false);
    console.log("note:     no product desk yet: run setup-06-catalogue, then this again");
  }
  if (entry.data.prompt.value === text && (!desk || !deskText || desk.data.prompt.value === deskText)) {
    console.log(`unchanged: flow version ${flow.version} already has these instructions`);
    process.exit(0);
  }
  entry.data.prompt = { type: "inline", value: text };
  if (desk && deskText) desk.data.prompt = { type: "inline", value: deskText };
  res = await labs("PUT", `/developer-platform/agents/${agent}/flow`, { baseVersion: flow.version, nodes: flow.nodes, edges: flow.edges });
  if (res.status !== 409 || attempt === 2) break;
}
if (res.status !== 200) fail("The instructions were not saved: see the body above.");
console.log(`saved:    flow version ${(await res.json()).data.version}, live now: test it in a new chat`);
