import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getAllSettingDefs, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * WHY: unified search retired per-engine enable keys and two text-context
 * keys. Search is part of the default inventory, so stale enable flags must not
 * disable it; context values and explicit tool-list choices still migrate. This
 * suite covers nested and dotted legacy shapes, canonical precedence, removal
 * on rewrite, and unconditional context-control visibility. It does not cover
 * malformed YAML, which belongs to the config parser.
 */
const SEARCH_SETTING_PATHS = ["search.contextBefore", "search.contextAfter"] as const;

function visibleSearchSettings(): string[] {
	invalidateSettingDefsCache();
	return getAllSettingDefs()
		.filter(def => (SEARCH_SETTING_PATHS as readonly string[]).includes(def.path))
		.filter(def => !def.condition || def.condition())
		.map(def => def.path);
}

describe("legacy search settings migrate to unified search", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-search-settings-migration-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	it("preserves legacy text context while discarding every enable flag", async () => {
		const settings = await loadWith({
			glob: { enabled: false },
			grep: { enabled: false, contextBefore: 2, contextAfter: 5 },
			astGrep: { enabled: false },
			search: { enabled: false },
		});

		expect(settings.get("search.contextBefore")).toBe(2);
		expect(settings.get("search.contextAfter")).toBe(5);
		await settings.set("ask.notify", "on");
		await settings.flush?.();
		const persisted = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
		expect(persisted).not.toContain("enabled: false");
	});

	it("accepts retired dotted context keys and migrates legacy tool lists", async () => {
		const settings = await loadWith({
			"grep.contextBefore": 3,
			"grep.contextAfter": 10,
			tools: { essentialOverride: ["read", "glob", "grep", "ast_grep", "search"] },
		});

		expect(settings.get("search.contextBefore")).toBe(3);
		expect(settings.get("search.contextAfter")).toBe(10);
		expect(settings.get("tools.essentialOverride")).toEqual(["read", "search"]);
	});

	it("lets canonical values win and removes retired keys on rewrite", async () => {
		const settings = await loadWith({
			search: { enabled: false, contextBefore: 0, contextAfter: 1 },
			glob: { enabled: false },
			grep: { enabled: false, contextBefore: 5, contextAfter: 10 },
			astGrep: { enabled: false },
		});

		expect(settings.get("search.contextBefore")).toBe(0);
		expect(settings.get("search.contextAfter")).toBe(1);
		await settings.set("ask.notify", "on");
		await settings.flush?.();
		const persisted = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
		expect(persisted).not.toContain("glob:");
		expect(persisted).not.toContain("grep:");
		expect(persisted).not.toContain("astGrep:");
		expect(persisted).not.toContain("search:\n  enabled:");
	});

	it("lets canonical dotted context values win over retired nested settings", async () => {
		const settings = await loadWith({
			"search.enabled": false,
			"search.contextBefore": 7,
			"search.contextAfter": 8,
			grep: { enabled: true, contextBefore: 1, contextAfter: 2 },
		});

		expect(settings.get("search.contextBefore")).toBe(7);
		expect(settings.get("search.contextAfter")).toBe(8);
	});

	it("always shows both text-context controls", async () => {
		await loadWith({ search: { enabled: false } });
		expect(visibleSearchSettings()).toEqual(["search.contextBefore", "search.contextAfter"]);
	});
});
