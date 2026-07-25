/**
 * SPEC-MEMORY #5 (BACKLOG.md): per-profile isolation is structural (profile ->
 * agentDir -> memories dir), not a new build, but it was previously untested
 * as a contract. This proves two profiles get disjoint `mnemopi.dbPath`
 * values and that a memory saved under one profile is never recalled under
 * another.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadMnemopiConfig } from "@veyyon/coding-agent/mnemopi/config";
import { Mnemopi } from "@veyyon/mnemopi";
import { __resetProfileSnapshotForTests, getActiveProfile, getAgentDir, setProfile } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

function dbPathForProfile(profile: string): string {
	setProfile(profile);
	const settings = Settings.isolated({ "mnemopi.scoping": "global" });
	return loadMnemopiConfig(settings, getAgentDir()).dbPath;
}

describe("mnemopi per-profile isolation (SPEC-MEMORY #5)", () => {
	let isolated: IsolatedConfigRoot | undefined;
	let originalProfile: string | undefined;

	beforeEach(() => {
		originalProfile = getActiveProfile();
		// A temp root, not a fresh dot-directory NAME under the home. The name form is
		// what left 130 abandoned `~/.veyyon-mnemopi-profile-iso-*` directories in a real
		// home directory: it isolates from other suites and not from the developer.
		isolated = enterIsolatedConfigRoot("mnemopi-profile-iso");
		setProfile(undefined);
	});

	afterEach(() => {
		setProfile(undefined);
		if (originalProfile) setProfile(originalProfile);
		__resetProfileSnapshotForTests();
		isolated?.restore();
		isolated = undefined;
	});

	it("resolves distinct absolute dbPath under profiles/alpha vs profiles/beta", () => {
		const alphaPath = dbPathForProfile("alpha");
		const betaPath = dbPathForProfile("beta");

		expect(alphaPath).not.toBe(betaPath);
		expect(path.isAbsolute(alphaPath)).toBe(true);
		expect(path.isAbsolute(betaPath)).toBe(true);
		expect(alphaPath).toContain(path.join("profiles", "alpha", "agent"));
		expect(betaPath).toContain(path.join("profiles", "beta", "agent"));
	});

	it("does not resolve either named profile under the default (profile-less) agent dir", () => {
		const defaultAgentDir = getAgentDir();
		const alphaPath = dbPathForProfile("alpha");

		expect(alphaPath.startsWith(defaultAgentDir)).toBe(false);
	});

	it("a memory saved under profile alpha is not recalled under profile beta", async () => {
		const alphaPath = dbPathForProfile("alpha");
		await fs.mkdir(path.dirname(alphaPath), { recursive: true });
		const alphaMemory = new Mnemopi({ dbPath: alphaPath, bank: "default", noEmbeddings: true });
		try {
			alphaMemory.remember("The deployment target is stable-cluster.", { source: "profile-isolation-test" });
		} finally {
			alphaMemory.close();
		}

		const betaPath = dbPathForProfile("beta");
		await fs.mkdir(path.dirname(betaPath), { recursive: true });
		const betaMemory = new Mnemopi({ dbPath: betaPath, bank: "default", noEmbeddings: true });
		try {
			const betaResults = await betaMemory.recall("deployment target stable-cluster", 5);
			expect(betaResults).toHaveLength(0);
		} finally {
			betaMemory.close();
		}

		// Sanity: the same fact IS recallable from within its own profile, proving
		// the empty beta result above is isolation, not a broken recall path.
		const alphaReopened = new Mnemopi({ dbPath: alphaPath, bank: "default", noEmbeddings: true });
		try {
			const alphaResults = await alphaReopened.recall("deployment target stable-cluster", 5);
			expect(alphaResults.length).toBeGreaterThan(0);
		} finally {
			alphaReopened.close();
		}
	});
});
