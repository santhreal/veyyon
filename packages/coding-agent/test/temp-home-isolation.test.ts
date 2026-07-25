/**
 * `enterTempHome()` has to move the config root, not just `HOME`.
 *
 * It used to set `HOME` and the XDG variables and stop there, and its own doc claimed
 * that "anything that resolves a completion file, a profile, or a config path reads
 * these at call time from `process.env`". Half of that is false. Veyyon's config root is
 * resolved from `os.homedir()`, which under Bun is fixed at process start and does NOT
 * follow a later `HOME` assignment (probed directly: assigning `HOME` then calling
 * `os.homedir()` returns the original value). So every suite using this helper believed
 * it was isolated while settings, profiles, sessions and credentials still resolved to
 * the developer's real `~/.veyyon`.
 *
 * An isolation helper that does not isolate is the worst kind of test infrastructure:
 * the suites pass, and the damage lands in a real home directory. So the contract is
 * asserted against the RESOLVER — where veyyon says the agent dir is — rather than
 * against the environment variables the helper happens to set.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getLogsDir, refreshDirsFromEnv, setProfile } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { enterTempHome, type TempHome } from "./helpers/temp-home";

let active: TempHome | undefined;
let dirOverrides: DirOverridesSnapshot | undefined;

/**
 * `VEYYON_CODING_AGENT_DIR` is a MORE SPECIFIC lever than the config root, and when it is
 * set it wins — deliberately, and that precedence is pinned at the bottom of this file.
 * Other suites in the same process set it (`useIsolatedAgentDir`) and leave it set, so it
 * is cleared here: with it in force `getAgentDir()` answers from the override and says
 * nothing about whether the config root moved, which is the contract under test.
 */
beforeEach(() => {
	dirOverrides = captureDirOverrides();
	delete process.env.VEYYON_CODING_AGENT_DIR;
	refreshDirsFromEnv();
});

afterEach(() => {
	// The temp home comes down FIRST: its `restore()` writes the agent-dir variable
	// and the module's pre-profile baseline, so undoing the overrides before it runs
	// would let it put its own values back and this file would leak them.
	active?.restore();
	active = undefined;
	// The whole snapshot, not just the environment variable. `enterTempHome` goes
	// through `setAgentDir`, which also overwrites the invisible pre-profile baseline
	// that decides where `setProfile(undefined)` lands — `refreshDirsFromEnv()` cannot
	// see it, so putting the variable back left this file leaking the baseline into
	// every suite that ran after it.
	if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
	dirOverrides = undefined;
});

/** The real config root, so "outside it" can be asserted rather than assumed. */
const realConfigRoot = path.join(os.homedir(), ".veyyon");

describe("the config root under a temp home", () => {
	/** THE regression. Before the fix this resolved to the developer's real
	 * `~/.veyyon/profiles/<profile>/agent`. */
	it("resolves inside the temp home", () => {
		active = enterTempHome();

		expect(getAgentDir().startsWith(active.home)).toBe(true);
	});

	/** Stated as its own assertion because it is the consequence that matters: nothing
	 * the test process writes can reach the real tree. */
	it("resolves outside the real config root", () => {
		active = enterTempHome();

		expect(getAgentDir().startsWith(realConfigRoot)).toBe(false);
		expect(getLogsDir().startsWith(realConfigRoot)).toBe(false);
	});

	/** `HOME` is still redirected, for the code that does read it at call time — shell
	 * completion paths and any child process. Both halves are needed; neither is enough. */
	it("still redirects HOME for the code that reads it directly", () => {
		active = enterTempHome();

		expect(process.env.HOME).toBe(active.home);
		expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
		expect(process.env.XDG_DATA_HOME).toBeUndefined();
		// All four, not the two this helper used to name: the state and cache bases govern
		// `logs/`, `sessions/`, `reports/` and the native/browser caches.
		expect(process.env.XDG_STATE_HOME).toBeUndefined();
		expect(process.env.XDG_CACHE_HOME).toBeUndefined();
	});

	/** The resolver caches every path it answers, so setting the variable without telling
	 * it to re-read would leave the OLD answer in place. This is the same defect wearing
	 * a different hat, and it is why the helper calls `refreshDirsFromEnv`. */
	it("takes effect immediately, not after the next cache miss", () => {
		const before = getAgentDir();
		active = enterTempHome();

		expect(getAgentDir()).not.toBe(before);
	});
});

describe("restoring a temp home", () => {
	/** A helper that leaks its redirection poisons every suite that runs after it in the
	 * same process, which is the failure mode that made `logger-no-transports` leave the
	 * shared logger disabled for everyone downstream. */
	it("puts the real config root back", () => {
		const before = getAgentDir();
		const temp = enterTempHome();
		temp.restore();

		expect(getAgentDir()).toBe(before);
	});

	it("removes the temp tree", () => {
		const temp = enterTempHome();
		const home = temp.home;
		expect(existsSync(home)).toBe(true);

		temp.restore();

		expect(existsSync(home)).toBe(false);
	});

	/** Restoring must not invent a value. An unset variable has to come back unset, or
	 * the next suite inherits a config-dir override nobody chose. */
	it("leaves VEYYON_CONFIG_DIR exactly as it found it", () => {
		const before = process.env.VEYYON_CONFIG_DIR;
		const temp = enterTempHome();
		expect(process.env.VEYYON_CONFIG_DIR).not.toBe(before);

		temp.restore();

		expect(process.env.VEYYON_CONFIG_DIR).toBe(before);
	});
});

