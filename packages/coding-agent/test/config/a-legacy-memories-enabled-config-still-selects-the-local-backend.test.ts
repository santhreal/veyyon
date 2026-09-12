import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { resolveMemoryBackend } from "@veyyon/coding-agent/memory/resolve";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * WHY: `memories.enabled` is no longer a declared setting and nothing at run
 * time reads it; the load-time migration in config/settings.ts is the only path
 * by which a config written before `memory.backend` existed still turns the
 * local pipeline on. This suite loads such a config through `Settings.init`
 * and asserts the backend the runtime resolves, so removing the migration, or
 * reading the legacy key again instead of the enum, goes red. It covers the
 * nested and dotted legacy shapes, precedence of an explicit backend, and
 * removal of the legacy key on rewrite. It does not cover a config that sets
 * the key to a non-boolean, which the migration ignores and the schema drops.
 */
describe("a legacy memories.enabled config still selects the local backend", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-memories-enabled-migration-");
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

	it.each([
		["nested", { memories: { enabled: true } }],
		["dotted", { "memories.enabled": true }],
	])("a %s legacy true becomes memory.backend local and the runtime resolves it", async (_shape, raw) => {
		const settings = await loadWith(raw);
		expect(settings.get("memory.backend")).toBe("local");
		expect((await resolveMemoryBackend(settings)).id).toBe("local");
	});

	it("a legacy false becomes memory.backend off", async () => {
		const settings = await loadWith({ memories: { enabled: false, threadScanLimit: 12 } });
		expect(settings.get("memory.backend")).toBe("off");
		expect(settings.get("memories.threadScanLimit")).toBe(12);
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("an explicit memory.backend wins over the legacy flag", async () => {
		const settings = await loadWith({ memory: { backend: "off" }, memories: { enabled: true } });
		expect(settings.get("memory.backend")).toBe("off");
		expect((await resolveMemoryBackend(settings)).id).toBe("off");
	});

	it("the legacy key is dropped on rewrite and the enum persists", async () => {
		const settings = await loadWith({ memories: { enabled: true } });
		await settings.set("ask.notify", "on");
		await settings.flush?.();
		const persisted = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
		expect(persisted).not.toContain("enabled:");
		expect(persisted).toContain("backend: local");
	});
});
