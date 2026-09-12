/**
 * WHY:
 * Foreign discovery providers maintain distinct semantic contracts around empty context files:
 * - OpenAI Codex (`discovery/codex.ts`) checks `if (content)`, strictly requiring truthy (non-empty)
 *   file content. A 0-byte `~/.codex/AGENTS.md` is treated as absent rather than an active context item.
 * - Claude Code (`discovery/claude.ts`) checks `if (content !== null)`, admitting 0-byte `CLAUDE.md` files
 *   (user and project level) as valid discovered items with `content: ""`.
 *
 * This suite verifies the contract at the capability provider discovery boundary with explicit `home`
 * paths, ensuring no shared refactoring accidentally blurs this provider distinction.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { type ContextFile, contextFileCapability } from "@veyyon/coding-agent/discovery/capability/context-file";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { removeWithRetries } from "@veyyon/utils";
import "@veyyon/coding-agent/discovery/claude";
import "@veyyon/coding-agent/discovery/codex";
import "@veyyon/coding-agent/discovery/gemini";
import "@veyyon/coding-agent/discovery/opencode";

describe("context file discovery provider semantics", () => {
	let root = "";
	let home = "";
	let project = "";

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-context-files-test-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		await fs.mkdir(path.join(home, ".claude"), { recursive: true });
		await fs.mkdir(path.join(home, ".codex"), { recursive: true });
		await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
		await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
		await fs.mkdir(path.join(project, ".claude"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		await removeWithRetries(root);
	});

	test("Codex excludes empty AGENTS.md while discovering non-empty AGENTS.md", async () => {
		const agentsMd = path.join(home, ".codex", "AGENTS.md");
		// First: empty file
		await fs.writeFile(agentsMd, "");

		const emptyResult = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["codex"],
		});
		expect(emptyResult.items).toEqual([]);

		// Second: non-empty file
		clearFsCache();
		await fs.writeFile(agentsMd, "You are a coding assistant.\n");

		const nonEmptyResult = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["codex"],
		});
		expect(nonEmptyResult.items).toHaveLength(1);
		expect(nonEmptyResult.items[0].content).toBe("You are a coding assistant.\n");
		expect(nonEmptyResult.items[0].level).toBe("user");
		expect(nonEmptyResult.items[0]._source.provider).toBe("codex");
	});

	test("Claude admits empty CLAUDE.md for both user and project scopes", async () => {
		const userClaude = path.join(home, ".claude", "CLAUDE.md");
		const projectClaude = path.join(project, ".claude", "CLAUDE.md");
		await fs.writeFile(userClaude, "");
		await fs.writeFile(projectClaude, "");

		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["claude"],
		});
		expect(result.items).toHaveLength(2);

		const userItem = result.items.find(i => i.level === "user");
		expect(userItem?.path).toBe(userClaude);
		expect(userItem?.content).toBe("");

		const projectItem = result.items.find(i => i.level === "project");
		expect(projectItem?.path).toBe(projectClaude);
		expect(projectItem?.content).toBe("");
	});

	test("Gemini excludes empty GEMINI.md while discovering non-empty GEMINI.md", async () => {
		const geminiMd = path.join(home, ".gemini", "GEMINI.md");
		// First: empty file
		await fs.writeFile(geminiMd, "");

		const emptyResult = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["gemini"],
		});
		expect(emptyResult.items).toEqual([]);

		// Second: non-empty file
		clearFsCache();
		await fs.writeFile(geminiMd, "You are Gemini.\n");

		const nonEmptyResult = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["gemini"],
		});
		expect(nonEmptyResult.items).toHaveLength(1);
		expect(nonEmptyResult.items[0].content).toBe("You are Gemini.\n");
		expect(nonEmptyResult.items[0].level).toBe("user");
		expect(nonEmptyResult.items[0]._source.provider).toBe("gemini");
	});

	test("OpenCode excludes empty AGENTS.md while discovering non-empty AGENTS.md", async () => {
		const agentsMd = path.join(home, ".config", "opencode", "AGENTS.md");
		// First: empty file
		await fs.writeFile(agentsMd, "");

		const emptyResult = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["opencode"],
		});
		expect(emptyResult.items).toEqual([]);

		// Second: non-empty file
		clearFsCache();
		await fs.writeFile(agentsMd, "You are OpenCode.\n");

		const nonEmptyResult = await loadCapability<ContextFile>(contextFileCapability.id, {
			home,
			cwd: project,
			providers: ["opencode"],
		});
		expect(nonEmptyResult.items).toHaveLength(1);
		expect(nonEmptyResult.items[0].content).toBe("You are OpenCode.\n");
		expect(nonEmptyResult.items[0].level).toBe("user");
		expect(nonEmptyResult.items[0]._source.provider).toBe("opencode");
	});
});
