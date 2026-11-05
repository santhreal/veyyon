/**
 * WHY: the eval `completion()` helper sent no effort unless the model selector carried a `:level`.
 * The Completion helper row (Agents → Roster → Helpers) states that an unset Effort follows the
 * session's, yet a completion with no `model`, or with `"default"`, ran at the provider's default.
 * It also ignored `:off`, and fitted an effort the model lacks to the model's highest one instead of
 * the nearest lower one every session request uses. This suite sweeps the three ways a completion
 * names its model and reads the reasoning options the request carried.
 *
 * Not covered: how a provider maps the effort onto its wire format.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as core from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runEvalCompletion } from "@veyyon/coding-agent/eval/completion-bridge";
import type { ToolSession } from "@veyyon/coding-agent/tools";

/** A reasoning model offering only low and high. */
const model = buildModel({
	id: "two-tier",
	name: "Two tier",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
});
const SELECTOR = `${model.provider}/${model.id}`;

interface Case {
	name: string;
	selector?: string;
	helperEffort?: string;
	sessionLevel?: ThinkingLevel;
	expected: { reasoning: unknown; disableReasoning: unknown };
}

const CASES: Case[] = [
	{
		name: "no model runs the completion helper at the session's effort",
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: "high", disableReasoning: false },
	},
	{
		name: "no model runs the completion helper at its Effort row, fitted down to the model's nearest effort",
		helperEffort: "medium",
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: "low", disableReasoning: false },
	},
	{
		name: '"default" runs the session model at the session\'s effort',
		selector: "default",
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: "high", disableReasoning: false },
	},
	{
		name: "a named model without a :level sends no effort",
		selector: SELECTOR,
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: undefined, disableReasoning: false },
	},
	{
		name: "a named model's :off disables reasoning",
		selector: `${SELECTOR}:off`,
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: undefined, disableReasoning: true },
	},
	{
		name: "a named model's :xhigh is fitted down to high",
		selector: `${SELECTOR}:xhigh`,
		expected: { reasoning: "high", disableReasoning: false },
	},
];

function sessionFor(testCase: Case): ToolSession {
	const settings = Settings.isolated();
	if (testCase.helperEffort) settings.set("agent.helpers", { completion: { thinkingLevel: testCase.helperEffort } });
	return {
		cwd: ".",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => SELECTOR,
		settings,
		thinkingLevel: testCase.sessionLevel,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
}

describe("a completion runs at the effort its model was chosen with", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const testCase of CASES) {
		it(testCase.name, async () => {
			const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "ok" }],
			} as never);

			await runEvalCompletion(
				{ prompt: "hi", ...(testCase.selector ? { model: testCase.selector } : {}) },
				{ session: sessionFor(testCase) },
			);

			const options = complete.mock.calls[0]?.[2] as { reasoning?: unknown; disableReasoning?: unknown };
			expect({ reasoning: options.reasoning, disableReasoning: options.disableReasoning }).toEqual(
				testCase.expected,
			);
		});
	}
});
