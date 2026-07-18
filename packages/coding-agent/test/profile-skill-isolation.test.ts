/**
 * Per-profile skill isolation contract.
 *
 * A profile is a whole separate config root (`~/.veyyon/profiles/<name>/agent`).
 * Every skill source veyyon OWNS resolves under `getAgentDir()`, which is
 * profile-scoped, so activating a profile physically re-homes:
 *   - native user skills       (`<agentDir>/skills`)
 *   - managed/auto-learn skills (`<agentDir>/managed-skills`)
 *   - veyyon-plugins user roots    (`<agentDir>` extension roots)
 *
 * Two profiles therefore never share a skill directory. Project skills
 * (`.veyyon/skills` next to the code) stay shared across profiles by design, and
 * OTHER tools' skill dirs (`~/.claude/skills`, ...) are global to the machine —
 * they load by default as the shared base layer, and their per-profile
 * isolation is the per-profile `discovery.importForeignConfig` toggle
 * (default on), not a relocation of another tool's directory.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getManagedSkillsDir } from "@veyyon/coding-agent/autolearn/managed-skills";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	MAIN_CONFIG_FILENAMES,
	refreshDirsFromEnv,
	setProfile,
} from "@veyyon/utils";

function nativeUserSkillsDir(): string {
	// Mirrors discovery/builtin.ts loadSkills user scan: `<agentDir>/skills`.
	return `${getAgentDir()}/skills`;
}

// A VEYYON_CODING_AGENT_DIR override leaked by a sibling test file makes default
// mode resolve to the override verbatim instead of profiles/default. Pin the
// baseline (no override) for this file, then restore whatever was there.
let leakedAgentDirOverride: string | undefined;

beforeAll(() => {
	leakedAgentDirOverride = process.env.VEYYON_CODING_AGENT_DIR;
	delete process.env.VEYYON_CODING_AGENT_DIR;
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
});

afterAll(() => {
	if (leakedAgentDirOverride !== undefined) {
		process.env.VEYYON_CODING_AGENT_DIR = leakedAgentDirOverride;
	}
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
});

afterEach(() => {
	// Never leak an activated profile into sibling test files in this process.
	setProfile(undefined);
});

describe("per-profile skill isolation", () => {
	test("native user skills re-home under the active profile's agent dir", () => {
		setProfile("alpha");
		const alpha = nativeUserSkillsDir();
		setProfile("beta");
		const beta = nativeUserSkillsDir();
		setProfile(undefined);
		const base = nativeUserSkillsDir();

		expect(alpha).not.toBe(beta);
		expect(alpha).not.toBe(base);
		expect(beta).not.toBe(base);
		expect(alpha).toContain(`profiles/alpha/`);
		expect(beta).toContain(`profiles/beta/`);
		expect(base).toContain("profiles/default/");
	});

	test("managed (auto-learn) skills re-home per profile too", () => {
		setProfile("alpha");
		const alpha = getManagedSkillsDir();
		setProfile("beta");
		const beta = getManagedSkillsDir();

		expect(alpha).not.toBe(beta);
		expect(alpha).toContain(`profiles/alpha/`);
		expect(beta).toContain(`profiles/beta/`);
		expect(alpha.endsWith("managed-skills")).toBe(true);
	});

	test("switching back to the default profile re-homes under profiles/default", () => {
		setProfile("alpha");
		expect(getActiveProfile()).toBe("alpha");
		setProfile(undefined);
		expect(getActiveProfile()).toBeUndefined();
		// The implicit default profile is a real profile dir, not the bare root.
		expect(getAgentDir()).toContain("profiles/default/");
		expect(getAgentDir()).not.toContain("profiles/alpha/");
	});

	// User-level AGENTS.md, mcp.json, and the settings file all resolve as
	// `<agentDir>/<file>` (discovery/builtin.ts loadContextFiles + loadMCPServers,
	// config/settings.ts MAIN_CONFIG_FILENAMES[0]), so profile identity is
	// complete: two profiles never share instructions, MCP wiring, or settings.
	test("user AGENTS.md, mcp.json, and settings re-home under the active profile's agent dir", () => {
		const identityPaths = () => ({
			agentsMd: `${getAgentDir()}/AGENTS.md`,
			mcpJson: `${getAgentDir()}/mcp.json`,
			settings: `${getAgentDir()}/${MAIN_CONFIG_FILENAMES[0]}`,
		});

		setProfile("alpha");
		const alpha = identityPaths();
		setProfile("beta");
		const beta = identityPaths();
		setProfile(undefined);
		const base = identityPaths();

		for (const key of ["agentsMd", "mcpJson", "settings"] as const) {
			expect(alpha[key]).toContain("profiles/alpha/");
			expect(beta[key]).toContain("profiles/beta/");
			expect(base[key]).toContain("profiles/default/");
			expect(alpha[key]).not.toBe(beta[key]);
		}
	});
});
