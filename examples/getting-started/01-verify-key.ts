/**
 * 01 · Verify the key.
 *
 * Checks LABS_API_KEY with GET /api-keys/verify (free) and prints its kind, plan, rate limit and the families it
 * can call. Every call sends an explicit User-Agent, as the Python twin must.
 *
 * Run: npx tsx getting-started/01-verify-key.ts
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) { // the nearest .env above this file
  if (existsSync(join(d, ".env"))) { process.loadEnvFile(join(d, ".env")); break; }
  if (d === dirname(d)) break;
}
const KEY = process.env.LABS_API_KEY || fail("Set LABS_API_KEY in .env (copy env.example).");
const API = process.env.LABS_BASE_URL || "https://api.rezolvelabs.com/api/v1";
const UA = "labs-playbook-examples/1.0"; // any explicit User-Agent works

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

const res = await labs("GET", "/api-keys/verify");
if (res.status !== 200) fail("The key was refused: see the body above.");
const key = await res.json();
console.log(`key:        ${key.kind} (${key.environment})`);
console.log(`plan:       ${key.plan}, ${key.rate_limit_per_minute} requests a minute`);
console.log(`families:   ${key.families.map((f: { slug: string }) => f.slug).join(", ")}`);
if (key.kind !== "secret") {
  console.log("This key can only read. Your server needs a secret (sk) key; a publishable (pk) key is for browsers.");
}
