/**
 * What a site can plug in, before or after the widget loads:
 *
 *   window.siteAssistantHooks = {
 *     consent: async (kind) => myConsentManager.allows(kind),        // "microphone" | "storage"
 *     navigate: (path) => { router.push(path); return true; },       // a single-page app's router
 *     returning: () => Boolean(currentUser),                         // play `welcome.back` instead
 *   };
 */
export interface Hooks {
  /** Called before the microphone or browser storage is first used. Without it, the widget asks in its panel. */
  consent?(kind: "microphone" | "storage"): boolean | Promise<boolean>;
  /** Opens one of the owner's pages. Return true if your router handled it; otherwise the browser loads the page. */
  navigate?(path: string): boolean | void;
  /** True for a visitor you know has been before (your login knows; the widget can't). */
  returning?(): boolean;
}

declare global { interface Window { siteAssistantHooks?: Hooks } }

export const hooks = (): Hooks => window.siteAssistantHooks ?? {};
