import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeSyncWithRetries } from "@veyyon/utils";
import { enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

/**
 * The developer's real config root, read at module load.
 *
 * Read here and never again: once a suite installs the `os.homedir` spy below there is
 * no way back to the real value from inside the process, and this module is imported
 * before any test body runs, so this is the last honest reading.
 */
const REAL_CONFIG_ROOT = path.join(os.homedir(), ".veyyon");

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
 *  - Code that resolves a FOREIGN tool's home-relative tree: `~/.claude/skills`,
 *    `~/.codex/hooks`, `~/.config/fish/completions`. Those go through `os.homedir()`
 *    too, and no amount of veyyon config-root redirection moves them, so a suite
 *    asserting "the foreign skill is not loaded" was reading whatever the developer
 *    happens to have installed. The `os.homedir` spy is the only thing that moves
 *    them, and it is installed BEFORE the config root is entered so the relative
 *    value that root writes is computed against the temp home rather than the real
 *    one. Reverse that order and the join lands back outside the temp tree.
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
	const home = mkdtempSync(path.join(os.tmpdir(), "veyyon-temp-home-"));
	const previous = new Map<string, string | undefined>(VARS.map(v => [v, process.env[v]]));
	process.env.HOME = home;
	const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
	const isolated = enterIsolatedConfigRoot("temp-home", { root: path.join(home, ".veyyon") });
	return {
		home,
		restore: () => {
			// The spy comes off FIRST. `isolated.restore()` ends by re-deriving every cached
			// path from the restored environment, and with the spy still reporting the temp
			// home that re-derivation caches `<temp home>/.veyyon/...` as the restored root:
			// the variables read correct and the resolver answers wrong for the rest of the
			// process.
			homedirSpy.mockRestore();
			isolated.restore();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			removeSyncWithRetries(home);
		},
	};
}

/**
 * How long one temp home lasts.
 *
 * `"file"` builds it once for the whole file. `"test"` builds a fresh one per case, which
 * a suite needs only when its cases WRITE into the home (a user personality, a global
 * `AGENTS.md`) and would otherwise read each other's fixtures.
 *
 * The default is `"file"` because the per-case form is not free: a brand-new config root
 * makes the prompt builder re-seed and re-scan a directory tree it had already resolved,
 * measured at roughly 300ms per case, which turned a 1.3s suite into 6.9s. Isolation from
 * the DEVELOPER, which is the rule being enforced, is complete either way, so paying that
 * per case buys nothing unless the cases can actually see each other.
 */
export type TempHomeScope = "file" | "test";

/**
 * Give the calling file a temp home, and PROVE the redirect took.
 *
 * The proof is the point. Isolation that is merely INTENDED is the failure mode this
 * whole helper exists for: ten suites assigned `process.env.HOME` in `beforeEach`,
 * asserted against paths they built by hand under that temp home, passed, and read the
 * developer's real `~/.veyyon` the entire time, because `os.homedir()` never moved. Every
 * one of those suites LOOKED isolated. So this asks the resolver where the agent
 * directory actually is, before any test body gets to run, and refuses to proceed if the
 * answer names anything outside the temp tree.
 *
 * Returns an accessor rather than a value because the home does not exist yet at
 * registration time, and under `"test"` scope there is a different one for every case.
 */
export function useTempHome(scope: TempHomeScope = "file"): () => string {
	let active: TempHome | undefined;
	const enter = (): void => {
		active = enterTempHome();
		const agentDir = getAgentDir();
		expect(agentDir.startsWith(active.home)).toBe(true);
		expect(agentDir.startsWith(REAL_CONFIG_ROOT)).toBe(false);
		expect(os.homedir()).toBe(active.home);
	};
	const leave = (): void => {
		active?.restore();
		active = undefined;
	};
	if (scope === "file") {
		beforeAll(enter);
		afterAll(leave);
	} else {
		beforeEach(enter);
		afterEach(leave);
	}
	return () => {
		if (!active) throw new Error("useTempHome(): no temp home is active, call the accessor inside a test");
		return active.home;
	};
}
