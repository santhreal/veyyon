/**
 * Phase one of applying a user's `.env`: directory-location keys from `$HOME/.env` before anything resolves a directory.
 * `dirs.ts` builds paths at module load, so `VEYYON_CODING_AGENT_DIR` and `XDG_*` must be seen before caching.
 * Only {@link DIR_LOCATION_ENV_KEYS} come through here, not the whole file. `VEYYON_PROFILE` is excluded (circular).
 * Does NOT scrub `Bun.env` — that belongs to phase two.
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
