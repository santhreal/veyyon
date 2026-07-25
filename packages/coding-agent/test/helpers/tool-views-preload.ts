/**
 * Preload that makes a bare `bun test` inside this package work on a fresh clone.
 *
 * `packages/coding-agent/src/export/html/index.ts` imports the gitignored
 * `tool-views.generated.js` at module PARSE time, so on a checkout that has
 * never built it three suites die with "Cannot find module" before a single
 * assertion runs, naming a missing file rather than a missing build step.
 *
 * `bun run test` already covers that through `scripts/ci-test-ts.ts`, but the
 * command a developer actually types is `bun test` from inside the package, and
 * bun runs no `pre`/`post` script for that form. A `bunfig.toml` preload is the
 * one hook it does honour, which is why this file exists as a preload rather
 * than as a helper each suite would have to remember to call.
 *
 * The generation itself lives in `scripts/ensure-tool-views.ts` and is not
 * duplicated here: this module is only the second entry point into it.
 */
import { ensureToolViewsGenerated } from "../../../../scripts/ensure-tool-views";

await ensureToolViewsGenerated();
