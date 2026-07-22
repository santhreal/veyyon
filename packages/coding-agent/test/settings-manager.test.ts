import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Effort } from "@veyyon/ai";
import { initializeWithSettings } from "@veyyon/coding-agent/capability";
import "@veyyon/coding-agent/discovery";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { __providerInFlightForTesting, streamSimple } from "@veyyon/ai/stream";
import type { Context } from "@veyyon/ai/types";
import {
	getDefault,
	getEnumValues,
	onAppendOnlyModeChanged,
	onStatusLineSessionAccentChanged,
	resetSettingsForTest,
	type SettingPath,
	Settings,
} from "@veyyon/coding-agent/config/settings";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { getProjectAgentDir, logger, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function context(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	};
}

describe("Settings", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();

		// Use TempDir for Windows-safe cleanup (retries on EBUSY from SQLite
		// file handle release delays).
		tempDir = TempDir.createSync("@pi-settings-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");

		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	const getConfigPath = () => path.join(agentDir, "config.yml");

	const writeSettings = async (settings: Record<string, unknown>) => {
		await Bun.write(getConfigPath(), YAML.stringify(settings, null, 2));
	};

	const readSettings = async (): Promise<Record<string, unknown>> => {
		const file = Bun.file(getConfigPath());
		if (!(await file.exists())) return {};
		const content = await file.text();
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	};

	afterEach(async () => {
		clearCustomApis();
		__providerInFlightForTesting.setRoot(undefined);
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await Bun.sleep(0);
		await tempDir?.remove();
	});

	describe("unparseable settings file", () => {
		// A settings file can become unparseable in ordinary use: a hand-edited
		// value containing an unquoted colon, a bad indent, or a truncated write
		// from a crash or a full disk. What must never happen is that veyyon
		// destroys the file the user is about to fix.
		const corruptYaml = ["startup:", "  quiet: true", "model: gpt: 4"].join("\n");

		it("quarantines the file instead of overwriting it on the next save", async () => {
			// REGRESSION, data loss. Loading a corrupt file used to yield an empty
			// config with only a debug log. The next `set` then re-read that same
			// empty config, applied the one changed path, and wrote the result over
			// the file, permanently erasing every other setting the user had.
			fs.mkdirSync(agentDir, { recursive: true });
			await Bun.write(getConfigPath(), corruptYaml);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();

			const quarantined = `${getConfigPath()}.corrupt`;
			expect(fs.existsSync(quarantined)).toBe(true);
			expect(fs.readFileSync(quarantined, "utf-8")).toBe(corruptYaml);
		});

		it("still lets the session save, so the user does not silently lose their change", async () => {
			// Refusing to write would trade one silent failure for another: the user
			// changes a setting, sees it take effect, and finds it gone next launch.
			fs.mkdirSync(agentDir, { recursive: true });
			await Bun.write(getConfigPath(), corruptYaml);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();

			expect((await readSettings()).setupVersion).toBe(2);
		});

		it("quarantines once, so a second save does not clobber the preserved copy", async () => {
			// The rescued content is the only copy of the user's settings. A later
			// save must not overwrite it with the now-valid file.
			fs.mkdirSync(agentDir, { recursive: true });
			await Bun.write(getConfigPath(), corruptYaml);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();
			settings.set("setupVersion", 3);
			await settings.flush();

			expect(fs.readFileSync(`${getConfigPath()}.corrupt`, "utf-8")).toBe(corruptYaml);
		});

		it("reports the file through quarantinedFiles, so a caller can tell the user", async () => {
			// The log is not somewhere anyone looks. The session exposes what it
			// could not read so the UI can say it out loud at startup.
			fs.mkdirSync(agentDir, { recursive: true });
			await Bun.write(getConfigPath(), corruptYaml);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.quarantinedFiles).toEqual([
				{ path: getConfigPath(), quarantinePath: `${getConfigPath()}.corrupt` },
			]);
		});

		it("does not report the same file twice when a save re-reads it", async () => {
			// #saveNow re-reads through the same loader, so a naive push would grow
			// the list on every save and the notification would repeat itself.
			fs.mkdirSync(agentDir, { recursive: true });
			await Bun.write(getConfigPath(), corruptYaml);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();

			expect(settings.quarantinedFiles).toHaveLength(1);
		});

		it("leaves a valid file alone, so nothing is quarantined in the normal case", async () => {
			fs.mkdirSync(agentDir, { recursive: true });
			await writeSettings({ startup: { quiet: true } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();

			expect(fs.existsSync(`${getConfigPath()}.corrupt`)).toBe(false);
			expect(settings.quarantinedFiles).toEqual([]);
			expect((await readSettings()).startup).toEqual({ quiet: true });
		});
	});

	describe("collapseChangelog migration", () => {
		it("strips the obsolete key on load instead of leaving a dead toggle", async () => {
			// collapseChangelog gated how much of the changelog startup dumped into
			// the terminal. Startup no longer prints release notes at all, so the key
			// controls nothing; leaving it in a user's config would keep offering a
			// toggle with no behavior behind it.
			fs.mkdirSync(agentDir, { recursive: true });
			await writeSettings({ collapseChangelog: true, startup: { quiet: true } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.isConfigured("collapseChangelog" as SettingPath)).toBe(false);
			// An unrelated key in the same file still applies.
			expect(settings.get("startup.quiet")).toBe(true);
		});

		it("drops the obsolete key from disk on the next save", async () => {
			// Loading migrates in memory; the file itself is only rewritten when
			// something saves. #saveNow re-reads through the same migration, so the
			// first save after an upgrade is what physically removes the key.
			fs.mkdirSync(agentDir, { recursive: true });
			await writeSettings({ collapseChangelog: true, startup: { quiet: true } });

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 2);
			await settings.flush();

			const saved = await readSettings();
			expect(saved).not.toHaveProperty("collapseChangelog");
			expect((saved.startup as { quiet?: boolean }).quiet).toBe(true);
		});

		it("exposes the update notice setting that replaced it, defaulting to on", () => {
			expect(getDefault("startup.updateNotice")).toBe(true);
		});
	});

	describe("malformed project settings surfacing (Law 10)", () => {
		it("warns instead of silently ignoring a malformed foreign project settings file", async () => {
			// A foreign settings provider (gemini) flags a broken .gemini/settings.json
			// with an "Invalid JSON" warning. #loadProjectSettings used to read only
			// result.items and drop result.warnings, so the broken file vanished with
			// no signal. Ensure the warning now reaches the operator.
			initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": true }));
			const geminiDir = path.join(projectDir, ".gemini");
			fs.mkdirSync(geminiDir, { recursive: true });
			fs.writeFileSync(path.join(geminiDir, "settings.json"), '{ "mcpServers": { broken ');

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			await Settings.init({ cwd: projectDir, agentDir });

			const surfaced = warnSpy.mock.calls.some(([message, context]) => {
				const ctx = context as Record<string, unknown> | undefined;
				const warning = typeof ctx?.warning === "string" ? ctx.warning : "";
				return (
					message === "Settings: project settings discovery warning" &&
					warning.includes("Invalid JSON") &&
					warning.includes("settings.json")
				);
			});
			expect(surfaced).toBe(true);
		});

		it("does not flag a well-formed project settings file as invalid", async () => {
			// A well-formed .gemini/settings.json under this project must not draw an
			// "Invalid JSON" warning that names it. Scope the assertion to this
			// project's own path: ambient user-level foreign config on the host may
			// surface its own unrelated discovery warnings, which are not what this
			// test is about.
			initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": true }));
			const geminiDir = path.join(projectDir, ".gemini");
			fs.mkdirSync(geminiDir, { recursive: true });
			const settingsPath = path.join(geminiDir, "settings.json");
			fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }));

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			await Settings.init({ cwd: projectDir, agentDir });

			const flagged = warnSpy.mock.calls.some(([message, context]) => {
				const ctx = context as Record<string, unknown> | undefined;
				const warning = typeof ctx?.warning === "string" ? ctx.warning : "";
				return (
					message === "Settings: project settings discovery warning" &&
					warning.includes("Invalid JSON") &&
					warning.includes(settingsPath)
				);
			});
			expect(flagged).toBe(false);
		});
	});

	describe("legacy migration surfacing (Law 10)", () => {
		// #migrateFromLegacy runs when persist is on and no config.yml/config.yaml
		// exists yet: it reads a legacy agent/settings.json, merges it, archives the
		// original to .bak, and writes config.yml. Each step used to swallow its
		// failure with a bare `catch {}`, so a malformed legacy file or a failed
		// write silently discarded the user's settings.

		it("warns when a legacy settings.json exists but cannot be parsed", async () => {
			fs.writeFileSync(path.join(agentDir, "settings.json"), '{ "theme": broken ');
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			await Settings.init({ cwd: projectDir, agentDir });

			const surfaced = warnSpy.mock.calls.some(
				([message]) => message === "Settings: legacy settings.json exists but could not be migrated",
			);
			expect(surfaced).toBe(true);
		});

		it("migrates a well-formed legacy settings.json without warning and archives the original", async () => {
			const legacyPath = path.join(agentDir, "settings.json");
			fs.writeFileSync(legacyPath, JSON.stringify({ theme: { name: "dark" } }));
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			await Settings.init({ cwd: projectDir, agentDir });

			const migrateWarned = warnSpy.mock.calls.some(([message]) =>
				String(message).startsWith("Settings: legacy settings.json exists but could not"),
			);
			expect(migrateWarned).toBe(false);
			// The original is archived and config.yml now exists (migration ran).
			expect(fs.existsSync(`${legacyPath}.bak`)).toBe(true);
			expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(true);
		});

		it("warns when migrated settings cannot be written to config.yml", async () => {
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: { name: "dark" } }));
			// A dangling symlink at the config.yml path reads as ENOENT (so the
			// "existing config" probe returns null and migration still runs) but
			// its write follows into a missing directory and fails with ENOENT.
			fs.symlinkSync(path.join(agentDir, "missing-dir", "config.yml"), path.join(agentDir, "config.yml"));
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			await Settings.init({ cwd: projectDir, agentDir });

			const surfaced = warnSpy.mock.calls.some(
				([message]) => message === "Settings: migrated settings could not be written to config.yml",
			);
			expect(surfaced).toBe(true);
		});
	});

	describe("main config file selection", () => {
		it("loads and updates an existing config.yaml without creating config.yml", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");
			await Bun.write(yamlConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("setupVersion")).toBe(1);

			settings.set("setupVersion", 2);
			await settings.flush();

			const savedSettings = YAML.parse(await Bun.file(yamlConfigPath).text()) as Record<string, unknown>;
			expect(savedSettings.setupVersion).toBe(2);
			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
		});

		it("clones the selected config.yaml path for persisted settings", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");
			await Bun.write(yamlConfigPath, YAML.stringify({ setupVersion: 1 }, null, 2));

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			const cloned = await settings.cloneForCwd(tempDir.join("other-project"));

			cloned.set("setupVersion", 2);
			await cloned.flush();

			const savedSettings = YAML.parse(await Bun.file(yamlConfigPath).text()) as Record<string, unknown>;
			expect(savedSettings.setupVersion).toBe(2);
			expect(await Bun.file(getConfigPath()).exists()).toBe(false);
		});

		it("creates config.yml for new persisted settings when no main config exists", async () => {
			const yamlConfigPath = path.join(agentDir, "config.yaml");

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			settings.set("setupVersion", 1);
			await settings.flush();

			expect(await Bun.file(getConfigPath()).exists()).toBe(true);
			expect(await Bun.file(yamlConfigPath).exists()).toBe(false);
			expect((await readSettings()).setupVersion).toBe(1);
		});
	});

	describe("defaults", () => {
		it("keeps eight inline images live by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("tui.maxInlineImages")).toBe(8);
		});

		it("keeps native terminal progress disabled by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("terminal.showProgress")).toBe(false);
			expect(getDefault("terminal.showProgress")).toBe(false);
		});

		it("keeps the normal startup splash disabled by default", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("startup.showSplash")).toBe(false);
			expect(getDefault("startup.showSplash")).toBe(false);
		});

		it("defaults provider in-flight request limits to an empty map", async () => {
			const settings = Settings.isolated();
			expect(settings.get("providers.maxInFlightRequests")).toEqual({});
			expect(getDefault("providers.maxInFlightRequests")).toEqual({});
		});

		it("exposes all tool calling mode options", () => {
			const values = getEnumValues("tools.format");
			expect(values).toEqual([
				"auto",
				"native",
				"glm",
				"hermes",
				"kimi",
				"xml",
				"anthropic",
				"deepseek",
				"harmony",
				"qwen3",
				"gemini",
				"gemma",
				"minimax",
				"pi-native",
			]);
		});
	});

	describe("get()", () => {
		it("resolves overrides, schema defaults, and falsey values", () => {
			const isolated = Settings.isolated({
				"display.showTokenUsage": false,
				setupVersion: 0,
				shellPath: "",
				enabledModels: [],
			});

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			expect(isolated.get("setupVersion")).toBe(0);
			expect(isolated.get("shellPath")).toBe("");
			expect(isolated.get("enabledModels")).toEqual([]);
			expect(isolated.get("tui.maxInlineImages")).toBe(getDefault("tui.maxInlineImages"));
		});

		it("invalidates cached resolved values after set, override, and clearOverride", () => {
			const isolated = Settings.isolated();

			expect(isolated.get("display.showTokenUsage")).toBe(false);
			isolated.set("display.showTokenUsage", true);
			expect(isolated.get("display.showTokenUsage")).toBe(true);

			isolated.override("display.showTokenUsage", false);
			expect(isolated.get("display.showTokenUsage")).toBe(false);

			isolated.clearOverride("display.showTokenUsage");
			expect(isolated.get("display.showTokenUsage")).toBe(true);
		});

		it("re-resolves path-scoped arrays when cwd changes", async () => {
			const otherDir = path.join(tempDir.toString(), "other-project");
			fs.mkdirSync(otherDir, { recursive: true });

			const settings = await Settings.init({
				cwd: projectDir,
				agentDir,
				inMemory: true,
				overrides: {
					enabledModels: [
						"always-model",
						{ path: projectDir, models: ["project-model"] },
						{ path: otherDir, models: ["other-model"] },
					],
					disabledProviders: [
						"always-provider",
						{ pathPrefix: projectDir, providers: ["project-provider"] },
						{ pathPrefix: otherDir, providers: ["other-provider"] },
					],
				},
			});

			expect(settings.get("enabledModels")).toEqual(["always-model", "project-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "project-provider"]);

			await settings.reloadForCwd(otherDir);

			expect(settings.get("enabledModels")).toEqual(["always-model", "other-model"]);
			expect(settings.get("disabledProviders")).toEqual(["always-provider", "other-provider"]);
		});

		it("migrates legacy inlineToolDescriptors booleans to the on/off enum", () => {
			expect(Settings.isolated({ inlineToolDescriptors: true }).get("inlineToolDescriptors")).toBe("on");
			expect(Settings.isolated({ inlineToolDescriptors: false }).get("inlineToolDescriptors")).toBe("off");
			expect(Settings.isolated().get("inlineToolDescriptors")).toBe("auto");
		});
	});

	describe("statusLine.sessionAccent hooks", () => {
		it("notifies subscribers only when the effective value changes", () => {
			const isolated = Settings.isolated();
			const values: boolean[] = [];
			const unsubscribe = onStatusLineSessionAccentChanged(() => {
				values.push(isolated.get("statusLine.sessionAccent"));
			});

			try {
				isolated.set("statusLine.sessionAccent", true);
				expect(values).toEqual([]);

				isolated.set("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", false);
				expect(values).toEqual([false]);

				isolated.override("statusLine.sessionAccent", true);
				expect(values).toEqual([false, true]);

				isolated.clearOverride("statusLine.sessionAccent");
				expect(values).toEqual([false, true, false]);
			} finally {
				unsubscribe();
			}

			isolated.set("statusLine.sessionAccent", true);
			expect(values).toEqual([false, true, false]);
		});
	});

	describe("provider.appendOnlyContext hooks", () => {
		it("isolates a throwing listener so the rest still receive the value", () => {
			const isolated = Settings.isolated();
			const received: string[] = [];
			const unsubscribeThrower = onAppendOnlyModeChanged(() => {
				throw new Error("boom");
			});
			const unsubscribeOk = onAppendOnlyModeChanged(value => {
				received.push(value);
			});

			try {
				expect(() => isolated.set("provider.appendOnlyContext", "on")).not.toThrow();
				expect(received).toEqual(["on"]);
			} finally {
				unsubscribeThrower();
				unsubscribeOk();
			}
		});
	});

	// Tests that SettingsManager merges with DB state on save rather than blindly overwriting.
	// This ensures external edits (via AgentStorage directly) aren't lost when the app saves.
	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Seed initial settings in config.yml
			await writeSettings({
				theme: "dark",
				modelRoles: { default: "claude-sonnet" },
			});

			// Settings loads the initial state
			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Simulate external edit (e.g., user modifying DB directly or another process)
			await writeSettings({
				theme: { dark: "anthracite" },
				modelRoles: { default: "claude-sonnet" },
				enabledModels: ["claude-opus-4-5", "gpt-5.2-codex"],
			});

			// Settings saves a change - should merge, not overwrite
			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
			expect((savedSettings.modelRoles as { default?: string } | undefined)?.default).toBe("claude-sonnet");
		});

		it("persists native terminal progress only after the user changes it", async () => {
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(await readSettings()).toEqual({});

			settings.set("terminal.showProgress", true);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.terminal).toEqual({ showProgress: true });
		});

		it("filters model allow-list and disabled providers by current path prefix", async () => {
			const workDir = path.join(projectDir, "work", "service");
			const privateDir = path.join(projectDir, "private", "app");
			fs.mkdirSync(workDir, { recursive: true });
			fs.mkdirSync(privateDir, { recursive: true });

			await writeSettings({
				enabledModels: [
					"claude-sonnet-4-5",
					{ path: path.join(projectDir, "work"), values: ["anthropic/claude-opus-4-5"] },
					{ path: path.join(projectDir, "private"), values: ["openai/gpt-5.2-codex"] },
				],
				disabledProviders: [
					"ollama",
					{ path: path.join(projectDir, "work"), values: ["openai"] },
					{ path: path.join(projectDir, "private"), values: ["anthropic"] },
				],
			});

			const workSettings = await Settings.init({ cwd: workDir, agentDir });
			expect(workSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "anthropic/claude-opus-4-5"]);
			expect(workSettings.get("disabledProviders")).toEqual(["ollama", "openai"]);

			resetSettingsForTest();
			const privateSettings = await Settings.init({ cwd: privateDir, agentDir });
			expect(privateSettings.get("enabledModels")).toEqual(["claude-sonnet-4-5", "openai/gpt-5.2-codex"]);
			expect(privateSettings.get("disabledProviders")).toEqual(["ollama", "anthropic"]);
		});

		it("should preserve custom settings when changing theme", async () => {
			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				modelRoles: { default: "claude-sonnet" },
				shellPath: "/bin/zsh",
				extensions: ["/path/to/extension.ts"],
			});

			settings.set("theme.dark", "anthracite");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toEqual({ dark: "anthracite" });
		});

		it("should let in-memory changes override file changes for same key", async () => {
			await writeSettings({
				theme: { dark: "anthracite" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			await writeSettings({
				theme: { dark: "anthracite" },
				defaultThinkingLevel: Effort.Low,
			});

			settings.set("defaultThinkingLevel", Effort.High);
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.defaultThinkingLevel).toBe(Effort.High);
		});
	});

	describe("model role overrides", () => {
		it("does not persist temporary default model overrides when another role is saved", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", "anthropic/claude-haiku-4-5");
			await settings.flush();

			const savedSettings = await readSettings();
			expect(savedSettings.modelRoles).toEqual({
				default: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-haiku-4-5",
			});
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
		});

		it("restores persisted model roles after clearing runtime overrides", async () => {
			await writeSettings({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("default")).toBe("openai/gpt-5.2-codex");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5");
		});

		it("keeps the live role value aligned when saving over a runtime override", () => {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			});

			settings.overrideModelRoles({ default: "openai/gpt-5.2-codex" });
			settings.setModelRole("default", "anthropic/claude-opus-4-5");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");

			settings.clearOverride("modelRoles");

			expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
		});
		it("clears a role when setModelRole receives undefined", () => {
			const settings = Settings.isolated();

			settings.setModelRole("smol", "x/y");
			expect(settings.getModelRole("smol")).toBe("x/y");

			settings.setModelRole("smol", undefined);

			expect(settings.getModelRole("smol")).toBeUndefined();
			expect(Object.hasOwn(settings.getModelRoles(), "smol")).toBe(false);
		});

		it("clears a role from the runtime override layer so the effective view updates immediately", () => {
			const settings = Settings.isolated({
				modelRoles: { smol: "anthropic/claude-haiku-4-5" },
			});

			settings.overrideModelRoles({ smol: "openai/gpt-5.2-codex" });
			expect(settings.getModelRole("smol")).toBe("openai/gpt-5.2-codex");

			settings.setModelRole("smol", undefined);

			expect(settings.getModelRole("smol")).toBeUndefined();
			expect(Object.hasOwn(settings.getModelRoles(), "smol")).toBe(false);
		});
	});

	describe("getEditVariantForModel", () => {
		it("matches configured model variants case-insensitively", async () => {
			await writeSettings({
				edit: {
					modelVariants: {
						kimi: "hashline",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");
		});

		it("refreshes cached model variants when the active project settings change", async () => {
			const otherProjectDir = tempDir.join("other-project");
			fs.mkdirSync(getProjectAgentDir(otherProjectDir), { recursive: true });

			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ edit: { modelVariants: { kimi: "hashline" } } }),
			);
			await Bun.write(
				path.join(getProjectAgentDir(otherProjectDir), "settings.json"),
				JSON.stringify({ edit: { modelVariants: { "gpt-5": "apply_patch" } } }),
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBe("hashline");

			await settings.reloadForCwd(otherProjectDir);

			expect(settings.getEditVariantForModel("openrouter/moonshotai/Kimi-K2-Instruct")).toBeNull();
			expect(settings.getEditVariantForModel("openai/gpt-5.2-codex")).toBe("apply_patch");
		});
	});

	describe("migrations", () => {
		it("maps removed atom edit mode settings to hashline", async () => {
			await writeSettings({
				edit: {
					mode: "atom",
					modelVariants: {
						"claude-opus": "atom",
						"gpt-5": "apply_patch",
					},
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("edit.mode")).toBe("hashline");
			expect(settings.getEditVariantForModel("claude-opus-4-5")).toBe("hashline");
			expect(settings.getEditVariantForModel("gpt-5.2")).toBe("apply_patch");
		});

		it("maps legacy hindsight.dynamicBankId=true onto hindsight.scoping=per-project", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("per-project");
		});

		it("does not override an explicit hindsight.scoping when migrating", async () => {
			await writeSettings({
				hindsight: { dynamicBankId: true, scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.scoping")).toBe("global");
		});

		it("promotes legacy hindsight.agentName onto hindsight.bankId when bankId is unset", async () => {
			await writeSettings({
				hindsight: { agentName: "ada-cli" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		});

		it("migrates the legacy mnemosyne memory backend to mnemopi", async () => {
			await writeSettings({
				memory: { backend: "mnemosyne" },
				mnemosyne: { dbPath: "/tmp/old.db", scoping: "global" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("memory.backend")).toBe("mnemopi");
			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/old.db");
			expect(settings.get("mnemopi.scoping")).toBe("global");
		});

		it("does not clobber an explicit mnemopi block when the legacy mnemosyne block is also present", async () => {
			await writeSettings({
				mnemosyne: { dbPath: "/tmp/old.db" },
				mnemopi: { dbPath: "/tmp/new.db" },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("mnemopi.dbPath")).toBe("/tmp/new.db");
		});

		it("migrates boolean task.eager/todo.eager true to always", async () => {
			await writeSettings({
				task: { eager: true },
				todo: { eager: true },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// `true` reproduced the previous "on" behavior, now `always`.
			expect(settings.get("task.eager")).toBe("always");
			expect(settings.get("todo.eager")).toBe("always");
		});

		it("migrates boolean task.eager/todo.eager false to default", async () => {
			await writeSettings({
				task: { eager: false },
				todo: { eager: false },
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Load-bearing direction: consumers treat any non-`default` value as enabled
			// (`false !== "default"`), so an un-coerced boolean `false` would read as ON.
			expect(settings.get("task.eager")).toBe("default");
			expect(settings.get("todo.eager")).toBe("default");
		});

		it("moves legacy lastChangelogVersion out of config.yml into the marker file", async () => {
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			// Marker seeded from the legacy key.
			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.40.0");

			// Key stripped from config.yml on the next save.
			settings.set("display.showTokenUsage", true);
			await settings.flush();
			const onDisk = await readSettings();
			expect("lastChangelogVersion" in onDisk).toBe(false);
			expect((onDisk.display as Record<string, unknown>).showTokenUsage).toBe(true);
		});

		it("never clobbers an existing marker with the legacy config value", async () => {
			fs.writeFileSync(path.join(agentDir, "last-changelog-version"), "0.41.0");
			await writeSettings({ lastChangelogVersion: "0.40.0" });

			await Settings.init({ cwd: projectDir, agentDir });

			expect(fs.readFileSync(path.join(agentDir, "last-changelog-version"), "utf8")).toBe("0.41.0");
		});

		it("migrates legacy find and search settings to glob and grep", async () => {
			await writeSettings({
				find: { enabled: false },
				search: {
					enabled: false,
					contextBefore: 2,
					contextAfter: 5,
				},
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("migrates flat legacy find and search settings keys to nested glob and grep", async () => {
			await writeSettings({
				"find.enabled": false,
				"search.enabled": false,
				"search.contextBefore": 2,
				"search.contextAfter": 5,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(false);
			expect(settings.get("grep.enabled")).toBe(false);
			expect(settings.get("grep.contextBefore")).toBe(2);
			expect(settings.get("grep.contextAfter")).toBe(5);
		});

		it("does not clobber existing glob/grep settings when migrating legacy find/search ones", async () => {
			await writeSettings({
				find: { enabled: false },
				glob: { enabled: true },
				search: { enabled: false },
				grep: { enabled: true },
				"find.enabled": false,
				"glob.enabled": true,
				"search.enabled": false,
				"grep.enabled": true,
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("glob.enabled")).toBe(true);
			expect(settings.get("grep.enabled")).toBe(true);
		});

		it("migrates legacy tool names in persisted essential overrides", async () => {
			await writeSettings({
				tools: { essentialOverride: ["read", "find", "search", "grep"] },
				"tools.essentialOverride": ["find", "search", "read"],
			});

			const settings = await Settings.init({ cwd: projectDir, agentDir });

			expect(settings.get("tools.essentialOverride")).toEqual(["read", "glob", "grep"]);
		});

		it("migrates from settings.json containing comments", async () => {
			const jsonPath = path.join(agentDir, "settings.json");
			await fs.promises.writeFile(
				jsonPath,
				`{
					// This is a comment
					"display": {
						/* Multiline comment */
						"showTokenUsage": true
					}
				}`,
			);

			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("display.showTokenUsage")).toBe(true);
			expect(fs.existsSync(jsonPath)).toBe(false);
			expect(fs.existsSync(`${jsonPath}.bak`)).toBe(true);
		});
		it("migrates legacy power booleans with system=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: true,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("migrates legacy power booleans with display=true to display level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: true,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("migrates legacy power booleans with declareUserActive=true to system level", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: true,
					preventSystemSleep: false,
					declareUserActive: true,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("system");
		});

		it("preserves old idle default when only non-idle keys are set", async () => {
			// Old default was preventIdleSleep=true; user only set display=false.
			// Migration should yield "idle", not "off".
			await writeSettings({
				power: { preventDisplaySleep: false },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("idle");
		});

		it("migrates all-false power booleans to off", async () => {
			await writeSettings({
				power: {
					preventIdleSleep: false,
					preventSystemSleep: false,
					declareUserActive: false,
					preventDisplaySleep: false,
				},
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		it("migrates flat-key power booleans to the enum", async () => {
			await writeSettings({
				"power.preventIdleSleep": true,
				"power.preventDisplaySleep": true,
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("display");
		});

		it("does not overwrite an explicit power.sleepPrevention", async () => {
			await writeSettings({
				power: { sleepPrevention: "off", preventIdleSleep: true },
			});
			const settings = await Settings.init({ cwd: projectDir, agentDir });
			expect(settings.get("power.sleepPrevention")).toBe("off");
		});

		describe("provider request limits", () => {
			it("uses the effective merged value when configuring hooks", async () => {
				const settings = Settings.isolated({ "providers.maxInFlightRequests": { openai: 1 } });
				__providerInFlightForTesting.setRoot(tempDir.join("provider-inflight"));
				registerMockApi();
				const firstStarted = Promise.withResolvers<void>();
				const releaseFirst = Promise.withResolvers<void>();
				let active = 0;
				let maxActive = 0;
				let callIndex = 0;
				const mock = createMockModel({
					provider: "openai",
					handler: async () => {
						callIndex++;
						active++;
						maxActive = Math.max(maxActive, active);
						try {
							if (callIndex === 1) {
								firstStarted.resolve();
								await releaseFirst.promise;
							}
							return { content: [`reply ${callIndex}`] };
						} finally {
							active--;
						}
					},
				});

				settings.set("providers.maxInFlightRequests", { openai: 4 });

				const first = streamSimple(mock.model, context());
				const firstResult = first.result();
				await firstStarted.promise;
				const second = streamSimple(mock.model, context());
				await Bun.sleep(20);

				expect(settings.get("providers.maxInFlightRequests")).toEqual({ openai: 1 });
				expect(mock.calls).toHaveLength(1);

				releaseFirst.resolve();
				await Promise.all([firstResult, second.result()]);
				expect(maxActive).toBe(1);
			});

			it("rejects invalid provider limits from config.yml", async () => {
				await writeSettings({ providers: { maxInFlightRequests: { openai: "2" } } });

				await expect(Settings.init({ cwd: projectDir, agentDir })).rejects.toThrow(
					"Provider request limits must be positive numbers: openai",
				);
			});

			it("rejects invalid provider limits from project settings", async () => {
				await Bun.write(
					path.join(getProjectAgentDir(projectDir), "settings.json"),
					JSON.stringify({ providers: { maxInFlightRequests: { anthropic: 0 } } }),
				);

				await expect(Settings.init({ cwd: projectDir, agentDir, inMemory: true })).rejects.toThrow(
					"Provider request limits must be positive numbers: anthropic",
				);
			});

			it("rejects invalid provider limits from config overlays", async () => {
				const overlayPath = tempDir.join("overlay.yml");
				await Bun.write(overlayPath, YAML.stringify({ providers: { maxInFlightRequests: { umans: -1 } } }));

				await expect(
					Settings.init({ cwd: projectDir, agentDir, inMemory: true, configFiles: [overlayPath] }),
				).rejects.toThrow("Provider request limits must be positive numbers: umans");
			});
		});
	});
});
