import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";

/**
 * Env vars that redirect the config/agent tree or select a profile. A spawned
 * CLI inheriting any of these (or the real HOME) reads — and via the legacy
 * layout migration in runCli, can MUTATE — the developer's real ~/.veyyon.
 */
const CONFIG_ENV_VARS = ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"] as const;

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
