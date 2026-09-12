import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * WHY: three load-time migrations in config/settings.ts read one spelling of a
 * retired key and left the other behind, or applied a boolean after the enum it
 * was retired in favour of. `hindsight.dynamicBankId` / `hindsight.agentName`
 * written flat (the spelling `config set` produces) were never mapped and
 * survived every rewrite as dead entries; removing `providers.parallelFetch`
 * left `providers: {}`; a nested `task.isolation.enabled: true` overwrote an
 * explicit `task.isolation.mode`. The class: a retired key whose migration
 * reads only the nested spelling, or forgets the parent it empties, or lets a
 * coarser legacy key override a finer one. Each case loads through
 * `Settings.init`, rewrites the file the way a session does, and reads the
 * persisted YAML back. It does not sweep every retired key in `migrate()`;
 * only the three shapes named here are pinned.
 */
describe("a retired setting leaves no dead key in the rewritten config", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-retired-setting-migration-");
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

	async function loadAndRewrite(raw: Record<string, unknown>): Promise<{ settings: Settings; persisted: unknown }> {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await settings.set("ask.notify", "on");
		await settings.flush?.();
		const persisted: unknown = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"));
		return { settings, persisted };
	}

	it.each([
		["nested", { hindsight: { dynamicBankId: true, agentName: "ada-cli" } }],
		["flat", { "hindsight.dynamicBankId": true, "hindsight.agentName": "ada-cli" }],
	])("%s legacy hindsight keys map to scoping and bankId and are dropped", async (_shape, raw) => {
		const { settings, persisted } = await loadAndRewrite(raw);
		expect(settings.get("hindsight.scoping")).toBe("per-project");
		expect(settings.get("hindsight.bankId")).toBe("ada-cli");
		const file = persisted as Record<string, unknown>;
		expect(file["hindsight.dynamicBankId"]).toBeUndefined();
		expect(file["hindsight.agentName"]).toBeUndefined();
		expect(file.hindsight).toEqual({ scoping: "per-project", bankId: "ada-cli" });
	});

	it("a flat legacy hindsight key never overrides the nested destination it maps to", async () => {
		const { settings, persisted } = await loadAndRewrite({
			hindsight: { scoping: "global", bankId: "kept" },
			"hindsight.dynamicBankId": true,
			"hindsight.agentName": "ignored",
		});
		expect(settings.get("hindsight.scoping")).toBe("global");
		expect(settings.get("hindsight.bankId")).toBe("kept");
		expect((persisted as Record<string, unknown>).hindsight).toEqual({ scoping: "global", bankId: "kept" });
	});

	it("removing providers.parallelFetch removes the providers section it emptied", async () => {
		const { persisted } = await loadAndRewrite({ providers: { parallelFetch: true } });
		expect(persisted as Record<string, unknown>).not.toHaveProperty("providers");
	});

	it("removing providers.parallelFetch keeps a providers section that still holds a value", async () => {
		const { settings, persisted } = await loadAndRewrite({ providers: { parallelFetch: true, fetch: "native" } });
		expect(settings.get("providers.fetch")).toBe("native");
		expect((persisted as Record<string, unknown>).providers).toEqual({ fetch: "native" });
	});

	it("an explicit nested task.isolation.mode wins over the retired enabled flag", async () => {
		const { settings } = await loadAndRewrite({ task: { isolation: { enabled: true, mode: "worktree" } } });
		expect(settings.get("agent.isolation.mode")).toBe("rcopy");
	});

	it("the retired enabled flag alone still selects auto", async () => {
		const { settings } = await loadAndRewrite({ task: { isolation: { enabled: true } } });
		expect(settings.get("agent.isolation.mode")).toBe("auto");
	});
});
