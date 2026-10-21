// highlight.js grammar modules ship no per-file declarations; every
// `highlight.js/lib/languages/*` module exports a LanguageFn factory.
declare module "highlight.js/lib/languages/*" {
  import type { LanguageFn } from "highlight.js";
  const language: LanguageFn;
  export default language;
}
