/**
 * `captureDirOverrides` / `restoreDirOverrides`: undoing a `setAgentDir` or `setProfile`
 * call completely.
 *
 * Why this suite exists: neither setter is its own inverse, and every test that assumed
 * one was leaked into the files that ran after it.
 *
 * - `setAgentDir(theOldValue)` always WRITES `VEYYON_CODING_AGENT_DIR`, so it cannot
 *   express "the variable was absent", and it CLEARS the active profile, so the process
 *   is left on the default profile with the environment looking untouched.
 * - `setProfile(theOldProfile)` always WRITES `VEYYON_PROFILE` and exports the profile's
 *   agent dir, so restoring a profile through it leaves both variables behind — and every
 *   child process a later suite spawns then inherits a profile the test never chose.
 *
 * `scripts/test-sandbox/find-test-leaks.ts` found roughly thirty suites with one or other defect, two
 * of them exporting the developer's real agent dir (`~/.veyyon/profiles/work/agent`) to
 * every later file in the process.
 *
 * Each half is asserted separately below, because a restore that fixed only the variable
 * would still leave the profile wrong, a restore that fixed only the profile would leave
 * the variables wrong, and a run where the developer happens to have
 * `VEYYON_CODING_AGENT_DIR` already set would hide the absent-variable case entirely.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	__preProfileAgentDirForTests,
	__resetProfileSnapshotForTests,
	captureDirOverrides,
	getActiveProfile,
	getAgentDir,
	restoreDirOverrides,
	setAgentDir,
	setProfile,
} from "@veyyon/utils/dirs";

const TEMP_AGENT_DIR = path.join(os.tmpdir(), "veyyon-agent-dir-override-test", "agent");

/** Whatever the file found, put back, whichever way the test left it. */
const fileEntry = captureDirOverrides();

/**
 * Read a variable through an index rather than a property access. `delete process.env.X`
 * narrows that property's type to `undefined` for the rest of the block, so a later
 * `expect(process.env.X).toBe("…")` is a type error even though it is exactly the
 * assertion these tests need to make.
 */
function env(name: string): string | undefined {
	return process.env[name];
}

afterEach(() => {
	restoreDirOverrides(fileEntry);
});

describe("restoreDirOverrides", () => {
	/**
	 * THE case the leaks were made of: the variable was unset, a suite called
	 * `setAgentDir`, and nothing could put "unset" back.
	 */
	it("removes the variable again when it started out absent", () => {
		delete process.env.VEYYON_CODING_AGENT_DIR;
		const snapshot = captureDirOverrides();

		setAgentDir(TEMP_AGENT_DIR);
		expect(env("VEYYON_CODING_AGENT_DIR")).toBe(TEMP_AGENT_DIR);

		restoreDirOverrides(snapshot);

		expect("VEYYON_CODING_AGENT_DIR" in process.env).toBe(false);
	});

	/**
	 * The other direction: a real override the developer set must come back with its
	 * exact value, not be deleted.
	 *
	 * The override is installed with `setAgentDir` rather than by assigning the variable.
	 * Assigning it does not rebuild the resolver, so a `getAgentDir()` read taken straight
	 * afterwards reports the resolution from BEFORE the assignment — this test used to do
	 * that and then compare the stale value against the restored one, which agreed only
	 * while a named profile happened to mask both. It passed alone, failed in a full run,
	 * and pointed at nothing. `setAgentDir` also clears the active profile, so the variable
	 * is unambiguously what decides the agent dir and the assertion can name an exact path.
	 */
	it("restores an override that was already set", () => {
		const existing = path.join(os.tmpdir(), "veyyon-preexisting-agent-dir");
		setAgentDir(existing);
		const snapshot = captureDirOverrides();
		expect(getAgentDir()).toBe(existing);

		setAgentDir(TEMP_AGENT_DIR);
		expect(getAgentDir()).toBe(TEMP_AGENT_DIR);

		restoreDirOverrides(snapshot);

		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(existing);
		expect(getAgentDir()).toBe(existing);
	});

	/**
	 * The half a variable-only restore misses. `setAgentDir` clears the active
	 * profile, so a suite that ran under `work` handed every later file the DEFAULT
	 * profile while the environment looked untouched — `state.activeProfile: work ->
	 * (default)` is exactly what the leak tracer reported for eight suites.
	 */
	it("re-activates a named profile that setAgentDir cleared", () => {
		setProfile("leak-test-profile");
		const snapshot = captureDirOverrides();
		expect(getActiveProfile()).toBe("leak-test-profile");

		setAgentDir(TEMP_AGENT_DIR);
		expect(getActiveProfile()).toBeUndefined();

		restoreDirOverrides(snapshot);

		expect(getActiveProfile()).toBe("leak-test-profile");
	});

	/** Returning to the default profile is a real state, not "no state": a suite
	 *  that entered a profile itself must not leave it active. */
	it("returns to the default profile when that is what it captured", () => {
		setProfile(undefined);
		const snapshot = captureDirOverrides();

		setProfile("entered-during-the-test");
		restoreDirOverrides(snapshot);

		expect(getActiveProfile()).toBeUndefined();
	});

	/** The resolver, not only the variables: a restore that put the environment back
	 *  and left the resolver pointed at the temp dir would pass every check above. */
	it("rebuilds the resolved agent dir, not just the environment", () => {
		const before = getAgentDir();
		const snapshot = captureDirOverrides();

		setAgentDir(TEMP_AGENT_DIR);
		expect(getAgentDir()).toBe(TEMP_AGENT_DIR);

		restoreDirOverrides(snapshot);

		expect(getAgentDir()).toBe(before);
	});

	/** Restoring twice is not an error and does not drift: an `afterEach` may run
	 *  after a test that already restored. */
	it("is idempotent", () => {
		const snapshot = captureDirOverrides();
		const before = getAgentDir();

		setAgentDir(TEMP_AGENT_DIR);
		restoreDirOverrides(snapshot);
		restoreDirOverrides(snapshot);

		expect(getAgentDir()).toBe(before);
		expect(getActiveProfile()).toBe(snapshot.profile);
	});
});