describe("the config-root value the helper writes", () => {
	/** It has to be relative to the REAL home, because that is what the variable is
	 * joined onto: `os.homedir()` keeps reporting the real home however `HOME` is set.
	 * Computing it from the temp home instead would land the config root at
	 * `<real home>/<temp home>/...`, back inside the tree this exists to protect. */
	it("is relative to the real home directory, so the join lands in the temp tree", () => {
		active = enterTempHome();
		const value = process.env.VEYYON_CONFIG_DIR ?? "";

		expect(path.isAbsolute(value)).toBe(false);
		expect(path.resolve(os.homedir(), value)).toBe(path.join(active.home, ".veyyon"));
	});
});

describe("an agent-dir override left behind by an earlier suite", () => {
	/**
	 * It is CLEARED, and that is the only answer that makes this helper mean anything.
	 *
	 * `VEYYON_CODING_AGENT_DIR` outranks the config root outright when no named profile is
	 * active, `setAgentDir` writes it into `process.env`, and nothing clears it — so any
	 * earlier suite in the same process that isolated its agent dir would silently redirect
	 * everything here back to that suite's directory, and the temp home would be decoration.
	 * The clearing happens inside `enterIsolatedConfigRoot`, which this helper delegates to;
	 * the precedence itself is pinned in `test/helpers/isolated-roots-lock.test.ts`.
	 */
	it("does not let the override win over the temp home", () => {
		// The whole snapshot, not just the profile name: `setProfile` EXPORTS `VEYYON_PROFILE`,
		// so putting the profile back through it left that variable behind for every later file.
		const dirOverrides = captureDirOverrides();
		setProfile(undefined);
		const leaked = path.join(os.tmpdir(), "veyyon-temp-home-leaked-agent-dir");
		process.env.VEYYON_CODING_AGENT_DIR = leaked;
		refreshDirsFromEnv();
		try {
			active = enterTempHome();

			expect(getAgentDir().startsWith(leaked)).toBe(false);
			expect(getAgentDir().startsWith(active.home)).toBe(true);
		} finally {
			restoreDirOverrides(dirOverrides);
		}
	});

	/** And the restore puts the leaked value back rather than deciding it was wrong: this
	 * helper isolates its own window, it does not clean up after other suites. */
	it("puts the override back on restore", () => {
		// The whole snapshot, not just the profile name: `setProfile` EXPORTS `VEYYON_PROFILE`,
		// so putting the profile back through it left that variable behind for every later file.
		const dirOverrides = captureDirOverrides();
		setProfile(undefined);
		const leaked = path.join(os.tmpdir(), "veyyon-temp-home-leaked-agent-dir");
		process.env.VEYYON_CODING_AGENT_DIR = leaked;
		refreshDirsFromEnv();
		try {
			const temp = enterTempHome();
			temp.restore();

			expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(leaked);
		} finally {
			restoreDirOverrides(dirOverrides);
		}
	});
});

describe("an XDG base directory the developer runs with", () => {
	/**
	 * It is CLEARED, for the same reason the agent-dir override is.
	 *
	 * `DirResolver` resolves the `data`, `state` and `cache` categories under `XDG_DATA_HOME`,
	 * `XDG_STATE_HOME` and `XDG_CACHE_HOME` whenever `$XDG_*_HOME/veyyon` exists, falling back to the
	 * config root only when it does not. So on a machine where `veyyon config init-xdg` has run, a temp
	 * home that moved only the config root still had `logs/`, `sessions/` and `reports/` resolving
	 * under the developer's real XDG tree — the helper's promise that everything this process writes
	 * is under `home` was simply false there.
	 *
	 * This helper used to clear two of the four bases itself. It now owns none of them: the clearing
	 * and the exact restore live in `enterIsolatedConfigRoot`, so there is one list of the variables
	 * that outrank the config root instead of two partial ones.
	 */
	it("does not let a state base outside the temp home win", () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "veyyon-temp-home-xdg-"));
		// The app subdirectory has to exist or the resolver ignores the base, and the test would then
		// pass on the fallback rather than on the clearing.
		mkdirSync(path.join(outside, "veyyon"), { recursive: true });
		const dirOverrides = captureDirOverrides();
		const previousState = process.env.XDG_STATE_HOME;
		setProfile(undefined);
		process.env.XDG_STATE_HOME = outside;
		refreshDirsFromEnv();
		try {
			active = enterTempHome();

			expect(getLogsDir().startsWith(outside)).toBe(false);
			expect(getLogsDir().startsWith(active.home)).toBe(true);
		} finally {
			restoreDirOverrides(dirOverrides);
			if (previousState === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = previousState;
			rmSync(outside, { recursive: true, force: true });
		}
	});

	/** And the restore puts it back rather than deciding it was wrong: this helper isolates its own
	 *  window, it does not clean up after the developer's environment. */
	it("puts the base back on restore", () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "veyyon-temp-home-xdg-"));
		mkdirSync(path.join(outside, "veyyon"), { recursive: true });
		const dirOverrides = captureDirOverrides();
		const previousState = process.env.XDG_STATE_HOME;
		setProfile(undefined);
		process.env.XDG_STATE_HOME = outside;
		refreshDirsFromEnv();
		try {
			const temp = enterTempHome();
			expect(process.env.XDG_STATE_HOME).toBeUndefined();
			temp.restore();

			expect(process.env.XDG_STATE_HOME).toBe(outside);
		} finally {
			restoreDirOverrides(dirOverrides);
			if (previousState === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = previousState;
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
