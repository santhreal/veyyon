/**
 * `restoreDirOverrides` hands back exactly the state its snapshot describes, and nothing it
 * reads from live module state.
 *
 * WHY THIS SUITE EXISTS. The restore is the recovery point roughly thirty suites use to undo a
 * `setAgentDir` / `setProfile` call, so a restore that hands back a state the snapshot never
 * described does not fail where the mistake is: it fails in whichever suite runs next, under a
 * config root or a profile nobody chose. Its sibling `dir-overrides-restore.test.ts` covers the two
 * variables and the active profile. This suite covers the two pieces of state that are NOT variables
 * and were both being read live rather than from the snapshot.
 *
 * The two are `preProfileAgentDirEnv` (the pre-profile agent-dir baseline that `setProfile(undefined)`
 * builds the resolver FROM, which `setAgentDir` overwrites with the undone test's own directory) and
 * `dirs` itself (the resolver, which several steps of the restore rebuild and one does not). Both
 * currently come out right, and neither is obviously right from reading the code: the baseline is
 * rescued by a `__resetProfileSnapshotForTests` call nested two functions deep, and the resolver is
 * left correct by whichever branch happened to run last. Get either wrong and the restore hands back
 * a resolver pointed at the previous test's temp directory while `VEYYON_CODING_AGENT_DIR`,
 * `VEYYON_PROFILE` and the active profile all read back correct — so nothing in the visible state
 * says which of the four inputs is the wrong one, and the failure lands in a later suite.
 *
 * Which branch runs is the reason this needs a suite of its own. `setProfile(snapshot.profile)` is
 * only reached when the reset finds a profile the snapshot did not have, and the reset takes that
 * profile from the machine's global `defaultProfile`. A developer with one set and a developer
 * without one exercise DIFFERENT halves of this function, which is how a defect here becomes a test
 * that passes alone, fails in a full run, and blames a different file. So every test below pins the
 * global `defaultProfile` inside an isolated config root rather than inheriting whatever the machine
 * has, and both settings of it are covered.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	__preProfileAgentDirForTests,
	captureDirOverrides,
	getActiveProfile,
	getAgentDir,
	restoreDirOverrides,
	setAgentDir,
	setProfile,
	writeGlobalDefaultProfile,
} from "@veyyon/utils/dirs";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "./helpers/isolated-config-root";

/** Whatever the file found, put back, whichever way a test left it. */
const fileEntry = captureDirOverrides();

const OVERRIDE_DIR = path.join(os.tmpdir(), "veyyon-restore-purity", "developers-own-agent");
const SUITE_DIR = path.join(os.tmpdir(), "veyyon-restore-purity", "a-suites-agent");

let isolated: IsolatedConfigRoot | undefined;

beforeEach(() => {
	isolated = enterIsolatedConfigRoot("restore-purity", { defaultProfile: true });
});

afterEach(() => {
	isolated?.restore();
	isolated = undefined;
	restoreDirOverrides(fileEntry);
});

