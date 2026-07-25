import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";
import { CONFIG_ROOT_ENV_KEYS, XDG_BASE_DIRS } from "../../../utils/test/helpers/isolated-config-root";

/**
 * Env vars that redirect the config/agent tree, select a profile, or move a per-category root. A
 * spawned CLI inheriting any of these (or the real HOME) reads — and via the legacy layout
 * migration in runCli, can MUTATE — the developer's real ~/.veyyon.
 *
 * Both lists are imported rather than restated. This helper used to name the three veyyon
 * variables and nothing else, so a developer running with `XDG_STATE_HOME` set handed every child
 * CLI a state root inside their real tree: `logs/`, `sessions/` and `reports/` resolve there in
 * preference to the config root, and HOME being a temp directory does not change that. Keeping a
 * private copy of the list is what let it fall behind.
 */
const CONFIG_ENV_VARS = [...CONFIG_ROOT_ENV_KEYS, ...XDG_BASE_DIRS] as const;

export interface HermeticSpawnEnv {
	/** Temp dir used as HOME for the spawned process. */
	home: string;
	/** Env for Bun.spawn: process.env with HOME swapped and config vars removed. */
	env: Record<string, string | undefined>;
	/** Remove the temp HOME. Call in afterAll/afterEach or after the spawn. */
	cleanup: () => void;
}

/** Build a spawn env whose HOME is a fresh temp dir, so the child CLI can never
 * read or migrate the developer's real ~/.veyyon. */
export function hermeticSpawnEnv(extra?: Record<string, string>): HermeticSpawnEnv {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-hermetic-home-"));
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of CONFIG_ENV_VARS) {
		delete env[key];
	}
	Object.assign(env, extra);
	return { home, env, cleanup: () => removeSyncWithRetries(home) };
}
