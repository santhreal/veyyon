/**
 * Phase one of applying a user's `.env`: the directory-location keys out of `$HOME/.env`, before anything
 * resolves a directory.
 *
 * WHY THIS RUNS FIRST AND WHO DEPENDS ON IT. `dirs.ts` builds `activeProfile` and its `DirResolver` at
 * module load, and what those resolve to is decided by `VEYYON_CODING_AGENT_DIR` and the `XDG_*` variables.
 * If a user sets one of those in `$HOME/.env`, the resolver has to see it BEFORE it caches anything, so
 * `dirs.ts` imports this module for its side effect and this module imports nothing that can reach
 * `dirs.ts`.
 *
 * WHAT IT DOES NOT DO, because two gates caught the first attempt, and both were right.
 *
 * It does not apply the WHOLE file. Only {@link DIR_LOCATION_ENV_KEYS} -- the agent dir, the config-dir name
 * and the `XDG_*` bases -- come through here; everything else in `$HOME/.env`, including every API key, is
 * applied by `env.ts`. Whatever this phase puts into `Bun.env` is inherited by every subprocess veyyon
 * spawns, and `packages/coding-agent/src/eval/js/process-entry.ts` deliberately imports
 * `@veyyon/utils/postmortem` by subpath so that the sandboxed evaluator does NOT receive a user's `.env`; its
 * test pins that, and applying the whole file here broke it. `VEYYON_PROFILE` is excluded for a separate
 * reason recorded in `./dir-env-keys`: the profile decides where the other `.env` files are, so reading it
 * from one would be circular, and it was never honoured from a `.env` before.
 *
 * It also does NOT scrub `Bun.env` of names that cannot survive an `execve`. That scrub is a global mutation of the caller's environment and it belongs to
 * phase two, where a program has asked for "the environment" by importing `env.ts`:
 * `profiles.test.ts`'s "dirs module import behavior" pins that importing the path resolver alone leaves
 * inherited `MallocStackLogging` alone, and moving the scrub here broke it. Nothing is lost by the split,
 * because `parseEnvFile` admits only `[A-Za-z_][A-Za-z0-9_]*` names and NUL-free values and the loop below
 * skips the malloc-logging names explicitly, so no key this phase injects is one a later scrub would remove.
 *
 * WHAT IT REPLACED, and it is worth stating because the old arrangement failed silently. All four `.env`
 * layers used to be applied at the bottom of `env.ts`, which imports `dirs.ts`, so the only thing that
 * applied a user's `.env` was importing `env.ts` -- and through `@veyyon/utils` that happened by accident
 * of `export * from "./env"` rather than because anyone asked. Every architecture gate in this repository
 * pushes imports toward the module that OWNS a name, and a file that followed that rule for
 * `getAgentDir` (naming `@veyyon/utils/dirs` instead of the barrel, 15 modules against 74) got a directory
 * resolved without the user's `.env`: not an error, not a warning, a real path to a tree the user never
 * configured. `packages/utils/test/dotenv-reaches-the-resolver-through-any-import.test.ts` reproduced it in two
 * subprocesses and now pins the fix, and `dotenv-precedence.test.ts` pins the ordering it had to preserve.
 *
 * PRECEDENCE IS UNCHANGED, which is the one thing this split had to not break. The order is still
 *
 *     the real environment  >  <cwd>/.env  >  <agentDir>/.env  >  <configRoot>/.env  >  $HOME/.env
 *
 * and `$HOME/.env` is now applied FIRST despite being LAST in that order. So this module records every key
 * it injected in {@link homeDotenvInjectedKeys}, and phase two is allowed to displace exactly those, and
 * nothing else. Without that record the earliest-applied file would win and a key set in both `$HOME/.env`
 * and `<agentDir>/.env` would silently flip to the home value.
 */

import * as os from "node:os";
import * as path from "node:path";
import { DIR_LOCATION_ENV_KEYS } from "./dir-env-keys";
import { parseEnvFile, type UnreadableEnvFileReporter } from "./dotenv-parse";
// The owner of the one-line "what does this error say" question. `type-guards.ts` imports nothing, so it is
// safe here for the same reason `fs-error.ts` is, and `type-guards-source-locks` forbids the inline
// `instanceof Error ? .message : String(...)` this used to spell out.
import { errorMessage } from "./type-guards";

/**
 * Report an unreadable `.env` through `process.emitWarning`.
 *
 * NOT the logger: `logger.ts` asks `dirs.ts` for the log directory, and `dirs.ts` imports this module, so
 * importing the logger here would be a cycle whose resolution order decides whether a warning appears at
 * all. `dirs.ts` already warns at module scope through the same channel, so this is the established way to
 * be loud before the logger exists. Phase two, which has the logger, uses it.
 */
const reportUnreadable: UnreadableEnvFileReporter = (filePath, error) => {
	process.emitWarning(
		`Environment file exists but could not be read; none of its variables were applied: ${filePath} (${errorMessage(
			error,
		)})`,
		{ code: "VEYYON_ENV_FILE_UNREADABLE" },
	);
};

const injected = new Set<string>();

/**
 * The keys this phase set from `$HOME/.env`, which phase two may displace with a higher-priority file.
 *
 * Exposed as a live view rather than a copy on purpose: phase two removes a key from it as it displaces it,
 * so a second, lower-priority file cannot displace the same key again. See the precedence note above.
 */
export const homeDotenvInjectedKeys: Set<string> = injected;

// `$HOME/.env`, the one layer whose location needs no resolved directory, filtered to the keys that decide
// WHERE a directory is. Bun has already applied `<cwd>/.env` by the time any module runs, so a key present
// there is part of "the real environment" as far as this file is concerned and is never overwritten.
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"), reportUnreadable);
for (const key of DIR_LOCATION_ENV_KEYS) {
	const value = homeEnv[key];
	if (value === undefined || Bun.env[key]) continue;
	Bun.env[key] = value;
	injected.add(key);
}