describe("restoreDirOverrides after setProfile", () => {
	/**
	 * `setProfile` is not its own inverse either, and this is the half a suite that only
	 * thinks about the agent dir misses: `setProfile(theOldProfile)` WRITES
	 * `VEYYON_PROFILE`, so a suite whose developer had no such variable exports one.
	 * That matters beyond this process — every child a later suite spawns inherits it and
	 * runs under a profile the test never chose. `mcp-profile-auth-binding.test.ts`
	 * restored that way and left `VEYYON_PROFILE=work` behind.
	 */
	it("removes VEYYON_PROFILE again when it started out absent", () => {
		delete process.env.VEYYON_PROFILE;
		setProfile(undefined);
		const snapshot = captureDirOverrides();

		setProfile("some-suite-profile");
		expect(env("VEYYON_PROFILE")).toBe("some-suite-profile");

		restoreDirOverrides(snapshot);

		expect("VEYYON_PROFILE" in process.env).toBe(false);
		expect(getActiveProfile()).toBeUndefined();
	});

	/** The other direction: a developer running under `VEYYON_PROFILE` keeps it, value
	 *  and all, after a suite has switched profiles several times. */
	it("restores a VEYYON_PROFILE that was already set", () => {
		process.env.VEYYON_PROFILE = "developers-own";
		setProfile("developers-own");
		const snapshot = captureDirOverrides();

		setProfile("first-switch");
		setProfile("second-switch");
		restoreDirOverrides(snapshot);

		expect(process.env.VEYYON_PROFILE).toBe("developers-own");
		expect(getActiveProfile()).toBe("developers-own");
	});

	/**
	 * Both levers in one test, in the arrangement that catches a restore written in the
	 * obvious order. `setProfile` EXPORTS the profile's agent dir, so re-activating the
	 * captured profile re-creates a variable the snapshot says was absent; a restore that
	 * writes the environment first and switches the profile afterwards leaves that
	 * variable behind. The environment has to be pinned again after the switch.
	 *
	 * The absent variable is arranged AFTER `setProfile` deliberately: capturing before
	 * the profile call would snapshot the exported value instead, and the test would pass
	 * without exercising anything.
	 */
	it("leaves no agent dir variable behind when re-activating the captured profile", () => {
		setProfile("kept");
		delete process.env.VEYYON_CODING_AGENT_DIR;
		const snapshot = captureDirOverrides();
		expect(snapshot.agentDirEnv).toBeUndefined();
		expect(snapshot.profile).toBe("kept");

		setAgentDir(TEMP_AGENT_DIR);
		expect(getActiveProfile()).toBeUndefined();

		restoreDirOverrides(snapshot);

		expect("VEYYON_CODING_AGENT_DIR" in process.env).toBe(false);
		expect(getActiveProfile()).toBe("kept");
	});
});

