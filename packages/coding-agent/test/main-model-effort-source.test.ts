/**
 * Startup must preserve the origin of a thinking choice.
 *
 * A `:level` on `--model` is a selector pin: it wins for that selection but is
 * not a session-wide `/thinking` override. Only `--thinking` is session-wide.
 * Scoped entries likewise retain whether their level came from a suffix instead
 * of snapshotting Default Effort, so later Ctrl+P switches can read live rows.
 */
import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import type { ScopedModel } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { buildSessionOptions } from "@veyyon/coding-agent/main";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("expected bundled Claude Sonnet 4.5");

const registry = {
	getAll: () => [model],
	hasConfiguredAuth: () => true,
} as unknown as ModelRegistry;

describe("main model effort provenance", () => {
	it("marks a --model effort suffix as selector-owned", async () => {
		const parsed = parseArgs(["--model", `${model.provider}/${model.id}:high`]);
		const options = await buildSessionOptions(parsed, [], undefined, registry, Settings.isolated({}));

		expect(options.thinkingLevel).toBe(ThinkingLevel.High);
		expect(options.thinkingSource).toBe("selector");
	});

	it("reserves session provenance for an explicit --thinking flag", async () => {
		const parsed = parseArgs(["--model", `${model.provider}/${model.id}:high`, "--thinking", ThinkingLevel.Low]);
		const options = await buildSessionOptions(parsed, [], undefined, registry, Settings.isolated({}));

		expect(options.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(options.thinkingSource).toBe("session");
	});

	it("does not bake current Default Effort into unsuffixed scoped models", async () => {
		const scoped: ScopedModel[] = [
			{ model, thinkingLevel: undefined, explicitThinkingLevel: false },
			{
				model: { ...model, id: `${model.id}-explicit` },
				thinkingLevel: ThinkingLevel.High,
				explicitThinkingLevel: true,
			},
		];
		const parsed = parseArgs(["--models", `${model.provider}/${model.id}`]);
		const options = await buildSessionOptions(
			parsed,
			scoped,
			undefined,
			registry,
			Settings.isolated({ defaultEffort: { [`${model.provider}/${model.id}`]: ThinkingLevel.Low } }),
		);

		expect(options.scopedModels).toEqual([
			{ model, thinkingLevel: undefined, explicitThinkingLevel: false },
			{ model: scoped[1].model, thinkingLevel: ThinkingLevel.High, explicitThinkingLevel: true },
		]);
	});
});
