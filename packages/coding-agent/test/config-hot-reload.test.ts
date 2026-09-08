import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveEffort } from "../src/config/effort-resolver";
import { Settings } from "../src/config/settings";
import { InputController, type InputControllerContext } from "../src/modes/controllers/input-controller";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { resolveSubagentModel } from "../src/task/subagent-settings";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const dirs = useTrackedTempDirs("config-reload-");

describe("config hot reload", () => {
	it("contains rejected reloads through the real TUI follow-up dispatcher and permits retry", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		let draft = "/reload-config";
		const errors: string[] = [];
		const statuses: string[] = [];
		const history: string[] = [];
		const ctx = {
			settings,
			session: { isCompacting: false },
			sessionManager: { getCwd: () => dir },
			editor: {
				getExpandedText: () => draft,
				setText: (text: string) => { draft = text; },
				addToHistory: (text: string) => { history.push(text); },
				pendingImages: [],
				pendingImageLinks: [],
			},
			showError: (text: string) => { errors.push(text); },
			showStatus: (text: string) => { statuses.push(text); },
		} as unknown as InputControllerContext;
		const input = new InputController(ctx);
		await fs.writeFile(file, "subagent: [");
		await expect(input.handleFollowUp()).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		expect(statuses.join("\n")).toContain("Config reload failed");
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		expect(draft).toBe("/reload-config");
		await fs.writeFile(file, "subagent:\n  model: openai/new\n  sharedModel: true\n");
		await expect(input.handleFollowUp()).resolves.toBeUndefined();
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/new"]);
		expect(draft).toBe("");
		expect(history).toEqual(["/reload-config", "/reload-config"]);
	});

	it("dispatches the real text command with an off/on routing differential", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			settings,
			cwd: dir,
			output: text => {
				output.push(text);
			},
			get session(): never {
				throw new Error("reload must not rebind the session");
			},
			get sessionManager(): never {
				throw new Error("reload must not touch session persistence");
			},
			refreshCommands: () => {
				throw new Error("reload must not refresh plugins");
			},
			reloadPlugins: async () => {
				throw new Error("reload must not reload plugins");
			},
		};
		await fs.writeFile(file, "subagent:\n  model: openai/new\n  sharedModel: true\n");
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		expect(await executeAcpBuiltinSlashCommand("/reload-config", runtime)).toEqual({ consumed: true });
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/new"]);
		expect(output[0]).toContain('subagent.model: "openai/old" → "openai/new"');
		await executeAcpBuiltinSlashCommand("/reload-config", runtime);
		expect(output[1]).toContain("No effective routing changes.");
	});

	it("changes new spawn routing, preserves existing forks, and reports restart-only settings", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(
			file,
			"modelRoles:\n  worker: openai/old\nsubagent:\n  sharedModel: true\n  model: '@worker'\ndefaultEffort:\n  '*': low\n",
		);
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const existing = settings.forkWithRuntimeOverrides();
		const resolve = (store: Settings) => resolveSubagentModel({ settings: store, agentName: "task" }).patterns;
		expect(resolve(settings)).toEqual(["openai/old"]);
		await fs.writeFile(
			file,
			"modelRoles:\n  worker: openai/new\nsubagent:\n  sharedModel: true\n  model: '@worker'\ndefaultEffort:\n  '*': high\nhideThinkingBlock: true\n",
		);
		const result = await settings.reloadConfig();
		expect(resolve(settings)).toEqual(["openai/new"]);
		expect(resolve(existing)).toEqual(["openai/old"]);
		expect(resolveEffort({ defaultEffort: settings.get("defaultEffort") }).level as string).toBe("high");
		expect(settings.get("hideThinkingBlock")).toBe(false);
		expect(result.restartRequired).toContain("hideThinkingBlock");
		expect(result.changed.map(row => row.path)).toEqual(expect.arrayContaining(["modelRoles", "defaultEffort"]));
		expect((await settings.reloadConfig()).changed).toEqual([]);
	});

	it("preserves override precedence and applies removed routing fields", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const overlay = path.join(dir, "overlay.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/profile\n  thinkingLevel: high\n");
		await fs.writeFile(overlay, "subagent:\n  model: openai/overlay\n");
		const settings = await Settings.loadReadOnly({
			agentDir: dir,
			configFiles: [overlay],
			overrides: { "subagent.model": "openai/runtime" },
		});
		await fs.writeFile(file, "{}\n");
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/runtime");
		expect(settings.getSource("subagent.model")).toBe("runtime");
		expect(settings.get("subagent.thinkingLevel")).toBeUndefined();
	});

	it("rejects malformed or invalid files without mutating disk or live routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const invalid of [
			"[broken",
			"- sequence",
			"subagent:\n  model: 42\n",
			"subagent: 42\n",
			"subagent: null\n",
			"subagent: []\n",
		]) {
			await fs.writeFile(file, invalid);
			await expect(settings.reloadConfig()).rejects.toThrow();
			expect(settings.get("subagent.model")).toBe("openai/old");
			expect(await fs.readFile(file, "utf8")).toBe(invalid);
		}
	});
	it("rejects invalid roster members at every depth and preserves prior spawn routing", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  agents:\n    task:\n      model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const member of [
			{ model: 42 },
			{ model: ["openai/new", 42] },
			{ enabled: "false" },
			{ thinkingLevel: 42 },
			{ maxNestedSpawnDepth: "2" },
			{ maxNestedSpawnDepth: 1.5 },
			{ maxNestedSpawnDepth: -2 },
			{ thinkingLevel: "impossible" },
			{ subagents: [] },
			{ subagents: null },
		]) {
			for (const lane of [member, { subagents: member }, { subagents: { subagents: member } }]) {
				const contents = JSON.stringify({ subagent: { agents: { task: lane } } });
				await fs.writeFile(file, contents);
				await expect(settings.reloadConfig()).rejects.toThrow("Invalid config settings");
				expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
				expect(await fs.readFile(file, "utf8")).toBe(contents);
			}
		}
		await fs.writeFile(
			file,
			JSON.stringify({
				subagent: {
					agents: {
						task: {
							model: "openai/allowed",
							thinkingLevel: "high",
							subagents: { enabled: true, thinkingLevel: " ", maxNestedSpawnDepth: -1 },
						},
					},
				},
			}),
		);
		await settings.reloadConfig();
		expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/allowed"]);
	});

	it("rejects semantic-invalid nested lanes with the startup schema diagnostic", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  agents:\n    task:\n      model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		for (const member of [
			{ maxNestedSpawnDepth: 1.5 },
			{ maxNestedSpawnDepth: -2 },
			{ thinkingLevel: "impossible" },
		]) {
			await fs.writeFile(file, JSON.stringify({ subagent: { agents: { task: { subagents: member } } } }));
			const startup = await Settings.loadReadOnly({ agentDir: dir });
			expect(startup.invalidValues).toHaveLength(1);
			const diagnostic = startup.invalidValues[0].reason;
			expect(diagnostic).toContain("subagent.agents.task.subagents");
			await expect(settings.reloadConfig()).rejects.toThrow(diagnostic);
			expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual(["openai/old"]);
		}
	});

	it("keeps the activated snapshot across reload and later saves without firing restart-only hooks", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "hideThinkingBlock: false\nsubagent:\n  model: openai/old\n  sharedModel: true\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		const notifications: string[] = [];
		const unsubscribe = settings.onEffectiveSettingChanged(key => notifications.push(key));
		try {
			await fs.writeFile(file, "hideThinkingBlock: true\nsubagent:\n  model: openai/new\n  sharedModel: true\n");
			expect((await settings.reloadConfig()).restartRequired).toContain("hideThinkingBlock");
			expect(settings.get("hideThinkingBlock")).toBe(false);
			for (const model of ["openai/saved", "openai/saved-again"]) {
				settings.set("subagent.model", model);
				await settings.flush();
				expect(settings.get("hideThinkingBlock")).toBe(false);
				expect(resolveSubagentModel({ settings, agentName: "task" }).patterns).toEqual([model]);
				expect(await fs.readFile(file, "utf8")).toContain("hideThinkingBlock: true");
				expect((await settings.reloadConfig()).restartRequired).toContain("hideThinkingBlock");
			}
			expect(notifications).not.toContain("hideThinkingBlock");
			// An explicit setter remains an activation, unlike a disk-preserving save.
			settings.set("hideThinkingBlock", true);
			await settings.flush();
			expect(settings.get("hideThinkingBlock")).toBe(true);
			expect(notifications.filter(key => key === "hideThinkingBlock")).toHaveLength(1);
			expect((await settings.reloadConfig()).restartRequired).not.toContain("hideThinkingBlock");
		} finally {
			unsubscribe();
		}
	});

	it("reloads defaults when the main file is deleted", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.unlink(file);
		await settings.reloadConfig();
		const startup = await Settings.loadReadOnly({ agentDir: dir });
		expect(settings.get("subagent.model")).toBe(startup.get("subagent.model"));
		expect(await fs.readdir(dir)).not.toContain("config.yml");
	});

	it("rediscovers the alternate main filename and saves to it", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		const alternate = path.join(dir, "config.yaml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		await fs.rename(file, alternate);
		await fs.writeFile(alternate, "subagent:\n  model: openai/new\n");
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/new");
		settings.set("subagent.model", "openai/saved");
		await settings.flush();
		expect(await fs.readFile(alternate, "utf8")).toContain("openai/saved");
		expect(await fs.readdir(dir)).not.toContain("config.yml");
	});

	it("does not fall through an unreadable main candidate to an alternate", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		await fs.unlink(file);
		await fs.mkdir(file);
		await fs.writeFile(path.join(dir, "config.yaml"), "subagent:\n  model: openai/new\n");
		await expect(settings.reloadConfig()).rejects.toThrow();
		expect(settings.get("subagent.model")).toBe("openai/old");
	});

	it("notifies next-turn consumers once and only for effective routing changes", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "{}\n");
		const settings = await Settings.loadReadOnly({ agentDir: dir });
		const changed: string[] = [];
		const unsubscribe = settings.onEffectiveSettingChanged(key => changed.push(key));
		try {
			await fs.writeFile(file, "subagent:\n  agents:\n    task:\n      model: openai/new\n");
			await settings.reloadConfig();
			expect(changed).toEqual(["subagent.agents"]);
			await settings.reloadConfig();
			expect(changed).toEqual(["subagent.agents"]);
		} finally {
			unsubscribe();
		}
	});

	it("rejects reload for the entire active save and preserves the saved value", async () => {
		const dir = dirs();
		const file = path.join(dir, "config.yml");
		await fs.writeFile(file, "subagent:\n  model: openai/old\n");
		const settings = await Settings.loadIsolated({ agentDir: dir });
		settings.set("subagent.model", "openai/saved");
		const saving = settings.flush();
		try {
			await expect(settings.reloadConfig()).rejects.toThrow("being saved");
		} finally {
			await saving;
		}
		await settings.reloadConfig();
		expect(settings.get("subagent.model")).toBe("openai/saved");
		expect(await fs.readFile(file, "utf8")).toContain("openai/saved");
	});
});
