/**
 * WHY: `new Mnemopi({ llm: { enabled: false, ... } })` resolved `enabled` to `undefined`, so
 * `MNEMOPI_LLM_ENABLED` (on by default) applied instead and the configured completion ran anyway.
 *
 * The class: each spelling a caller can use to decide the LLM (the flat `llmEnabled`, the nested
 * `llm.enabled`, and an LLM section that names a completion without deciding) reaches the
 * extractor, with the flat spelling taking precedence over the nested one. Every case sets the
 * variable to the opposite of the expected outcome, so a case passes only when the caller's
 * decision is the one applied.
 *
 * Gap: the cases drive background fact extraction. Consolidation reads the same resolved runtime
 * options and is not driven here.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Mnemopi, type MnemopiOptions } from "@veyyon/mnemopi/core/memory";
import type { MnemopiLlmCompletion } from "@veyyon/mnemopi/core/runtime-options";

interface DecisionCase {
	readonly name: string;
	readonly options: (complete: MnemopiLlmCompletion) => MnemopiOptions;
	readonly runs: boolean;
}

const CASES: readonly DecisionCase[] = [
	{ name: "nested enabled: false", options: complete => ({ llm: { enabled: false, complete } }), runs: false },
	{ name: "nested enabled: true", options: complete => ({ llm: { enabled: true, complete } }), runs: true },
	{ name: "flat llmEnabled: false", options: complete => ({ llmEnabled: false, llm: { complete } }), runs: false },
	{
		name: "flat llmEnabled: false over nested enabled: true",
		options: complete => ({ llmEnabled: false, llm: { enabled: true, complete } }),
		runs: false,
	},
	{
		name: "flat llmEnabled: true over nested enabled: false",
		options: complete => ({ llmEnabled: true, llm: { enabled: false, complete } }),
		runs: true,
	},
	{ name: "a completion with no decision", options: complete => ({ llm: { complete } }), runs: true },
];

const instances: Mnemopi[] = [];
let previousEnabled: string | undefined;

beforeEach(() => {
	previousEnabled = process.env.MNEMOPI_LLM_ENABLED;
});

afterEach(async () => {
	for (const memory of instances) {
		await memory.flushExtractions();
		memory.close();
	}
	instances.length = 0;
	if (previousEnabled === undefined) delete process.env.MNEMOPI_LLM_ENABLED;
	else process.env.MNEMOPI_LLM_ENABLED = previousEnabled;
});

describe("a caller's LLM decision beats the environment in every spelling", () => {
	for (const decision of CASES) {
		it(`${decision.runs ? "runs" : "skips"} the completion for ${decision.name}`, async () => {
			process.env.MNEMOPI_LLM_ENABLED = decision.runs ? "0" : "1";
			let calls = 0;
			const complete: MnemopiLlmCompletion = () => {
				calls += 1;
				return "The user prefers tabs";
			};
			const memory = new Mnemopi({
				sessionId: "llm-decision",
				dbPath: ":memory:",
				embeddings: false,
				...decision.options(complete),
			});
			instances.push(memory);

			memory.remember("I prefer tabs.", { source: "test", extract: true });
			await memory.flushExtractions();

			expect(calls).toBe(decision.runs ? 1 : 0);
		});
	}
});
