/**
 * Per-profile skill isolation contract.
 *
 * A profile is a separate config root (`~/.veyyon/profiles/<name>/agent`).
 * Veyyon's profile-owned skill sources resolve through `getAgentDir()`, so
 * activating a profile physically re-homes:
 *   - native authored skills (`<agentDir>/skills`)
 *   - managed/auto-learn skills (`<agentDir>/managed-skills`)
 *   - user extension/plugin roots configured or installed in that profile
 *
 * Project-local `.veyyon/skills` is deliberately never scanned: opening a
 * repository cannot ambiently inject instructions. Foreign-tool skill roots
 * (`~/.claude/skills`, `~/.codex/skills`, etc.) are likewise excluded from the
 * active skill loader. Explicit project/CLI extension packages may contribute
 * skills through the `veyyon-plugins` provider; those are configured providers,
 * not ambient project skill discovery.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getManagedSkillsDir } from "@veyyon/coding-agent/autolearn/managed-skills";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	MAIN_CONFIG_FILENAMES,
	refreshDirsFromEnv,
	setProfile,
} from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

function nativeUserSkillsDir(): string {
	// Mirrors discovery/builtin.ts loadSkills user scan: `<agentDir>/skills`.
	return `${getAgentDir()}/skills`;
}

// A VEYYON_CODING_AGENT_DIR override leaked by a sibling test file makes default
// mode resolve to the override verbatim instead of profiles/default, so this file pins
// the baseline (no override) for its own window and puts the whole snapshot back after.
const dirOverrides = captureDirOverrides();
const initialProfileEnv = process.env.VEYYON_PROFILE;

beforeAll(() => {
	delete process.env.VEYYON_CODING_AGENT_DIR;
	delete process.env.VEYYON_PROFILE;
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
});
beforeEach(() => {
	delete process.env.VEYYON_CODING_AGENT_DIR;
	delete process.env.VEYYON_PROFILE;
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
});

afterAll(() => {
	if (initialProfileEnv === undefined) {
		delete process.env.VEYYON_PROFILE;
	} else {
		process.env.VEYYON_PROFILE = initialProfileEnv;
	}
	restoreDirOverrides(dirOverrides);
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
});

afterEach(() => {
	// Back to whatever profile this process was on, which is NOT necessarily the default:
	// `setProfile(undefined)` here used to hand every later file the default profile while
	// the developer was running under a named one.
	restoreDirOverrides(dirOverrides);
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
