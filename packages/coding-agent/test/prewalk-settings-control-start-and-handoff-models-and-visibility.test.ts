/**
 * WHY THIS SUITE EXISTS. Prewalk switches from a planning/start model to a fast
 * implementation model at the first turn that starts execution. Its behavior is
 * governed by three settings: `prewalk.enabled` (master toggle), `prewalk.cheapModel`
 * (the handoff target model), and `prewalk.strongModel` (the start model override).
 *
 * A setting that appears in defaults and schema tables but never reaches runtime
 * behavior is a dead knob. This suite asserts every declared prewalk setting end to end
 * against the real consumption paths:
 *   1. Startup launch wiring (`buildSessionOptions` in `main.ts`).
 *   2. Text-mode command handling (`/prewalk` slash-command in `builtin-registry.ts`).
 *   3. Settings selector visibility (`CONDITIONS.prewalkEnabled` in `settings-defs.ts`).
 *
 * Variants covered:
 *   - Runtime enumeration of all `prewalk.*` settings from `GENERAL_SETTINGS` and
 *     `SETTINGS_SCHEMA` so any newly added knob fails the suite until tested.
 *   - Declared defaults: `prewalk.enabled = false`, `prewalk.cheapModel = undefined`,
 *     `prewalk.strongModel = undefined`.
 *   - Non-default values change observable outcomes in launch options and command output.
 *   - CLI argument precedence: `--no-prewalk`, `--prewalk-into`, `--model`, `/prewalk <model>`.
 *   - Role alias expansion and comma-separated model chain normalization.
 *   - Fail-closed behavior: unset cheap target, unknown model IDs, unconfigured credentials.
 *   - Master-toggle condition gating: dependent knobs hide when off, reveal when on.
 *
 * What this does NOT catch:
 *   - In-turn prompt nudge injection and post-todo switch timing (covered by `agent-session-prewalk.test.ts`).
 *   - Model execution quality or token costs across LLM providers.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { GENERAL_SETTINGS } from "@veyyon/coding-agent/config/settings-domains/general";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { buildSessionOptions } from "@veyyon/coding-agent/main";
import { getAllSettingDefs, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { TempDir } from "@veyyon/utils";
import { stubStdoutGeometry } from "./helpers/stdout-geometry";

const STRONG_MODEL_ID = "anthropic/claude-sonnet-4-5";
const CHEAP_MODEL_ID = "anthropic/claude-sonnet-4-6";
const ALTERNATIVE_MODEL_ID = "anthropic/claude-opus-4-5";

const EXPECTED_PREWALK_SETTINGS = ["prewalk.cheapModel", "prewalk.enabled", "prewalk.strongModel"] as const;

describe("prewalk settings end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-prewalk-settings-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key-anthropic");
		resetSettingsForTest();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
		tempDir.removeSync();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function makeRegistry(): ModelRegistry {
		return new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	}

	function makeSlashCommandRuntime(registry: ModelRegistry, settings: Settings) {
		const armedTargets: Array<Model<Api>> = [];
		const outputLines: string[] = [];
		const armPrewalk = (target: Model<Api>) => {
			armedTargets.push(target);
		};
		const output = async (text: string) => {
			outputLines.push(text);
		};
		const runtime = {
			session: { modelRegistry: registry, armPrewalk },
			settings,
			output,
		} as unknown as SlashCommandRuntime;
		return { armedTargets, outputLines, runtime };
	}

	describe("1. schema enumeration and completeness", () => {
		it("enumerates all prewalk settings from GENERAL_SETTINGS and SETTINGS_SCHEMA", () => {
			const generalPrewalkKeys = Object.keys(GENERAL_SETTINGS)
				.filter(key => key.startsWith("prewalk.") || key === "prewalk")
				.sort();
			const schemaPrewalkKeys = Object.keys(SETTINGS_SCHEMA)
				.filter(key => key.startsWith("prewalk.") || key === "prewalk")
				.sort();

			expect(generalPrewalkKeys).toEqual([...EXPECTED_PREWALK_SETTINGS].sort());
			expect(schemaPrewalkKeys).toEqual([...EXPECTED_PREWALK_SETTINGS].sort());
		});

		it("declares exact schema types and defaults", () => {
			expect(GENERAL_SETTINGS["prewalk.enabled"].type).toBe("boolean");
			expect(GENERAL_SETTINGS["prewalk.enabled"].default).toBe(false);

			expect(GENERAL_SETTINGS["prewalk.cheapModel"].type).toBe("modelChain");
			expect(GENERAL_SETTINGS["prewalk.cheapModel"].default).toBeUndefined();

			expect(GENERAL_SETTINGS["prewalk.strongModel"].type).toBe("modelChain");
			expect(GENERAL_SETTINGS["prewalk.strongModel"].default).toBeUndefined();
		});
	});

	describe("2. declared defaults are honored", () => {
		it("prewalk.enabled defaults to false and leaves launch prewalk inactive", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({});
			expect(settings.get("prewalk.enabled")).toBe(false);

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(options.prewalk).toBeUndefined();
		});

		it("prewalk.cheapModel defaults to undefined and fails loud when prewalk is enabled", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({ "prewalk.enabled": true });
			expect(settings.get("prewalk.cheapModel")).toBeUndefined();

			await expect(buildSessionOptions(parseArgs([]), [], undefined, registry, settings)).rejects.toThrow(
				'Prewalk needs a cheap target model: set "prewalk.cheapModel" in settings or pass --prewalk-into <model>.',
			);
		});

		it("prewalk.cheapModel default undefined causes /prewalk slash command without args to fail closed", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({});
			const h = makeSlashCommandRuntime(registry, settings);

			await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

			expect(h.armedTargets).toHaveLength(0);
			expect(h.outputLines.length).toBeGreaterThan(0);
			expect(h.outputLines[0]).toContain(
				'Prewalk needs a cheap target model: run /prewalk <model> or set "prewalk.cheapModel" in settings.',
			);
		});

		it("prewalk.strongModel defaults to undefined and preserves normal start model", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
			});
			expect(settings.get("prewalk.strongModel")).toBeUndefined();

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(options.model).toBeUndefined();
			expect(options.prewalk?.target.id).toBe("claude-sonnet-4-6");
		});
	});

	describe("3. non-default values change observable runtime behavior", () => {
		it("setting prewalk.enabled: true activates prewalk with configured cheapModel", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
			});

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(options.prewalk).toBeDefined();
			expect(`${options.prewalk?.target.provider}/${options.prewalk?.target.id}`).toBe(CHEAP_MODEL_ID);
		});

		it("CLI flag --no-prewalk overrides prewalk.enabled: true", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
			});

			const options = await buildSessionOptions(parseArgs(["--no-prewalk"]), [], undefined, registry, settings);
			expect(options.prewalk).toBeUndefined();
		});

		it("changing prewalk.cheapModel changes the resolved prewalk target model", async () => {
			const registry = makeRegistry();

			const options1 = await buildSessionOptions(
				parseArgs(["--prewalk"]),
				[],
				undefined,
				registry,
				Settings.isolated({ "prewalk.cheapModel": CHEAP_MODEL_ID }),
			);
			expect(`${options1.prewalk?.target.provider}/${options1.prewalk?.target.id}`).toBe(CHEAP_MODEL_ID);

			const options2 = await buildSessionOptions(
				parseArgs(["--prewalk"]),
				[],
				undefined,
				registry,
				Settings.isolated({ "prewalk.cheapModel": ALTERNATIVE_MODEL_ID }),
			);
			expect(`${options2.prewalk?.target.provider}/${options2.prewalk?.target.id}`).toBe(ALTERNATIVE_MODEL_ID);
		});

		it("slash command /prewalk adopts the model configured in prewalk.cheapModel", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({ "prewalk.cheapModel": CHEAP_MODEL_ID });
			const h = makeSlashCommandRuntime(registry, settings);

			await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

			expect(h.armedTargets).toHaveLength(1);
			expect(`${h.armedTargets[0].provider}/${h.armedTargets[0].id}`).toBe(CHEAP_MODEL_ID);
			expect(h.outputLines[0]).toContain(`Prewalk on: switching to ${CHEAP_MODEL_ID}`);
		});

		it("slash command argument overrides prewalk.cheapModel setting", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({ "prewalk.cheapModel": CHEAP_MODEL_ID });
			const h = makeSlashCommandRuntime(registry, settings);

			await executeAcpBuiltinSlashCommand(`/prewalk ${ALTERNATIVE_MODEL_ID}`, h.runtime);

			expect(h.armedTargets).toHaveLength(1);
			expect(`${h.armedTargets[0].provider}/${h.armedTargets[0].id}`).toBe(ALTERNATIVE_MODEL_ID);
		});

		it("CLI flag --prewalk-into overrides prewalk.cheapModel setting", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
			});

			const options = await buildSessionOptions(
				parseArgs(["--prewalk-into", ALTERNATIVE_MODEL_ID]),
				[],
				undefined,
				registry,
				settings,
			);
			expect(`${options.prewalk?.target.provider}/${options.prewalk?.target.id}`).toBe(ALTERNATIVE_MODEL_ID);
		});

		it("resolves role alias in prewalk.cheapModel", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": "@smol",
				modelRoles: { smol: CHEAP_MODEL_ID },
			});

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(`${options.prewalk?.target.provider}/${options.prewalk?.target.id}`).toBe(CHEAP_MODEL_ID);
		});

		it("normalizes comma-separated model chain in prewalk.cheapModel to the first entry", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": `${CHEAP_MODEL_ID}, ${ALTERNATIVE_MODEL_ID}`,
			});

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(`${options.prewalk?.target.provider}/${options.prewalk?.target.id}`).toBe(CHEAP_MODEL_ID);
		});

		it("changing prewalk.strongModel changes the start model when prewalk is enabled", async () => {
			const registry = makeRegistry();

			const options1 = await buildSessionOptions(
				parseArgs([]),
				[],
				undefined,
				registry,
				Settings.isolated({
					"prewalk.enabled": true,
					"prewalk.cheapModel": CHEAP_MODEL_ID,
					"prewalk.strongModel": STRONG_MODEL_ID,
				}),
			);
			expect(options1.model && `${options1.model.provider}/${options1.model.id}`).toBe(STRONG_MODEL_ID);

			const options2 = await buildSessionOptions(
				parseArgs([]),
				[],
				undefined,
				registry,
				Settings.isolated({
					"prewalk.enabled": true,
					"prewalk.cheapModel": CHEAP_MODEL_ID,
					"prewalk.strongModel": ALTERNATIVE_MODEL_ID,
				}),
			);
			expect(options2.model && `${options2.model.provider}/${options2.model.id}`).toBe(ALTERNATIVE_MODEL_ID);
		});

		it("prewalk.strongModel is inert when prewalk is disabled", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": false,
				"prewalk.strongModel": STRONG_MODEL_ID,
			});

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(options.model).toBeUndefined();
			expect(options.prewalk).toBeUndefined();
		});

		it("CLI flag --model overrides prewalk.strongModel", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
				"prewalk.strongModel": STRONG_MODEL_ID,
			});

			const options = await buildSessionOptions(
				parseArgs(["--model", ALTERNATIVE_MODEL_ID]),
				[],
				undefined,
				registry,
				settings,
			);
			expect(options.model && `${options.model.provider}/${options.model.id}`).toBe(ALTERNATIVE_MODEL_ID);
		});

		it("resolves role alias in prewalk.strongModel", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
				"prewalk.strongModel": "@heavy",
				modelRoles: { heavy: STRONG_MODEL_ID },
			});

			const options = await buildSessionOptions(parseArgs([]), [], undefined, registry, settings);
			expect(options.model && `${options.model.provider}/${options.model.id}`).toBe(STRONG_MODEL_ID);
		});

		it("resumed session preserves lineage and ignores prewalk.strongModel start override", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
				"prewalk.strongModel": STRONG_MODEL_ID,
			});

			const options = await buildSessionOptions(parseArgs(["--resume"]), [], undefined, registry, settings);
			expect(options.model).toBeUndefined();
		});
	});

	describe("4. invalid values fail loud", () => {
		it("fails loud when prewalk.cheapModel specifies an unknown model", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": "nonexistent-provider/unknown-model",
			});

			await expect(buildSessionOptions(parseArgs([]), [], undefined, registry, settings)).rejects.toThrow();
		});

		it("slash command /prewalk fails loud with usage error when prewalk.cheapModel is an unknown model", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({ "prewalk.cheapModel": "nonexistent-provider/unknown-model" });
			const h = makeSlashCommandRuntime(registry, settings);

			await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

			expect(h.armedTargets).toHaveLength(0);
			expect(h.outputLines.length).toBeGreaterThan(0);
			expect(h.outputLines[0]).toMatch(/unknown model|could not resolve|not found/i);
		});

		it("fails loud when prewalk.cheapModel specifies a model without configured credentials", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": "openai/gpt-5-mini",
			});

			await expect(buildSessionOptions(parseArgs([]), [], undefined, registry, settings)).rejects.toThrow(
				/api key/i,
			);
		});

		it("slash command /prewalk fails loud when target has unconfigured credentials", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({ "prewalk.cheapModel": "openai/gpt-5-mini" });
			const h = makeSlashCommandRuntime(registry, settings);

			await executeAcpBuiltinSlashCommand("/prewalk", h.runtime);

			expect(h.armedTargets).toHaveLength(0);
			expect(h.outputLines.length).toBeGreaterThan(0);
			expect(h.outputLines[0]).toMatch(/api key|credentials|environment variable/i);
		});

		it("fails loud when prewalk.strongModel specifies an unknown model", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
				"prewalk.strongModel": "nonexistent-provider/unknown-model",
			});

			await expect(buildSessionOptions(parseArgs([]), [], undefined, registry, settings)).rejects.toThrow();
		});

		it("fails loud when prewalk.strongModel specifies a model without credentials", async () => {
			const registry = makeRegistry();
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.cheapModel": CHEAP_MODEL_ID,
				"prewalk.strongModel": "openai/gpt-5-mini",
			});

			await expect(buildSessionOptions(parseArgs([]), [], undefined, registry, settings)).rejects.toThrow(
				/api key/i,
			);
		});
	});

	describe("5. dependent-knob visibility via real selector and conditions", () => {
		function getVisiblePrewalkSettingPaths(): string[] {
			invalidateSettingDefsCache();
			return getAllSettingDefs()
				.filter(def =>
					(EXPECTED_PREWALK_SETTINGS as readonly string[]).includes(
						def.path as (typeof EXPECTED_PREWALK_SETTINGS)[number],
					),
				)
				.filter(def => !def.condition || def.condition())
				.map(def => def.path);
		}

		it("hides dependent knobs when prewalk.enabled is false (default)", async () => {
			await initTheme();
			const stub = stubStdoutGeometry({ columns: 160, rows: 40 });
			try {
				resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "prewalk.enabled": false } });

				expect(getVisiblePrewalkSettingPaths()).toEqual(["prewalk.enabled"]);

				const selector = new SettingsSelectorComponent(
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
				selector.openTab("model");

				expect(selector.selectSetting("prewalk.enabled")).toBe(true);
				expect(selector.selectSetting("prewalk.cheapModel")).toBe(false);
				expect(selector.selectSetting("prewalk.strongModel")).toBe(false);
			} finally {
				stub.restore();
				resetSettingsForTest();
			}
		});

		it("reveals dependent knobs when prewalk.enabled is true", async () => {
			await initTheme();
			const stub = stubStdoutGeometry({ columns: 160, rows: 40 });
			try {
				resetSettingsForTest();
				await Settings.init({ inMemory: true, overrides: { "prewalk.enabled": true } });

				expect(getVisiblePrewalkSettingPaths().sort()).toEqual([...EXPECTED_PREWALK_SETTINGS].sort());

				const selector = new SettingsSelectorComponent(
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
				selector.openTab("model");

				expect(selector.selectSetting("prewalk.enabled")).toBe(true);
				expect(selector.selectSetting("prewalk.cheapModel")).toBe(true);
				expect(selector.selectSetting("prewalk.strongModel")).toBe(true);
			} finally {
				stub.restore();
				resetSettingsForTest();
			}
		});
	});
});
