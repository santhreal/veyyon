import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { Skill } from "@veyyon/coding-agent/sdk";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@veyyon/utils";
import { getAgentDir, setAgentDir } from "@veyyon/utils/dirs";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

// Skills load only from the active profile's agent dir, so the master switch is
// the only skills setting left; there are no per-source toggles.
function createIsolatedSkillsSettings(): Settings {
	return Settings.isolated({
		"skills.enabled": true,
	});
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let nativeUserSkillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDir: string;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests: skill
	// discovery never touches models, and building them per test would make createAgentSession call
	// modelRegistry.refreshInBackground(), whose online model discovery saturates the event loop and
	// serializes the otherwise-parallel capability scans (~340ms/call). Supplying a prebuilt registry
	// skips that refresh entirely (~24ms/call).
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-skills-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
		originalHome = process.env.HOME;
		originalAgentDir = getAgentDir();
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-home-"));
		process.env.HOME = tempHomeDir;
		// Skills load only from the active profile's agent skills dir. Point the
		// agent dir at the temp home and author the test skill there.
		const userAgentDir = path.join(tempHomeDir, ".veyyon", "agent");
		setAgentDir(userAgentDir);
		nativeUserSkillsDir = path.join(userAgentDir, "skills");
		const testSkillDir = path.join(nativeUserSkillsDir, "test-skill");
		fs.mkdirSync(testSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(testSkillDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(externalSkillDir, path.join(nativeUserSkillsDir, "symlinked-skill-link"), "dir");
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
	});

	it("does not discover foreign ~/.claude/skills or project .veyyon/skills", async () => {
		// A skill in the Claude home dir must never load (no cross-computer autodiscovery).
		const claudeSkillDir = path.join(tempHomeDir, ".claude", "skills", "foreign-claude-skill");
		fs.mkdirSync(claudeSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeSkillDir, "SKILL.md"),
			`---\nname: foreign-claude-skill\ndescription: A Claude skill that must never load.\n---\n\n# Foreign\n`,
		);
		// A skill in a project-local .veyyon/skills dir must also not load: skills
		// belong to the profile, not to whatever repo you happen to be inside.
		const projectSkillDir = path.join(tempDir, ".veyyon", "skills", "project-skill");
		fs.mkdirSync(projectSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectSkillDir, "SKILL.md"),
			`---\nname: project-skill\ndescription: A project skill that must never load.\n---\n\n# Project\n`,
		);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "foreign-claude-skill")).toBe(false);
		expect(session.skills.some((s: Skill) => s.name === "project-skill")).toBe(false);
		// The profile skill still loads.
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});
	it("should have empty skills when options.skills is empty array (--no-skills)", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [], // Explicitly empty - like --no-skills
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should be empty
		expect(session.skills).toEqual([]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});

	it("should use provided skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should contain only the provided skill
		expect(session.skills).toEqual([customSkill]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});
});
