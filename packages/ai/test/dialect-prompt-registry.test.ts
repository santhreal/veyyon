/**
 * Every dialect ships a format guide, and it ships ITS OWN.
 *
 * WHY THIS SUITE EXISTS. The fourteen prompts this package sends used to sit beside
 * the fourteen modules that imported them by relative path, so `@veyyon/ai` could not
 * answer "what text do you put in a model's system prompt" with anything but a glob,
 * and `veyyon prompt --prompts` listed none of them. They are now registered in
 * `src/prompts/registry.ts`, which moved every guide's address from an import
 * specifier to a row id.
 *
 * That move has one failure mode, and it is silent. `prompt: AI_PROMPTS["dialect/glm"]`
 * inside `gemma.ts` compiles, renders, and passes a coverage check that only asks
 * whether every file has a row: the Gemma model is then handed GLM's syntax and emits
 * calls the Gemma scanner cannot read, which reads as a weak model rather than as
 * crossed wiring. So the identity is asserted per dialect, in both directions, against
 * the real definition table.
 *
 * The prompts themselves are checked for content rather than existence, because an
 * empty guide is the same bug arriving by a different route: a system prompt with a
 * tool catalog and no syntax to call one.
 */
import { describe, expect, it } from "bun:test";
import { getDialectDefinition } from "@veyyon/ai/dialect";
import { AI_PROMPTS, aiPrompts } from "@veyyon/ai/prompts/registry";
import { DIALECTS } from "@veyyon/catalog/identity";

/** The registered guides, by the dialect each one is named for. */
const GUIDE_IDS = aiPrompts.ids.filter(id => id.startsWith("dialect/") && id !== "dialect/prompt-template");

describe("each dialect's format guide", () => {
	it("is registered for every dialect that exists, with none left unregistered", () => {
		// Both directions off one list. A dialect added without a guide would ship a
		// catalog with no syntax; a guide left behind after a dialect is removed is a
		// row describing text nothing sends.
		expect(GUIDE_IDS.map(id => id.slice("dialect/".length)).sort()).toEqual([...DIALECTS].sort());
	});

	it.each([...DIALECTS])("is the row named for that dialect and no other: %s", dialect => {
		// THE WIRING. `getDialectDefinition` is what the provider layer actually reads,
		// so the definition's `prompt` is the text a model receives. Compared to the row
		// by identity, which is the only comparison that catches a crossed reference
		// between two guides that both look like format guides.
		const definition = getDialectDefinition(dialect);

		expect(definition.prompt).toBe(AI_PROMPTS[`dialect/${dialect}`].text);
		expect(definition.dialect).toBe(dialect);
	});

	it.each([...DIALECTS])("is not another dialect's guide: %s", dialect => {
		// The complement of the check above, and the one that fails on a copy-paste. Two
		// dialects sharing one guide passes an identity check against the row it was
		// wired to; it cannot pass this.
		const mine = getDialectDefinition(dialect).prompt;
		const others = DIALECTS.filter(other => other !== dialect).map(other => AI_PROMPTS[`dialect/${other}`].text);

		expect(others).not.toContain(mine);
	});

	it.each([...DIALECTS])("says how to write a call, not nothing: %s", dialect => {
		// Real content, not `!is_empty`: a guide has to name the syntax it teaches, and
		// the shortest real one here is over 200 bytes.
		const text = AI_PROMPTS[`dialect/${dialect}`].text;

		expect(text.length).toBeGreaterThan(200);
		expect(text.toLowerCase()).toContain("format guide");
		// It opens on its heading. The guide is concatenated into a system prompt under
		// the tool catalog, so leading blank lines or a body that starts mid-sentence
		// land in the model's context exactly as written.
		expect(text.split("\n", 1)[0]).toMatch(/^#{1,2} \S/);
	});
});

describe("looking an ai prompt up by an id held in a variable", () => {
	// Through the descriptor, which is what a consumer holds. The package used to export a
	// `requireAiPrompt` alias for exactly this call; the descriptor already carries it, so
	// the alias was one value under two names with nothing keeping the pair in step.
	it("returns the registered row", () => {
		expect(aiPrompts.require("dialect/anthropic")).toBe(AI_PROMPTS["dialect/anthropic"]);
	});

	it("throws on an unknown id rather than yielding a prompt with no text", () => {
		// A format guide that resolves to nothing does not fail: the run proceeds with a
		// catalog and no syntax, and the model's prose is scored as a failed tool call.
		expect(() => aiPrompts.require("dialect/claude")).toThrow(
			/unknown prompt "dialect\/claude" in packages\/ai\/src\/prompts/,
		);
	});

	it("names the near miss, so a typo is a suggestion rather than a grep", () => {
		expect(() => aiPrompts.require("dialect/anthropik")).toThrow(/Did you mean "dialect\/anthropic"/);
	});
});
