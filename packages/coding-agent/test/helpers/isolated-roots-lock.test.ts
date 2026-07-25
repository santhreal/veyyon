import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getWorktreesDir, setWorktreesDir } from "@veyyon/utils";
import { useIsolatedAgentDir, useIsolatedConfigRoot, useIsolatedWorktreesDir } from "./isolated-agent-dir";

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
	// Set the variable the helper has to defeat BEFORE it runs, which is exactly
	// the state any earlier suite that called `setAgentDir` leaves behind. Nothing
	// restores it here because the helper's own `beginSettingsTest` snapshot
	// captured the environment before this line and puts it all back.
	const leakedAgentDir = path.join(os.tmpdir(), "leaked-agent-dir-from-an-earlier-suite");
	process.env.VEYYON_CODING_AGENT_DIR = leakedAgentDir;

	const configRootPath = useIsolatedConfigRoot();

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
