/**
 * WHY: a model id's case is the HOST's spelling of it, never a fact about the
 * model, and the identity parsers treated it as one.
 *
 * `parseGlmModel`, `parseOpenAIModel`, `parseAnthropicModel` and
 * `parseGeminiModel` all matched lowercase-only regexes, so every host that
 * serves models under their HuggingFace repo names — Baseten's `zai-org/GLM-5.2`,
 * `moonshotai/Kimi-K2.6`, `nvidia/NVIDIA-Nemotron-…` — parsed as an UNKNOWN
 * family. Nothing failed loudly; each identity-derived policy simply did not
 * apply, and the row kept whatever ladder inference had guessed.
 *
 * The cost is a picker full of levels the endpoint rejects. Baseten's GLM-5.2
 * route accepts `none`, `high` and `max` and "return[s] a 400 error for values
 * outside their supported sets" (docs.baseten.co/inference/model-apis/reasoning,
 * read 2026-08-05). Veyyon offered `minimal`, `low`, `medium`, `high`, `xhigh`:
 * four of those five are a guaranteed 400, and `max` — the one real tier above
 * `high` — could not be chosen at all. The GLM-5.2 rule that says `high`/`max`
 * was already in the tree and had simply never matched the id.
 */

import { describe, expect, test } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import {
	parseAnthropicModel,
	parseGeminiModel,
	parseGlmModel,
	parseKnownModel,
} from "@veyyon/catalog/identity/classify";
import { isGlm52ReasoningEffortModelId, isReasoningGlmModelId } from "@veyyon/catalog/identity/family";
import { getBundledModels } from "@veyyon/catalog/models";

describe("identity parsing ignores the host's letter case", () => {
	test("classifies an uppercase GLM repo id", () => {
		expect(parseGlmModel("GLM-5.2")).toMatchObject({
			family: "glm",
			variant: "base",
			vision: false,
			version: { major: 5, minor: 2 },
		});
		expect(isGlm52ReasoningEffortModelId("zai-org/GLM-5.2")).toBe(true);
		expect(isReasoningGlmModelId("zai-org/GLM-4.7")).toBe(true);
	});

	test("classifies uppercase ids of the other parsed families", () => {
		expect(parseKnownModel("Anthropic/Claude-Opus-4-5")).toMatchObject({ family: "anthropic", kind: "opus" });
		expect(parseKnownModel("openai/GPT-5.6-Codex")).toMatchObject({ family: "openai", variant: "codex" });
		expect(parseGeminiModel("Gemini-3.1-Pro")).toMatchObject({ family: "gemini", kind: "pro" });
		expect(parseAnthropicModel("CLAUDE-SONNET-4-5")).toMatchObject({ family: "anthropic", kind: "sonnet" });
	});

	test("offers Baseten's GLM-5.2 route exactly the two efforts it accepts", () => {
		// The whole point of the parse: this row is shipped, and every level
		// outside high/max is a 400 from Baseten.
		const glm = getBundledModels("baseten").find(model => model.id === "zai-org/GLM-5.2");
		if (!glm) throw new Error("expected a bundled baseten/zai-org/GLM-5.2 row");
		expect(glm.reasoning).toBe(true);
		expect(glm.thinking?.mode).toBe("effort");
		expect(glm.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
	});
});
