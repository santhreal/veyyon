import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../helpers/stdout-geometry";
import { buildSessionOptions } from "@veyyon/coding-agent/main";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { TempDir } from "@veyyon/utils";

/**
 * WHY THIS SUITE EXISTS. `/prewalk` used to hardcode the `@smol` role alias as
 * its target. An unset role stopped resolving to any model (#980 fail-closed),
 * so the command died for every operator who had not assigned the role — and
 * there was no way to name a target without relaunching with `--prewalk-into`.
 *
 * The class this closes: a feature surface whose default derives from a role
 * alias rather than from a setting the operator can own. Prewalk now reads its
 * cheap target from `prewalk.cheapModel`, accepts `/prewalk <model>` as a
 * per-session override, and refuses with the corrective action when neither
 * names a model. Any sibling that reverts to an alias-only default fails the
 * first two cases here.
 *
 * Also caught: the `--prewalk` launch path in main.ts, which mirrors this
 * resolution through `buildSessionOptions` and read the same settings past the
 * resolver without handing them over. Plan-yolo expands its alias itself before
 * resolving and is untouched by this change.
 */
describe("/prewalk resolves its cheap target", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	const STRONG = "anthropic/claude-sonnet-4-5";
	const CHEAP = "anthropic/claude-sonnet-4-6";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prewalk-target-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		authStorage.close();
		tempDir.removeSync();
	});

	function makeRegistry(): ModelRegistry {
		return new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	}

	function makeRuntime(registry: ModelRegistry, settings: Settings) {
		const armPrewalk = vi.fn<(target: Model<Api>, thinkingLevel?: unknown) => void>();
		const output = vi.fn<(text: string) => Promise<void>>(async _text => {});
		const runtime = {
			session: { modelRegistry: registry, armPrewalk },
			settings,
			output,
		} as unknown as SlashCommandRuntime;
		return { armPrewalk, output, runtime };
	}

	it("arms with the model named as the command argument when no setting exists", async () => {
		const registry = makeRegistry();
		// No prewalk.cheapModel anywhere — the argument is the only target named.
		const h = makeRuntime(registry, Settings.isolated({}));
		await executeAcpBuiltinSlashCommand(`/prewalk ${CHEAP}`, h.runtime);

		expect(h.armPrewalk).toHaveBeenCalledTimes(1);
		const [target] = h.armPrewalk.mock.calls[0] as unknown as [Model<Api>];
		expect(`${target.provider}/${target.id}`).toBe(CHEAP);
		expect(h.output.mock.calls.map(call => String(call[0])).join("\n")).toContain(CHEAP);
	});

	it("falls back to prewalk.cheapModel when the command carries no argument", async () => {
		const registry = makeRegistry();
		const h = makeRuntime(registry, Settings.isolated({ "prewalk.cheapModel": CHEAP }));
		await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

		expect(h.armPrewalk).toHaveBeenCalledTimes(1);
		const [target] = h.armPrewalk.mock.calls[0] as unknown as [Model<Api>];
		expect(`${target.provider}/${target.id}`).toBe(CHEAP);
	});

	it("refuses with the corrective action when neither argument nor setting names a target", async () => {
		const registry = makeRegistry();
		const h = makeRuntime(registry, Settings.isolated({}));
		await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

		expect(h.armPrewalk).not.toHaveBeenCalled();
		const said = h.output.mock.calls.map(call => String(call[0])).join("\n");
		expect(said).toContain("prewalk.cheapModel");
	});

	it("keeps the argument stronger than the setting", async () => {
		const registry = makeRegistry();
		const h = makeRuntime(registry, Settings.isolated({ "prewalk.cheapModel": STRONG }));
		await executeAcpBuiltinSlashCommand(`/prewalk ${CHEAP}`, h.runtime);

		const [target] = h.armPrewalk.mock.calls[0] as unknown as [Model<Api>];
		expect(`${target.provider}/${target.id}`).toBe(CHEAP);
	});

	it("reports missing credentials instead of arming a target no provider can call", async () => {
		const registry = makeRegistry();
		// Only anthropic holds a key; the openai target must be refused.
		const h = makeRuntime(registry, Settings.isolated({}));
		await executeAcpBuiltinSlashCommand("/prewalk openai/gpt-5-mini", h.runtime);

		expect(h.armPrewalk).not.toHaveBeenCalled();
		const said = h.output.mock.calls.map(call => String(call[0])).join("\n");
		expect(said.toLowerCase()).toContain("api key");
	});
	it("resolves a configured role alias passed via prewalk.cheapModel setting", async () => {
		const registry = makeRegistry();
		const settings = Settings.isolated({ "prewalk.cheapModel": "@smol" });
		settings.setModelRole("smol", CHEAP);
		const h = makeRuntime(registry, settings);
		await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

		expect(h.armPrewalk).toHaveBeenCalledTimes(1);
		const [target] = h.armPrewalk.mock.calls[0] as unknown as [Model<Api>];
		expect(`${target.provider}/${target.id}`).toBe(CHEAP);
	});

	it("resolves a configured role alias passed as slash command argument", async () => {
		const registry = makeRegistry();
		const settings = Settings.isolated({});
		settings.setModelRole("smol", CHEAP);
		const h = makeRuntime(registry, settings);
		await executeAcpBuiltinSlashCommand("/prewalk @smol", h.runtime);

		expect(h.armPrewalk).toHaveBeenCalledTimes(1);
		const [target] = h.armPrewalk.mock.calls[0] as unknown as [Model<Api>];
		expect(`${target.provider}/${target.id}`).toBe(CHEAP);
	});

	it("resolves a role alias in prewalk.cheapModel at launch", async () => {
		const registry = makeRegistry();
		const settings = Settings.isolated({ "prewalk.cheapModel": "@smol" });
		settings.setModelRole("smol", CHEAP);
		const parsed = parseArgs(["--prewalk"]);

		const options = await buildSessionOptions(parsed, [], undefined, registry, settings);

		const target = options.prewalk?.target;
		expect(target && `${target.provider}/${target.id}`).toBe(CHEAP);
	});

	it("resolves a role alias passed to --prewalk-into", async () => {
		const registry = makeRegistry();
		const settings = Settings.isolated({});
		settings.setModelRole("smol", CHEAP);
		const parsed = parseArgs(["--prewalk-into", "@smol"]);

		const options = await buildSessionOptions(parsed, [], undefined, registry, settings);

		const target = options.prewalk?.target;
		expect(target && `${target.provider}/${target.id}`).toBe(CHEAP);
	});

	it("resolves a role alias in prewalk.strongModel as the start model", async () => {
		const registry = makeRegistry();
		const settings = Settings.isolated({ "prewalk.cheapModel": CHEAP, "prewalk.strongModel": "@big" });
		settings.setModelRole("big", STRONG);
		const parsed = parseArgs(["--prewalk"]);

		const options = await buildSessionOptions(parsed, [], undefined, registry, settings);

		expect(options.model && `${options.model.provider}/${options.model.id}`).toBe(STRONG);
	});
	it("honors prewalk.cheapModel and prewalk.strongModel defaults at launch", async () => {
		const registry = makeRegistry();
		const parsed = parseArgs(["--prewalk"]);

		// When prewalk.cheapModel is unset (default), --prewalk launch fails loud
		await expect(buildSessionOptions(parsed, [], undefined, registry, Settings.isolated({}))).rejects.toThrow(
			'Prewalk needs a cheap target model: set "prewalk.cheapModel" in settings or pass --prewalk-into <model>.',
		);

		// When prewalk.strongModel is unset (default), options.model is not overridden
		const options = await buildSessionOptions(
			parsed,
			[],
			undefined,
			registry,
			Settings.isolated({ "prewalk.cheapModel": CHEAP }),
		);
		expect(options.model).toBeUndefined();
		expect(options.prewalk?.target && `${options.prewalk.target.provider}/${options.prewalk.target.id}`).toBe(CHEAP);
	});

	it("changes resolved models when non-default values are configured", async () => {
		const registry = makeRegistry();
		const parsed = parseArgs(["--prewalk"]);

		// Non-default cheapModel changes resolved prewalk target
		const optionsCheap1 = await buildSessionOptions(
			parsed,
			[],
			undefined,
			registry,
			Settings.isolated({ "prewalk.cheapModel": CHEAP }),
		);
		expect(
			optionsCheap1.prewalk?.target &&
				`${optionsCheap1.prewalk.target.provider}/${optionsCheap1.prewalk.target.id}`,
		).toBe(CHEAP);

		const optionsCheap2 = await buildSessionOptions(
			parsed,
			[],
			undefined,
			registry,
			Settings.isolated({ "prewalk.cheapModel": STRONG }),
		);
		expect(
			optionsCheap2.prewalk?.target &&
				`${optionsCheap2.prewalk.target.provider}/${optionsCheap2.prewalk.target.id}`,
		).toBe(STRONG);

		// Non-default strongModel changes resolved start model
		const optionsStrong1 = await buildSessionOptions(
			parsed,
			[],
			undefined,
			registry,
			Settings.isolated({ "prewalk.cheapModel": CHEAP, "prewalk.strongModel": STRONG }),
		);
		expect(optionsStrong1.model && `${optionsStrong1.model.provider}/${optionsStrong1.model.id}`).toBe(STRONG);

		const optionsStrong2 = await buildSessionOptions(
			parsed,
			[],
			undefined,
			registry,
			Settings.isolated({ "prewalk.cheapModel": CHEAP, "prewalk.strongModel": CHEAP }),
		);
		expect(optionsStrong2.model && `${optionsStrong2.model.provider}/${optionsStrong2.model.id}`).toBe(CHEAP);
	});

	it("fails loud on invalid prewalk.cheapModel or prewalk.strongModel values", async () => {
		const registry = makeRegistry();
		const parsed = parseArgs(["--prewalk"]);

		// Unknown model for cheapModel throws
		await expect(
			buildSessionOptions(
				parsed,
				[],
				undefined,
				registry,
				Settings.isolated({ "prewalk.cheapModel": "nonexistent/invalid-model" }),
			),
		).rejects.toThrow();

		// Missing credentials for cheapModel throws
		await expect(
			buildSessionOptions(
				parsed,
				[],
				undefined,
				registry,
				Settings.isolated({ "prewalk.cheapModel": "openai/gpt-5-mini" }),
			),
		).rejects.toThrow(/api key/i);

		// Unknown model for strongModel throws
		await expect(
			buildSessionOptions(
				parsed,
				[],
				undefined,
				registry,
				Settings.isolated({ "prewalk.cheapModel": CHEAP, "prewalk.strongModel": "nonexistent/invalid-model" }),
			),
		).rejects.toThrow();

		// Missing credentials for strongModel throws
		await expect(
			buildSessionOptions(
				parsed,
				[],
				undefined,
				registry,
				Settings.isolated({ "prewalk.cheapModel": CHEAP, "prewalk.strongModel": "openai/gpt-5-mini" }),
			),
		).rejects.toThrow(/api key/i);
	});

	it("hides prewalk.cheapModel and prewalk.strongModel from the settings selector while prewalk is off", async () => {
		await initTheme();
		const stub = stubStdoutGeometry({ columns: 160, rows: 40 });
		try {
			resetSettingsForTest();
			await Settings.init({ inMemory: true });

			const createSelector = () =>
				new SettingsSelectorComponent(
					{
						availableThinkingLevels: [],
						thinkingLevel: undefined,
						availableThemes: ["dark"],
						availablePersonalities: ["default"],
						providers: [],
						cwd: process.cwd(),
					},
					{
						onChange: () => {},
						onCancel: () => {},
					},
				);

			// Master toggle off (default) -> both knobs are hidden
			expect(Settings.instance.get("prewalk.enabled")).toBe(false);
			const selectorOff = createSelector();
			selectorOff.openTab("model");
			expect(selectorOff.selectSetting("prewalk.cheapModel")).toBe(false);
			expect(selectorOff.selectSetting("prewalk.strongModel")).toBe(false);

			// Master toggle on -> both knobs appear
			Settings.instance.set("prewalk.enabled", true);
			expect(Settings.instance.get("prewalk.enabled")).toBe(true);
			const selectorOn = createSelector();
			selectorOn.openTab("model");
			expect(selectorOn.selectSetting("prewalk.cheapModel")).toBe(true);
			expect(selectorOn.selectSetting("prewalk.strongModel")).toBe(true);
		} finally {
			stub.restore();
			resetSettingsForTest();
		}
	});
});
