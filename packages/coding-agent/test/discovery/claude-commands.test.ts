import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { type SlashCommand, slashCommandCapability } from "@veyyon/coding-agent/capability/slash-command";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { removeWithRetries } from "@veyyon/utils";

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

describe("Claude Code slash command discovery", () => {
	let root = "";
	let home = "";
	let project = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		originalHome = process.env.HOME;
		root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-claude-commands-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
	});

	afterEach(async () => {
		clearFsCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await removeWithRetries(root);
	});

	/**
	 * Namespace aliasing is a USER-level contract now. A nested command is reachable
	 * under both its basename and its `dir:name` alias, so `opsx/apply.md` answers to
	 * `apply` and to `opsx:apply`.
	 *
	 * This test used to write its fixtures into the project, back when a repository's
	 * `.claude/commands/` was scanned. That scan was removed: a repository is not
	 * allowed to install a slash command, because typing a command name is not consent
	 * to run a prompt the working tree authored. The behavior under test is unchanged,
	 * so the fixtures moved to the operator's home rather than the assertions changing.
	 */
	test("aliases nested user commands under both basename and namespace names", async () => {
		await writeFile(path.join(home, ".claude", "commands", "triage.md"), "Triage prompt\n");
		await writeFile(path.join(home, ".claude", "commands", "opsx", "apply.md"), "Apply prompt\n");
		await writeFile(path.join(home, ".claude", "commands", "team", "audit.md"), "Audit prompt\n");

		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const names = result.items.map(command => command.name);

		expect(result.warnings).toEqual([]);
		expect(names).toContain("triage");
		expect(names).toContain("apply");
		expect(names).toContain("opsx:apply");
		expect(names).toContain("audit");
		expect(names).toContain("team:audit");
	});

	/**
	 * A root command wins the bare name over a nested command with the same basename,
	 * and the nested one keeps its namespaced alias. Without this, adding
	 * `agent/apply.md` would silently steal `/apply` from the root command an operator
	 * already had.
	 */
	test("keeps root user commands ahead of nested basename duplicates", async () => {
		const rootApply = path.join(home, ".claude", "commands", "apply.md");
		const nestedApply = path.join(home, ".claude", "commands", "agent", "apply.md");
		await writeFile(rootApply, "Root apply prompt\n");
		await writeFile(nestedApply, "Nested apply prompt\n");

		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const apply = result.items.find(command => command.name === "apply");
		const agentApply = result.items.find(command => command.name === "agent:apply");

		expect(result.warnings).toEqual([]);
		expect(apply?.path).toBe(rootApply);
		expect(apply?.content).toBe("Root apply prompt\n");
		expect(agentApply?.path).toBe(nestedApply);
		expect(agentApply?.content).toBe("Nested apply prompt\n");
	});

	/**
	 * The removal itself, pinned. A repository's `.claude/commands/` contributes
	 * NOTHING, even when the same session loads user commands successfully, so this
	 * cannot pass merely because discovery found nothing at all.
	 *
	 * The gate it replaces was worse than absent: `commands.enableClaudeProject` was
	 * read on every command load, returned from the toggle reader, and dropped by the
	 * only caller, which destructures `enableUser` alone. It has been removed, and a
	 * stale key in an old config.yml is ignored rather than an error.
	 */
	test("ignores a repository's .claude/commands while still loading the operator's own", async () => {
		await writeFile(path.join(project, ".claude", "commands", "pwn.md"), "Repository prompt\n");
		await writeFile(path.join(project, ".claude", "commands", "deep", "pwn.md"), "Nested repository prompt\n");
		await writeFile(path.join(home, ".claude", "commands", "mine.md"), "Operator prompt\n");

		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: project,
			providers: ["claude"],
		});
		const names = result.items.map(command => command.name);

		expect(result.warnings).toEqual([]);
		expect(names).toContain("mine");
		expect(names).not.toContain("pwn");
		expect(names).not.toContain("deep:pwn");
		expect(result.items.every(command => !command.path.startsWith(project))).toBe(true);
	});
});