describe("restoreDirOverrides with a global defaultProfile set", () => {
	/**
	 * The shape that costs the most when it breaks.
	 *
	 * The snapshot says "no profile, and the agent dir is the developer's override". The reset
	 * inside the restore then reads the global `defaultProfile` and activates it, so the restore
	 * has to switch back to no profile — and THAT switch is what rebuilds the resolver from the
	 * baseline. If the baseline still held the suite's temp directory at that moment, every path
	 * would come back under the suite's directory instead of the developer's.
	 */
	it("resolves the agent dir from the snapshot, not from the baseline the undone test overwrote", () => {
		writeGlobalDefaultProfile("machine-default");
		setAgentDir(OVERRIDE_DIR);
		const snapshot = captureDirOverrides();
		expect(getAgentDir()).toBe(OVERRIDE_DIR);
		expect(getActiveProfile()).toBeUndefined();

		// What a suite does, and what leaves the baseline pointing at its own directory.
		setAgentDir(SUITE_DIR);
		expect(__preProfileAgentDirForTests()).toBe(SUITE_DIR);

		restoreDirOverrides(snapshot);

		expect(getAgentDir()).toBe(OVERRIDE_DIR);
		expect(process.env.VEYYON_CODING_AGENT_DIR).toBe(OVERRIDE_DIR);
		expect(getActiveProfile()).toBeUndefined();
	});

	/**
	 * The baseline itself, asserted separately from the resolver it feeds.
	 *
	 * A restore that fixed the resolved path but left the baseline wrong would pass the test above
	 * and then fail the NEXT time anything in the process calls `setProfile(undefined)`, which is a
	 * different suite again.
	 */
	it("puts the pre-profile baseline back, so a later setProfile(undefined) still resolves right", () => {
		writeGlobalDefaultProfile("machine-default");
		setAgentDir(OVERRIDE_DIR);
		const snapshot = captureDirOverrides();

		setAgentDir(SUITE_DIR);
		restoreDirOverrides(snapshot);

		expect(__preProfileAgentDirForTests()).toBe(OVERRIDE_DIR);

		// The delayed half of the failure: this is the call that consumes the baseline.
		setProfile("somewhere-else");
		setProfile(undefined);

		expect(getAgentDir()).toBe(OVERRIDE_DIR);
	});

	/**
	 * The same restore, from a snapshot that DOES name a profile. Here the profile outranks the
	 * variable, so the assertion is the profile's own agent dir. Stated separately because a restore
	 * that always honoured the variable would pass every other test in this file.
	 */
	it("keeps a snapshotted profile's agent dir winning over the variable", () => {
		writeGlobalDefaultProfile("machine-default");
		setProfile("the-developers-profile");
		const snapshot = captureDirOverrides();
		// Read from the resolver while the profile is active rather than rebuilt by hand, so the
		// assertion cannot encode a stale idea of where a profile's agent dir lives.
		const profileAgentDir = getAgentDir();
		expect(profileAgentDir).toContain(path.join("profiles", "the-developers-profile"));

		setAgentDir(SUITE_DIR);
		expect(getActiveProfile()).toBeUndefined();

		restoreDirOverrides(snapshot);

		expect(getActiveProfile()).toBe("the-developers-profile");
		expect(getAgentDir()).toBe(profileAgentDir);
	});

	/**
	 * The absent-variable case under the same branch. A restore that rebuilds from a stale baseline
	 * fails this by resolving under the suite's directory while `VEYYON_CODING_AGENT_DIR` is
	 * correctly absent, which is the combination that makes the state unreadable.
	 */
	it("resolves the default agent dir when the snapshot had no override at all", () => {
		writeGlobalDefaultProfile("machine-default");
		setProfile(undefined);
		const withNoOverride = getAgentDir();
		const snapshot = captureDirOverrides();
		expect(snapshot.agentDirEnv).toBeUndefined();

		setAgentDir(SUITE_DIR);
		restoreDirOverrides(snapshot);

		expect("VEYYON_CODING_AGENT_DIR" in process.env).toBe(false);
		expect(getAgentDir()).toBe(withNoOverride);
		expect(__preProfileAgentDirForTests()).toBeUndefined();
	});

	/**
	 * Restoring twice must land in the same place. An `afterEach` commonly runs after a test that
	 * already restored, and a restore whose result depends on the state it starts from would drift
	 * on the second call rather than being a no-op.
	 */
	it("is idempotent through the profile-switch branch", () => {
		writeGlobalDefaultProfile("machine-default");
		setAgentDir(OVERRIDE_DIR);
		const snapshot = captureDirOverrides();

		setAgentDir(SUITE_DIR);
		restoreDirOverrides(snapshot);
		restoreDirOverrides(snapshot);
		restoreDirOverrides(snapshot);

		expect(getAgentDir()).toBe(OVERRIDE_DIR);
		expect(__preProfileAgentDirForTests()).toBe(OVERRIDE_DIR);
		expect(getActiveProfile()).toBeUndefined();
	});
});

describe("restoreDirOverrides with no global defaultProfile", () => {
	/**
	 * The other side of the premise. With no global default the reset finds no profile, so the
	 * `setProfile` branch is skipped entirely and the restore's correctness rests on a different
	 * path. Stated as its own test because the bug above was ONLY reachable through the branch, and
	 * a suite that pinned the branch alone would let the simple path rot.
	 */
	it("restores the override without going through a profile switch", () => {
		writeGlobalDefaultProfile(undefined);
		setAgentDir(OVERRIDE_DIR);
		const snapshot = captureDirOverrides();

		setAgentDir(SUITE_DIR);
		restoreDirOverrides(snapshot);

		expect(getAgentDir()).toBe(OVERRIDE_DIR);
		expect(__preProfileAgentDirForTests()).toBe(OVERRIDE_DIR);
	});

	/**
	 * The premise itself, so the suite above cannot pass vacuously. If `writeGlobalDefaultProfile`
	 * ever stopped reaching the file the reset reads, every test in the first describe would still
	 * pass while testing the branch it was written to cover.
	 */
	it("takes the profile from the global config, which is what makes the branch above reachable", () => {
		writeGlobalDefaultProfile("machine-default");
		setAgentDir(OVERRIDE_DIR);
		const snapshot = captureDirOverrides();

		// The reset the restore performs internally, run here so its effect is observable.
		setAgentDir(SUITE_DIR);
		delete process.env.VEYYON_PROFILE;
		restoreDirOverrides({ ...snapshot, profile: "machine-default", profileEnv: undefined });

		expect(getActiveProfile()).toBe("machine-default");
	});
});
