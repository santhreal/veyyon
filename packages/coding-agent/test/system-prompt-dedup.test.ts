import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { initializeWithSettings } from "@veyyon/coding-agent/capability";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
	type SystemPromptToolMetadata,
} from "@veyyon/coding-agent/system-prompt";
import { escapeRegExp } from "@veyyon/utils";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makePiSystemPromptDir = useTrackedTempDirs("pi-system-prompt-");
const makePiSystemHomeDir = useTrackedTempDirs("pi-system-home-");

// Discovering a bare project AGENTS.md (not under .veyyon/) is the foreign
// agents-md convention, gated behind the (default-off) importForeignConfig
// toggle. Turn it on for this file so the dedup-of-discovered test can find
// those files; restore the shipped default after each test.
beforeEach(() => initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": true })));
afterEach(() => initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": false })));

const READ_TOOL = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
]);

describe("prompt source isolation and deduplication", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = makePiSystemPromptDir();
		tempHomeDir = makePiSystemHomeDir();
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	/**
	 * A repository file must not bypass the assembled system prompt. This locks
	 * out the removed SYSTEM.md discovery path while proving the default role and
	 * workflow sections still reach the model.
	 */
	it("ignores project SYSTEM.md and keeps assembled prompt sections", async () => {
		const projectDir = path.join(tempDir, "project");
		const systemDir = path.join(projectDir, ".veyyon");
		const removedPrompt = "REMOVED PROJECT SYSTEM PROMPT";
		fs.mkdirSync(systemDir, { recursive: true });
		fs.writeFileSync(path.join(systemDir, "SYSTEM.md"), removedPrompt);

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).not.toContain(removedPrompt);
		expect(promptText).toContain("ROLE\n==============");
		expect(promptText).toContain("EXECUTION WORKFLOW\n==============");
	});

	it("does not resolve already-loaded prompt text as a path", async () => {
		const projectDir = path.join(tempDir, "project");
		const readablePromptText = path.join(projectDir, "README.md");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(readablePromptText, "File content that must not replace the prompt.");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			resolvedCustomPrompt: readablePromptText,
			resolvedAppendSystemPrompt: readablePromptText,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).toContain(readablePromptText);
		expect(promptText).not.toContain("File content that must not replace the prompt.");
	});

	/**
	 * APPEND_SYSTEM.md duplicated AGENTS.md but covered fewer scopes. This proves
	 * the removed append file stays inert while a real project AGENTS.md is still
	 * discovered and rendered with its exact path and content.
	 */
	it("ignores APPEND_SYSTEM.md while preserving discovered AGENTS.md", async () => {
		const projectDir = path.join(tempDir, "project");
		const removedAppend = "REMOVED APPEND PROMPT";
		const agentsContent = "PROJECT AGENTS INSTRUCTIONS";
		const agentsPath = path.join(projectDir, "AGENTS.md");
		fs.mkdirSync(path.join(projectDir, ".veyyon"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".veyyon", "APPEND_SYSTEM.md"), removedAppend);
		fs.writeFileSync(agentsPath, agentsContent);

		const contextFiles = await loadProjectContextFiles({ cwd: projectDir });
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			contextFiles,
			skills: [],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			workspaceTree: {
				rootPath: projectDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).not.toContain(removedAppend);
		expect(promptText).toContain(`<file path="${agentsPath}">`);
		expect(promptText).toContain(agentsContent);
	});

	it("renders active child repo context in the main system prompt", async () => {
		const parentDir = path.join(tempDir, "parent-cwd");
		fs.mkdirSync(path.join(parentDir, "active-project", ".git"), { recursive: true });

		const { systemPrompt } = await buildSystemPrompt({
			cwd: parentDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: {
				rootPath: parentDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});

		const promptText = systemPrompt.join("\n\n");
		expect(promptText).toContain("<active-repo-context>");
		expect(promptText).toContain("Exactly one direct child git repository was detected at `active-project`.");
		expect(promptText).toContain("Paths under `active-project/` are the active project");
	});

	/**
	 * Removing precedence is not enough if either level can still become a custom
	 * base. This adversarial pair keeps both the old project and user locations
	 * inert in the same prompt build.
	 */
	it("ignores project and profile SYSTEM.md files together", async () => {
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempHomeDir, ".veyyon", "profiles", "default", "agent");
		const projectPrompt = "REMOVED PROJECT SYSTEM PROMPT";
		const profilePrompt = "REMOVED PROFILE SYSTEM PROMPT";
		fs.mkdirSync(path.join(projectDir, ".veyyon"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".veyyon", "SYSTEM.md"), projectPrompt);
		fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), profilePrompt);

		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			agentDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).not.toContain(projectPrompt);
		expect(promptText).not.toContain(profilePrompt);
		expect(promptText).toContain("ROLE\n==============");
	});
	it("drops identical explicit context entries even when file names differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");
		const sharedContent = "Shared context instructions";

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: sharedContent, depth: 2 },
				{ path: nearPath, content: sharedContent, depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});

		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
		expect(promptText).not.toContain(`<file path="${farPath}">`);
		expect(promptText).toContain(`<file path="${nearPath}">`);
	});

	it("drops identical discovered context entries and keeps the closest copy", async () => {
		const projectDir = path.join(tempDir, "project");
		const appDir = path.join(projectDir, "packages", "app");
		const sharedContent = "Shared context instructions";

		fs.mkdirSync(appDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), sharedContent);
		fs.writeFileSync(path.join(appDir, "AGENTS.md"), sharedContent);

		const contextFiles = await loadProjectContextFiles({ cwd: appDir });
		const discoveredFiles = contextFiles.filter(file => file.path.startsWith(projectDir));

		expect(discoveredFiles).toHaveLength(1);
		expect(discoveredFiles[0]?.path).toBe(path.join(appDir, "AGENTS.md"));
	});

	it("keeps distinct context entries when their contents differ", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "CLAUDE.md");

		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			customPrompt: "Base prompt",
			contextFiles: [
				{ path: farPath, content: "Root context instructions", depth: 2 },
				{ path: nearPath, content: "Near context instructions", depth: 0 },
			],
			skills: [],
			rules: [],
			toolNames: [],
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain("Root context instructions");
		expect(promptText).toContain("Near context instructions");
	});

	it("drops always-apply rule content already present through expanded context imports", async () => {
		const projectDir = path.join(tempDir, "project");
		const instructionPath = path.join(projectDir, ".github", "instructions", "shared.instructions.md");
		const sharedContent = "Shared imported guidance";
		fs.mkdirSync(path.dirname(instructionPath), { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "Use @.github/instructions/shared.instructions.md\n");
		fs.writeFileSync(instructionPath, `---\napplyTo: '**'\n---\n\n${sharedContent}\n`);

		const contextFiles = await loadProjectContextFiles({ cwd: projectDir });
		const { systemPrompt } = await buildSystemPrompt({
			cwd: projectDir,
			customPrompt: "Base prompt",
			contextFiles,
			skills: [],
			rules: [],
			alwaysApplyRules: [{ name: "shared", path: instructionPath, content: sharedContent }],
			toolNames: [],
		});

		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];
		expect(matches).toHaveLength(1);
	});
});
