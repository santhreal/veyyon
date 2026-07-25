import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";

/** A temp HOME in force for the current process, and the way back. */
export interface TempHome {
	/** The directory now standing in for the user's home. */
	home: string;
	/** Put the previous HOME and XDG values back, then delete the temp tree. */
	restore: () => void;
}

const VARS = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"] as const;

/**
 * Point this process's HOME (and the XDG vars derived from it) at a fresh temp
 * directory.
 *
 * Anything that resolves a completion file, a profile, or a config path reads
 * these at call time from `process.env`, so a test that exercises those paths
 * in-process reads and can overwrite the developer's real dotfiles. That is not
 * hypothetical: the source-update suite drove a completion refresh against
 * ~/.config/fish and ~/.local/share/bash-completion, and only left them intact
 * because its fake launcher failed to generate anything.
 *
 * Use {@link hermeticSpawnEnv} instead when the code under test is a child
 * process; this one is for code running in the test process itself.
 */
export function enterTempHome(): TempHome {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-temp-home-"));
	const previous = new Map<string, string | undefined>(VARS.map(v => [v, process.env[v]]));
	process.env.HOME = home;
	delete process.env.XDG_DATA_HOME;
	delete process.env.XDG_CONFIG_HOME;
	return {
		home,
		restore: () => {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			removeSyncWithRetries(home);
		},
	};
}
