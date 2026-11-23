/**
 * Page navigation, limited to the owner's routes (`routes[]` in /api/site).
 *
 * - An answer's `link` event (the agent's "Read more: /path" line) becomes an offer to open that page.
 * - "Take me to the bread list", or "yes" after an offer, opens a page with no question sent to the agent.
 *
 * A path that is not one of the routes is never opened, even if the server let it through. On a single-page app,
 * set `window.siteAssistantHooks.navigate` so your router changes the page instead of a full load.
 */
import type { Route } from "./api.js";
import { hooks } from "./hooks.js";

export interface Target { route: Route; path: string }

/** The owner's route for `path`, or null. A #fragment is kept only where the route allows anchors. */
export function routeFor(path: string, routes: Route[]): Target | null {
  let url: URL;
  try {
    url = new URL(path, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  const section = routes.find((r) => r.path.includes("#") && r.path === url.pathname + url.hash); // "/#finding-us"
  if (section) return { route: section, path: section.path };
  const route = routes.find((r) => samePath(r.path, url.pathname));
  return route ? { route, path: route.path + (route.anchorsAllowed ? url.hash : "") } : null;
}

const samePath = (a: string, b: string) => (a.replace(/\/+$/, "") || "/") === (b.replace(/\/+$/, "") || "/");

/** True if `path` is the page already open. A section of a page ("/#finding-us") is never "here": it is offered. */
export const isHere = (path: string): boolean => !path.includes("#") && samePath(path, location.pathname);

const ASK = /^(?:please\s+)?(?:(?:take me|bring me|go|navigate)(?: to)?|open|show me)\s+(.+?)[.!?]*$/i;
const YES = /^(?:yes|yeah|yep|sure|ok|okay|please|go there|take me there|open it|show me)(?:,?\s*(?:please|thanks))?[.!]*$/i;

/** The route a visitor asked to open by its label, alias or path ("take me to the menu"), or null. */
export function routeRequested(text: string, routes: Route[]): Route | null {
  const want = text.trim().match(ASK);
  if (!want) return null;
  const name = plain(want[1]);
  return routes.find((r) => [r.label, r.path, ...r.aliases].some((n) => plain(n) === name)) ?? null;
}

/** True for "yes", "go there" and the like: the answer to an offer. */
export const acceptsOffer = (text: string): boolean => YES.test(text.trim());

/** "the Bread List page, please" → "bread list": what is compared with labels, aliases and paths. */
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim()
  .replace(/\s+please$/, "").replace(/^(?:the|our|your)\s+/, "").replace(/\s+page$/, "");

/** Opens one of the owner's pages: through the site's router if it has one, else a normal page load. */
export function go(path: string, routes: Route[]): boolean {
  const target = routeFor(path, routes);
  if (!target) return false;
  if (hooks().navigate?.(target.path) === true) return true;
  location.assign(target.path);
  return true;
}
