/**
 * Configures ArkType for `arktype-string-keywords.ts` from its arguments: `--jitless` as the CLI
 * entry configures it, and `--configured` with the descriptions in `arktype-configured-keywords.ts`.
 * Import it before any module that imports `arktype`: ArkType reads both settings when `arktype`
 * first evaluates.
 */
import { configure } from "arktype/config";
import { CONFIGURED_KEYWORDS } from "./arktype-configured-keywords";

configure({
	jitless: process.argv.includes("--jitless"),
	...(process.argv.includes("--configured") ? { keywords: CONFIGURED_KEYWORDS } : {}),
});
