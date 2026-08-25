import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
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
});
