import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getPathsForTab,
	getUi,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	Settings,
} from "@veyyon/coding-agent/config/settings";
import { GLOBAL_SETTING_BINDINGS } from "@veyyon/coding-agent/config/settings-domains/global";
import { getGlobalConfigRootDir, resolveGlobalDefaultProfile, resolveGlobalProfileSharing } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

// PROF-2 (Global settings tab) + PROF-3 (all config surfaced in interactive
// settings, always synced). The Global tab is backed by ~/.veyyon/config.yml and
// routes through GLOBAL_SETTING_BINDINGS, never the per-profile store.

describe("Global settings tab coherence (PROF-2/PROF-3)", () => {
	it("registers the Global tab last in the tab order (per-profile tabs land first)", () => {
		expect(SETTING_TABS).toContain("global");
		// Global is the machine-wide scope; it sits last so /settings still opens
		// on the everyday per-profile view (Appearance), not the rarely-touched
		// cross-profile config.
		expect(SETTING_TABS.at(-1)).toBe("global");
		expect(SETTING_TABS[0]).toBe("appearance");
	});

	it("every global-scoped setting has a binding, and every binding is a global-scoped schema key", () => {
		const scopedGlobalPaths = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(
			path => getUi(path)?.scope === "global",
		);
		// PROF-3 gate: a scope:"global" setting without a binding would silently
		// fail to persist. Every one must be wired.
		for (const path of scopedGlobalPaths) {
			expect(GLOBAL_SETTING_BINDINGS[path]).toBeDefined();
			expect(getUi(path)?.tab).toBe("global");
		}
		// And no binding may exist without a matching global-scoped schema entry.
		for (const path of Object.keys(GLOBAL_SETTING_BINDINGS)) {
			expect(SETTINGS_SCHEMA[path as SettingPath]).toBeDefined();
			expect(getUi(path as SettingPath)?.scope).toBe("global");
		}
		// The tab is not empty, and its paths are exactly the global-scoped set.
		expect(new Set(getPathsForTab("global"))).toEqual(new Set(scopedGlobalPaths));
		expect(scopedGlobalPaths.length).toBeGreaterThan(0);
	});
});

describe("Global settings persistence (PROF-2)", () => {
	let settingsState: SettingsTestState | undefined;
	let root = "";
	let agentDir = "";

	beforeEach(() => {
		settingsState = beginSettingsTest();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-global-tab-"));
		// Point the global config root into the temp tree (same technique as
		// global-config.test.ts) so writes never touch the real ~/.veyyon.
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), root);
		agentDir = path.join(root, "profiles", "work", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		fs.rmSync(root, { recursive: true, force: true });
	});

	const globalConfigPath = () => path.join(getGlobalConfigRootDir(), "config.yml");
	const profileConfigPath = () => path.join(agentDir, "config.yml");

	it("writes profileSharing to the global config, not the profile config, and reads it back", async () => {
		const settings = await Settings.init({ cwd: root, agentDir });
		expect(settings.get("profileSharing")).toBe(true);

		settings.set("profileSharing", false);

		// Landed in the global config file...
		expect(fs.readFileSync(globalConfigPath(), "utf8")).toContain("profileSharing: false");
		// ...and the canonical global reader agrees.
		expect(resolveGlobalProfileSharing()).toBe(false);
		// ...and NOT in the per-profile config.
		const profileText = fs.existsSync(profileConfigPath()) ? fs.readFileSync(profileConfigPath(), "utf8") : "";
		expect(profileText).not.toContain("profileSharing");
		// ...and a live get reflects it.
		expect(settings.get("profileSharing")).toBe(false);
	});

	it("routes defaultProfile to the global config and clears on the default name", async () => {
		const settings = await Settings.init({ cwd: root, agentDir });
		expect(settings.get("defaultProfile")).toBe("default");

		settings.set("defaultProfile", "work");
		expect(resolveGlobalDefaultProfile()).toBe("work");
		expect(settings.get("defaultProfile")).toBe("work");

		// Setting back to the default profile name clears the override.
		settings.set("defaultProfile", "default");
		expect(resolveGlobalDefaultProfile()).toBeUndefined();
		expect(settings.get("defaultProfile")).toBe("default");
	});

	it("stays synced with an external edit to the global config (no restart)", async () => {
		const settings = await Settings.init({ cwd: root, agentDir });
		expect(settings.get("profileSharing")).toBe(true);

		// Simulate the user hand-editing ~/.veyyon/config.yml while the app runs.
		fs.mkdirSync(getGlobalConfigRootDir(), { recursive: true });
		fs.writeFileSync(globalConfigPath(), "profileSharing: false\n");

		// The next read reflects it because global settings are read live, never cached.
		expect(settings.get("profileSharing")).toBe(false);
	});
});
