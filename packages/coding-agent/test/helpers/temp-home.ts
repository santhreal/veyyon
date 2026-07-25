import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";
import { enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

/** A temp HOME in force for the current process, and the way back. */
export interface TempHome {
	/** The directory now standing in for the user's home. */
	home: string;
	/** Put the previous HOME, XDG and config-dir values back, then delete the temp tree. */
	restore: () => void;
}

/**
 * Only `HOME` is this helper's business.
 *
 * The XDG base directories are the delegate's: it clears all four of them (they outrank the config
 * root per category) and restores each one exactly. This list used to name two of the four and clear
 * them here, which is how `XDG_STATE_HOME` and `XDG_CACHE_HOME` kept pointing at the real tree inside
 * a temp home — every state-category path (`logs/`, `sessions/`, `reports/`) resolved outside the
 * directory this helper promises everything is under. Two partial lists of the same variables is the
 * defect; one owner is the fix.
 */
const VARS = ["HOME"] as const;

/**
 * Point this process's home-derived paths at a fresh temp directory.
 *
 * Two different mechanisms have to be redirected, and knowing WHICH is which is the
 * whole point of this helper:
 *
 *  - Code that reads `process.env.HOME` at call time. Shell completion files
 *    (`~/.config/fish`, `~/.local/share/bash-completion`) and anything spawning a
 *    child follow `HOME`, so assigning it is enough. That is not a hypothetical risk:
 *    the source-update suite drove a completion refresh against the developer's real
 *    fish and bash-completion directories, and only left them intact because its fake
 *    launcher failed to generate anything.
 *  - Code that resolves veyyon's own config root. That goes through `os.homedir()`,
 *    which **does not follow a mid-process `HOME` assignment under Bun** — it is
 *    resolved once at process start, verified directly. So `HOME` alone leaves
 *    settings, profiles, sessions and credentials pointed at the REAL `~/.veyyon`,
 *    which is exactly the trap `docs/internal/testing.md` describes: one root
 *    redirected, another asserted, real user data written the whole time.
 *
 * The second mechanism is delegated to `enterIsolatedConfigRoot`, the one implementation
 * of "move the config root" (`packages/utils/test/helpers/isolated-config-root.ts`), told
 * to place the root inside this temp home rather than in `os.tmpdir()` so that everything
 * this process writes really is under `home`. It owns the parts that are easy to get
 * wrong: the value is relative to the REAL home because that is what it is joined onto,
 * `VEYYON_CODING_AGENT_DIR` and the four `XDG_*_HOME` bases are cleared because each of them
 * outranks the config root, and the cached resolver is told to re-read.
 *
 * Use `hermeticSpawnEnv` instead when the code under test is a CHILD process: a child
 * gets a fresh `os.homedir()` from the `HOME` it is given, so it needs none of this.
 */
export function enterTempHome(): TempHome {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-temp-home-"));
	const previous = new Map<string, string | undefined>(VARS.map(v => [v, process.env[v]]));
	process.env.HOME = home;
	const isolated = enterIsolatedConfigRoot("temp-home", { root: path.join(home, ".veyyon") });
	return {
		home,
		restore: () => {
			isolated.restore();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			removeSyncWithRetries(home);
		},
	};
}
