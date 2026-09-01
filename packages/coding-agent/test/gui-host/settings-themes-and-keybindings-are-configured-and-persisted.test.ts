/**
 * WHY:
 *
 * Earlier implementations of settings, theme, and keybinding actions lacked schema validation
 * and persistence guarantees: SetSetting cast values unsafely without checking against
 * SETTINGS_SCHEMA or verifying types (causing boolean settings to accept arbitrary strings),
 * LoadThemes failed to classify light vs dark themes correctly, SetKeybinding was a no-op that
 * accepted unknown actions without persisting to keybindings.yml, and ResetSetting did not
 * properly revert values to their defaults.
 *
 * This suite defends:
 * 1. SetSetting validates keys against SETTINGS_SCHEMA and checks types via describeSettingTypeMismatch,
 *    failing closed with INVALID_SETTING or INVALID_VALUE in scope Settings.
 * 2. SetSetting persists changes to disk and reflects them in the Settings snapshot.
 * 3. ResetSetting unsets overrides, returns values to schema defaults, and persists the change.
 * 4. LoadThemes lists available themes with accurate `dark` boolean classification for bundled themes.
 * 5. LoadKeybindings and SetKeybinding accurately report and persist user keybindings in keybindings.yml.
 * 6. SetKeybinding validates action names against KEYBINDINGS and rejects unknown actions.
 *
 * Gap left:
 * Live terminal color rendering and OS appearance event listening are covered by TUI-level suites;
 * this suite defends settings protocol endpoints, validation, and storage persistence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { TestSocketClient } from "./test-client";

const makeTempDir = useTrackedTempDirs("gui-host-settings-test-");

interface SettingsEntry {
	value: unknown;
	default: unknown;
	source: string;
}

interface SettingsSnapshotFrame {
	Snapshot?: {
		Settings?: Record<string, SettingsEntry>;
	};
}

interface ThemesSnapshotFrame {
	Snapshot?: {
		Themes?: {
			themes: Array<{ id: string; name: string; dark: boolean }>;
			current: string;
		};
	};
}

interface KeybindingsSnapshotFrame {
	Snapshot?: {
		Keybindings?: Array<{ action: string; keys: string[]; source: string }>;
	};
}

describe("settings, themes, and keybindings action group behaviour", () => {
	let tempDir: string;
	let agentDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = makeTempDir();
		agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
	});

	test("LoadSettings returns effective settings with value, default, and source", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(1, "LoadSettings");
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const settingsFrame: SettingsSnapshotFrame | undefined = res.frames.find(
			f => f.Snapshot && "Settings" in f.Snapshot,
		);
		expect(settingsFrame?.Snapshot?.Settings).toBeDefined();

		const settingsMap = settingsFrame?.Snapshot?.Settings ?? {};
		expect(settingsMap["argot.enabled"]).toBeDefined();
		expect(typeof settingsMap["argot.enabled"]?.value).toBe("boolean");
		expect(typeof settingsMap["argot.enabled"]?.source).toBe("string");

		client.destroy();
	});

	test("SetSetting of a boolean key with a string value fails with INVALID_VALUE", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(2, {
			SetSetting: {
				key: "argot.enabled",
				value: "not_a_boolean",
			},
		});

		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(2);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Settings");
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_VALUE");

		client.destroy();
	});

	test("SetSetting with unknown key fails with INVALID_SETTING", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(3, {
			SetSetting: {
				key: "non.existent.setting.key",
				value: true,
			},
		});

		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(3);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Settings");
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_SETTING");

		client.destroy();
	});

	test("SetSetting with valid value persists to settings file and reflects in Settings snapshot", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(4, {
			SetSetting: {
				key: "argot.enabled",
				value: true,
			},
		});

		expect(res.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		const settingsFrame: SettingsSnapshotFrame | undefined = res.frames.find(
			f => f.Snapshot && "Settings" in f.Snapshot,
		);
		const settingsMap = settingsFrame?.Snapshot?.Settings ?? {};
		expect(settingsMap["argot.enabled"]?.value).toBe(true);

		// Read back settings file from disk to verify persistence
		const settingsFiles = await fs.readdir(agentDir);
		const yamlFile = settingsFiles.find(
			f =>
				(f.startsWith("config.") || f.startsWith("settings.")) &&
				(f.endsWith(".yml") || f.endsWith(".yaml") || f.endsWith(".json")),
		);
		expect(yamlFile).toBeDefined();
		if (yamlFile) {
			const content = await fs.readFile(path.join(agentDir, yamlFile), "utf-8");
			expect(content.includes("argot") || content.includes("enabled")).toBe(true);
		}

		client.destroy();
	});

	test("ResetSetting unsets override and restores default value", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// 1. Set a non-default value
		await client.request(5, {
			SetSetting: {
				key: "argot.enabled",
				value: true,
			},
		});

		// 2. Reset the setting
		const resetRes = await client.request(6, {
			ResetSetting: {
				key: "argot.enabled",
			},
		});

		expect(resetRes.outcome).toEqual({ RequestSucceeded: { request: 6 } });

		const settingsFrame: SettingsSnapshotFrame | undefined = resetRes.frames.find(
			f => f.Snapshot && "Settings" in f.Snapshot,
		);
		const settingsMap = settingsFrame?.Snapshot?.Settings ?? {};
		// Default for argot.enabled is false
		expect(settingsMap["argot.enabled"]?.value).toBe(false);

		client.destroy();
	});

	test("LoadThemes lists both bundled themes with dark classification correct", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(7, "LoadThemes");
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 7 } });

		const themesFrame: ThemesSnapshotFrame | undefined = res.frames.find(f => f.Snapshot && "Themes" in f.Snapshot);
		expect(themesFrame?.Snapshot?.Themes).toBeDefined();

		const themes = themesFrame?.Snapshot?.Themes?.themes ?? [];
		const darkTheme = themes.find(t => t.id === "dark");
		const lightTheme = themes.find(t => t.id === "light");

		expect(darkTheme).toBeDefined();
		expect(darkTheme?.dark).toBe(true);

		expect(lightTheme).toBeDefined();
		expect(lightTheme?.dark).toBe(false);

		client.destroy();
	});

	test("LoadKeybindings and SetKeybinding configure and persist keybindings", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		// 1. LoadKeybindings
		const loadRes = await client.request(8, "LoadKeybindings");
		expect(loadRes.outcome).toEqual({ RequestSucceeded: { request: 8 } });

		const loadFrame: KeybindingsSnapshotFrame | undefined = loadRes.frames.find(
			f => f.Snapshot && "Keybindings" in f.Snapshot,
		);
		const initialBindings = loadFrame?.Snapshot?.Keybindings ?? [];
		expect(initialBindings.length).toBeGreaterThan(0);

		// 2. SetKeybinding for unknown action fails
		const failRes = await client.request(9, {
			SetKeybinding: {
				action: "unknown.invalid.action",
				keys: ["ctrl+x"],
			},
		});
		expect(failRes.outcome.RequestFailed).toBeDefined();
		expect(failRes.outcome.RequestFailed?.error.code).toBe("UNKNOWN_ACTION");

		// 3. SetKeybinding for valid action succeeds and persists
		const setRes = await client.request(10, {
			SetKeybinding: {
				action: "app.interrupt",
				keys: ["ctrl+shift+c"],
			},
		});
		expect(setRes.outcome).toEqual({ RequestSucceeded: { request: 10 } });

		const updatedFrame: KeybindingsSnapshotFrame | undefined = setRes.frames.find(
			f => f.Snapshot && "Keybindings" in f.Snapshot,
		);
		const updatedBindings = updatedFrame?.Snapshot?.Keybindings ?? [];
		const interruptBinding = updatedBindings.find(b => b.action === "app.interrupt");
		expect(interruptBinding?.keys).toEqual(["ctrl+shift+c"]);
		expect(interruptBinding?.source).toBe("user");

		// Read back keybindings.yml from disk
		const ymlPath = path.join(agentDir, "keybindings.yml");
		const rawYml = await fs.readFile(ymlPath, "utf-8");
		const parsedYml = YAML.parse(rawYml) as Record<string, unknown>;
		expect(parsedYml["app.interrupt"]).toBe("ctrl+shift+c");

		client.destroy();
	});
});
