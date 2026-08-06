import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getAgentDir, getWorktreesDir, setWorktreesDir } from "@veyyon/utils";
import { __sweepStaleRootsForTests, enterIsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { useIsolatedAgentDir, useIsolatedConfigRoot, useIsolatedWorktreesDir } from "./isolated-agent-dir";
import {
	claimFileLevelIsolation,
	fileLevelIsolationOwnerForTests,
	releaseFileLevelIsolation,
} from "./settings-test-state";

/**
 * Proving lock for the three root-isolation helpers.
 *
 * WHY THIS EXISTS (SWEEP4-BARE-RUN-ORDER-POLLUTION). A one-line helper that
 * silently fails to redirect is worse than no helper: every suite that adopts it
 * reads as isolated, and the tests keep writing to the developer's real
 * `~/.veyyon` until the tripwire happens to catch one. So the helpers assert what
 * they claim rather than being trusted, and they assert it against the REAL
 * resolvers (`getAgentDir`, `getWorktreesDir`) rather than against the values
 * they were handed.
 *
 * The restore half of `useIsolatedAgentDir` is not re-proved here: it delegates
 * entirely to `beginSettingsTest`/`restoreSettingsTestState`, whose restore is
 * already locked by `agent-dir-order-lock.test.ts`. What IS proved here is the
 * worktrees restore, because that one is the helper's own code.
 *
 * A textual lock ("no bare `setAgentDir(` in test files") was considered and
 * REJECTED: of the ~40 files that call it, a regex flags 32 and every one of the
 * five it cannot clear does in fact restore, just in a shape (a `finally`, a
 * local restore function, a conditional on the original value) that no pattern
 * reads correctly. A lock with that false-positive rate gets suppressed rather
 * than obeyed. The real-data tripwire is the enforcement for the dangerous half,
 * and these assertions are the enforcement for the helpers themselves.
 */

describe("useIsolatedAgentDir", () => {
	useIsolatedAgentDir();

	/** The whole point: the resolver the production code calls returns the temp
	 * dir, not a path under the developer's home. Checked through `getAgentDir`
	 * because that is what `AgentStorage` calls. */
	it("points the real resolver away from the developer's home", () => {
		const agentDir = getAgentDir();

		expect(agentDir.startsWith(os.tmpdir())).toBe(true);
		expect(agentDir.includes(path.join(os.homedir(), ".veyyon"))).toBe(false);
	});
});

describe("useIsolatedConfigRoot", () => {
	// Set the variable the helper has to defeat BEFORE it runs, which is exactly the
	// state any earlier suite that called `setAgentDir` leaves behind.
	//
	// It is snapshotted and restored here rather than left to the helper's own
	// `beginSettingsTest`: this describe body runs BEFORE the helper's `beforeAll`, so
	// that snapshot captures the FAKE value and faithfully puts it back — this file
	// was itself leaking `/tmp/leaked-agent-dir-from-an-earlier-suite` into every
	// suite after it, which `scripts/test-sandbox/find-test-leaks.ts` caught.
	const agentDirBefore = process.env.VEYYON_CODING_AGENT_DIR;
	const leakedAgentDir = path.join(os.tmpdir(), "leaked-agent-dir-from-an-earlier-suite");
	process.env.VEYYON_CODING_AGENT_DIR = leakedAgentDir;

	const configRootPath = useIsolatedConfigRoot();

	// Registered AFTER the helper on purpose, and verified that way round: inside a
	// `describe`, the hook registered later runs later, so this one gets the final
	// word over the helper's own restore — which faithfully puts the FAKE value back,
	// because its snapshot was taken after the assignment above.
	afterAll(() => {
		if (agentDirBefore === undefined) delete process.env.VEYYON_CODING_AGENT_DIR;
		else process.env.VEYYON_CODING_AGENT_DIR = agentDirBefore;
	});

	/** The claim: the resolver production code calls lands inside the temp config
	 * root, not in the developer's home. */
	it("points the real resolver at the temp config root", () => {
		expect(configRootPath()).not.toBe("");
		expect(getAgentDir().startsWith(configRootPath())).toBe(true);
		expect(getAgentDir().includes(path.join(os.homedir(), ".veyyon"))).toBe(false);
	});

	/**
	 * THE regression this helper exists for. `VEYYON_CODING_AGENT_DIR` outranks the
	 * config root in `DirResolver`, so a suite that set only `VEYYON_CONFIG_DIR`
	 * kept resolving to whatever directory an earlier suite had pinned. That is a
	 * pass-alone, fail-in-a-full-run bug whose culprit is a different file, and it
	 * failed on the very assertion meant to prove the isolation.
	 *
	 * The leaked value is set above, so this is a real reproduction rather than a
	 * restatement of the test before it.
	 */
	it("clears a leaked VEYYON_CODING_AGENT_DIR that would otherwise outrank the config root", () => {
		expect(process.env.VEYYON_CODING_AGENT_DIR).not.toBe(leakedAgentDir);
		expect(getAgentDir().startsWith(leakedAgentDir)).toBe(false);
	});

	/** A leaked `VEYYON_PROFILE` is the other way the resolver is diverted: an
	 * active profile makes `resolveActiveAgentDirOverride` return undefined and
	 * moves the whole tree under `profiles/<name>`. Cleared for the same reason. */
	it("clears a leaked VEYYON_PROFILE", () => {
		expect(process.env.VEYYON_PROFILE).toBeUndefined();
	});
});

describe("enterIsolatedConfigRoot", () => {
	/**
	 * The imperative form of the config-root isolation, and the one the hook above now
	 * delegates to, so the claims are proved against the real resolver here as well: a lock
	 * that only covered the hook would leave the shared implementation unproved for every
	 * suite that calls it directly, which is most of them.
	 *
	 * These run OUTSIDE any file-level hook. Each test enters and restores its own root, so
	 * the restore is proved by the next test being able to enter cleanly.
	 */
	it("points the real resolver into a temp root, away from the developer's home", () => {
		const isolated = enterIsolatedConfigRoot("lock-basic");
		try {
			expect(isolated.root.startsWith(os.tmpdir())).toBe(true);
			expect(getAgentDir().startsWith(isolated.root)).toBe(true);
			expect(getAgentDir().includes(path.join(os.homedir(), ".veyyon"))).toBe(false);
		} finally {
			isolated.restore();
		}
	});

	/** THE trap, same as for the hook: `VEYYON_CODING_AGENT_DIR` outranks the config root,
	 * so a helper that only set `VEYYON_CONFIG_DIR` would resolve to whatever directory an
	 * earlier suite pinned and the isolation would be a no-op nobody notices. */
	it("clears a leaked VEYYON_CODING_AGENT_DIR that would otherwise outrank it", () => {
		const leaked = path.join(os.tmpdir(), "leaked-agent-dir-for-imperative-helper");
		const savedProfile = process.env.VEYYON_PROFILE;
		const savedAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
		// No profile active, which is the condition under which the override wins at all.
		delete process.env.VEYYON_PROFILE;
		process.env.VEYYON_CODING_AGENT_DIR = leaked;
		const isolated = enterIsolatedConfigRoot("lock-leaked-agent-dir");
		try {
			expect(getAgentDir().startsWith(leaked)).toBe(false);
			expect(getAgentDir().startsWith(isolated.root)).toBe(true);
		} finally {
			isolated.restore();
			if (savedProfile === undefined) delete process.env.VEYYON_PROFILE;
			else process.env.VEYYON_PROFILE = savedProfile;
			if (savedAgentDir === undefined) delete process.env.VEYYON_CODING_AGENT_DIR;
			else process.env.VEYYON_CODING_AGENT_DIR = savedAgentDir;
		}
	});

	/**
	 * `VEYYON_PROFILE` is left ALONE unless asked, because an active profile does not defeat
	 * the config root — it only chooses which subdirectory of it is used — and several suites
	 * set a profile deliberately and assert the profile path. Both directions are pinned so
	 * neither behavior can be "tidied" into the other.
	 *
	 * Asserted on the variable and on the root, not on the profile SEGMENT of the resolved
	 * path: the active profile is also held in an in-memory snapshot that `setProfile` owns,
	 * so assigning the variable here would not move it and an assertion about the segment
	 * would be testing the snapshot rather than this helper.
	 */
	it("leaves an active profile alone by default and clears it on request", () => {
		const savedProfile = process.env.VEYYON_PROFILE;
		process.env.VEYYON_PROFILE = "lock-profile";
		const kept = enterIsolatedConfigRoot("lock-keeps-profile");
		try {
			expect(process.env.VEYYON_PROFILE).toBe("lock-profile");
			expect(getAgentDir().startsWith(kept.root)).toBe(true);
		} finally {
			kept.restore();
		}

		process.env.VEYYON_PROFILE = "lock-profile";
		const cleared = enterIsolatedConfigRoot("lock-clears-profile", { defaultProfile: true });
		try {
			expect(process.env.VEYYON_PROFILE).toBeUndefined();
			expect(getAgentDir().startsWith(cleared.root)).toBe(true);
		} finally {
			cleared.restore();
			if (savedProfile === undefined) delete process.env.VEYYON_PROFILE;
			else process.env.VEYYON_PROFILE = savedProfile;
			// Putting the variable back is only half a restore: the active profile also
			// lives in module state, so without this the process would carry the
			// default-profile resolver while the environment named a profile. The next
			// test in this file compares the resolver before and after a restore and
			// would read that disagreement as the helper's fault.
			__resetDirsFromEnvForTests();
		}
	});

	/** Restore has to put back what it found, unset included: a helper that leaves a
	 * config-dir override behind hands the next suite a root nobody chose. */
	it("restores every variable it changed, and removes the temp tree", () => {
		const before = {
			configDir: process.env.VEYYON_CONFIG_DIR,
			agentDir: process.env.VEYYON_CODING_AGENT_DIR,
			profile: process.env.VEYYON_PROFILE,
			resolved: getAgentDir(),
		};

		const isolated = enterIsolatedConfigRoot("lock-restore");
		expect(existsSync(isolated.root)).toBe(true);
		isolated.restore();

		expect(process.env.VEYYON_CONFIG_DIR).toBe<string | undefined>(before.configDir);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe<string | undefined>(before.agentDir);
		expect(process.env.VEYYON_PROFILE).toBe<string | undefined>(before.profile);
		expect(getAgentDir()).toBe(before.resolved);
		expect(existsSync(isolated.root)).toBe(false);
	});

	/**
	 * Roots abandoned by DEAD test processes are swept; a live process's root is not.
	 *
	 * Some callers cannot run `restore()` — the mnemopi shared setup enters at import
	 * time because that is the only moment preceding every suite in the process, and
	 * there is no hook that runs after the last one (`process.once("exit")` does not
	 * run under `bun test` at all, so an exit handler is dead code that looks like
	 * cleanup). Without a sweep that leaves one directory behind per run, which is
	 * how 133 of them accumulated in a real home. The sweep is the reliable half, and
	 * it has real delete power, so both halves are pinned: it must remove a dead
	 * process's root and it must NOT touch a live one.
	 */
	it("sweeps a dead process's abandoned root and spares a live one", () => {
		const dead = path.join(os.tmpdir(), "veyyon-config-root-lock-sweep-2147483646-1");
		// A real, live, ANOTHER process — not this one, which the sweep skips by a
		// separate early check. A child kept alive for the duration is the only way to
		// prove the liveness probe is what spares it.
		const held = Bun.spawn(["sleep", "30"]);
		const live = path.join(os.tmpdir(), `veyyon-config-root-lock-sweep-${held.pid}-9999`);
		// And one owned by init, which answers EPERM rather than success: a probe that
		// only treated success as "alive" would delete another user's directory.
		const foreign = path.join(os.tmpdir(), "veyyon-config-root-lock-sweep-1-9998");
		mkdirSync(dead, { recursive: true });
		mkdirSync(live, { recursive: true });
		mkdirSync(foreign, { recursive: true });

		try {
			__sweepStaleRootsForTests();

			expect(existsSync(dead)).toBe(false);
			expect(existsSync(live)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			held.kill();
			rmSync(live, { recursive: true, force: true });
			rmSync(dead, { recursive: true, force: true });
			rmSync(foreign, { recursive: true, force: true });
		}
	});

	/** Two roots entered in the same millisecond must not collide, or one suite deletes the
	 * other's tree on restore. */
	it("gives every call a distinct root", () => {
		const first = enterIsolatedConfigRoot("lock-unique");
		const second = enterIsolatedConfigRoot("lock-unique");
		try {
			expect(second.root).not.toBe(first.root);
		} finally {
			second.restore();
			first.restore();
		}
	});
});

describe("useIsolatedWorktreesDir", () => {
	useIsolatedWorktreesDir();

	/** Worktrees resolve through their own chain (env, then override, then the
	 * profile's `wt/` under the CONFIG root), so this is a separate claim from the
	 * agent dir above and needs its own assertion. */
	it("points the real resolver away from the developer's home", () => {
		const worktreesDir = getWorktreesDir();

		expect(worktreesDir.startsWith(os.tmpdir())).toBe(true);
		expect(worktreesDir.includes(path.join(os.homedir(), ".veyyon"))).toBe(false);
	});

	/**
	 * The env var beats the override in `getWorktreesDir`, so setting only the
	 * override would leave a developer who exports `VEYYON_WORKTREE_DIR` with no
	 * isolation at all, and the helper would appear to work everywhere except on
	 * the machine that had the variable set. Both levers are set, and this pins
	 * that the env one is among them.
	 */
	it("sets the env var too, so a developer's own VEYYON_WORKTREE_DIR cannot win", () => {
		expect(process.env.VEYYON_WORKTREE_DIR).toBe(getWorktreesDir());
	});

	/**
	 * The restore round trip, run inside the isolated window so a mistake cannot
	 * escape this file. `setWorktreesDir` has no getter for the override alone,
	 * which is why the helper snapshots the RESOLVED path; this proves that
	 * snapshot-and-put-back actually returns the same value.
	 */
	it("restoring a snapshotted resolved path yields that same path", () => {
		const before = getWorktreesDir();
		const scratch = path.join(os.tmpdir(), "worktrees-lock-scratch");

		// The env var is dropped for the round trip because it OUTRANKS the
		// override: with it set, `setWorktreesDir` cannot move the resolved value at
		// all, and the round trip would pass without proving anything. That
		// precedence is the previous test's subject; here it has to be out of the
		// way for the override to be observable.
		const envDuringIsolation = process.env.VEYYON_WORKTREE_DIR;
		delete process.env.VEYYON_WORKTREE_DIR;
		try {
			setWorktreesDir(scratch);
			expect(getWorktreesDir()).toBe(scratch);

			setWorktreesDir(before);
			expect(getWorktreesDir()).toBe(before);
		} finally {
			if (envDuringIsolation === undefined) delete process.env.VEYYON_WORKTREE_DIR;
			else process.env.VEYYON_WORKTREE_DIR = envDuringIsolation;
		}
	});
});

/**
 * The stacking guard, which is the fix for a leak the helpers themselves caused.
 *
 * WHY THIS EXISTS. Bun runs `afterAll` callbacks in REGISTRATION order, not in
 * reverse. Two file-level isolation helpers therefore restore outermost-first, and
 * the inner one's snapshot — taken after the outer one had already redirected the
 * agent dir — reinstates that temp redirection as the very last thing the file does.
 * `tools/non-interactive-approval-fails-closed.test.ts` stacked
 * `useIsolatedAgentDir()` and `useIsolatedGlobalSettings()` and left
 * `VEYYON_CODING_AGENT_DIR` pointing at its own removed temp dir for every later file
 * in the process, which `scripts/test-sandbox/find-test-leaks.ts` reported as
 * `left behind env.VEYYON_CODING_AGENT_DIR: (unset) -> /tmp/veyyon-isolated-agent-dir-…`.
 * Ordering cannot fix it, so the combination fails loudly and the legitimate case is
 * an option on one helper.
 */
describe("claimFileLevelIsolation", () => {
	/** The slot is free between files, which is what lets a whole tree run in one
	 *  process: a claim that was never released would break every later file. */
	it("is unclaimed once a suite's afterAll has released it", () => {
		expect(fileLevelIsolationOwnerForTests()).toBeUndefined();
	});

	/** The refusal itself. A second file-level claim throws rather than quietly
	 *  producing the restore-order leak described above. */
	it("refuses a second claim while one is held", () => {
		claimFileLevelIsolation("useIsolatedAgentDir()");
		try {
			expect(() => claimFileLevelIsolation("useIsolatedGlobalSettings()")).toThrow(
				/cannot be stacked on useIsolatedAgentDir\(\)/,
			);
		} finally {
			releaseFileLevelIsolation();
		}
	});

	/** The error names the way out, not just the problem: a developer who hits this
	 *  needs to be told about the option rather than left to invent an ordering hack. */
	it("names the option that replaces stacking", () => {
		claimFileLevelIsolation("useIsolatedConfigRoot()");
		try {
			expect(() => claimFileLevelIsolation("useIsolatedAgentDir()")).toThrow(
				/useIsolatedAgentDir\(\{ globalSettings: true \}\)/,
			);
		} finally {
			releaseFileLevelIsolation();
		}
	});

	/** Release makes the slot reusable, so sequential describes (as in this very file)
	 *  and sequential files each get their own claim. */
	it("allows a fresh claim after release", () => {
		claimFileLevelIsolation("first()");
		releaseFileLevelIsolation();
		expect(() => claimFileLevelIsolation("second()")).not.toThrow();
		releaseFileLevelIsolation();
		expect(fileLevelIsolationOwnerForTests()).toBeUndefined();
	});

	/** Releasing an unclaimed slot is a no-op rather than an error: an `afterAll` runs
	 *  even when its `beforeAll` threw before claiming. */
	it("tolerates a release with nothing claimed", () => {
		expect(() => releaseFileLevelIsolation()).not.toThrow();
		expect(fileLevelIsolationOwnerForTests()).toBeUndefined();
	});
});