describe("captureDirOverrides", () => {
	/** The snapshot is a plain value taken at call time, so a later mutation cannot
	 *  reach back into it. */
	it("captures by value", () => {
		delete process.env.VEYYON_CODING_AGENT_DIR;
		const snapshot = captureDirOverrides();

		setAgentDir(TEMP_AGENT_DIR);

		expect(snapshot.agentDirEnv).toBeUndefined();
	});

	/** Both the environment's profile pin and the in-memory profile are captured:
	 *  a profile selected in-process leaves no variable behind, and restoring from
	 *  the environment alone would silently drop it. */
	it("captures the in-memory profile as well as the environment", () => {
		setProfile("in-process-only");
		delete process.env.VEYYON_PROFILE;

		const snapshot = captureDirOverrides();

		expect(snapshot.profileEnv).toBeUndefined();
		expect(snapshot.profile).toBe("in-process-only");
	});
});

describe("restoreDirOverrides and the pre-profile baseline", () => {
	/**
	 * The baseline decides where `setProfile(undefined)` lands, and `setAgentDir`
	 * OVERWRITES it. Nothing in the environment or in the resolved agent dir shows the
	 * change, so a suite that pointed the agent dir at a temp tree used to hand every later
	 * file a baseline inside a directory it had already deleted — and the next file that
	 * returned to the default profile resolved there.
	 */
	it("restores the baseline that setAgentDir overwrote", () => {
		const snapshot = captureDirOverrides();
		const baselineBefore = snapshot.preProfileAgentDir;

		setAgentDir(TEMP_AGENT_DIR);
		expect(__preProfileAgentDirForTests()).toBe(TEMP_AGENT_DIR);

		restoreDirOverrides(snapshot);

		expect(__preProfileAgentDirForTests()).toBe(baselineBefore);
	});

	/**
	 * The case the environment cannot express, which is why the baseline is captured by
	 * value instead of re-derived. With an explicit override set and a profile then
	 * activated, the environment points at the PROFILE's dir; re-deriving the baseline from
	 * it discards the override, so returning to the default profile afterwards would land
	 * on `~/.veyyon/agent` rather than the operator's `/custom` directory.
	 */
	it("keeps an explicit override as the baseline across a profile activation", () => {
		const custom = path.join(os.tmpdir(), "veyyon-explicit-baseline");
		// The default profile FIRST, then the override. `setProfile(undefined)` rewrites
		// `VEYYON_CODING_AGENT_DIR` from the current baseline (deleting it when the baseline
		// is absent), so setting the variable before that call would have it wiped and the
		// test would arrange nothing.
		setProfile(undefined);
		process.env.VEYYON_CODING_AGENT_DIR = custom;
		__resetProfileSnapshotForTests();
		const snapshot = captureDirOverrides();
		expect(snapshot.preProfileAgentDir).toBe(custom);

		setProfile("baseline-test-profile");
		restoreDirOverrides(snapshot);

		expect(__preProfileAgentDirForTests()).toBe(custom);
		// And the baseline is live, not just recorded: returning to the default profile
		// resolves under the operator's directory.
		setProfile(undefined);
		expect(getAgentDir()).toBe(custom);
	});

	/** A baseline that was absent comes back absent, so the snapshot cannot silently
	 *  invent an override for a process that never had one. */
	it("restores an absent baseline as absent", () => {
		setProfile(undefined);
		delete process.env.VEYYON_CODING_AGENT_DIR;
		__resetProfileSnapshotForTests();
		const snapshot = captureDirOverrides();
		expect(snapshot.preProfileAgentDir).toBeUndefined();

		setAgentDir(TEMP_AGENT_DIR);
		restoreDirOverrides(snapshot);

		expect(__preProfileAgentDirForTests()).toBeUndefined();
	});
});
