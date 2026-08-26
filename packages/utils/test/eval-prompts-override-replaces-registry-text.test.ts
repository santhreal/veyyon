/**
 * WHY: A benchmark that compares two prompt variants cannot get them by editing the
 * prompt file — one built binary serves both arms, so the edit reaches both and the
 * delta has no cause. `VEYYON_EVAL_PROMPTS` is the per-arm vehicle, and every accessor a
 * consumer might reach for (`prompts[id].text`, `text(id)`, `require(id)`) has to agree
 * on the replaced text; one accessor that bypasses the override serves the shipped
 * prompt to part of the agent and produces a trial that looks successful while measuring
 * a mixture.
 *
 * The class this closes, and the reason the suite exists in this shape: a registry must
 * NOT judge an id it does not hold. Four packages ship registries, they are constructed
 * in import order, and the first version refused on every read once any override id was
 * still unclaimed — so a valid `tools/bash` override died inside `@veyyon/ai`'s registry
 * (built first, and it holds no tool descriptions) and every trial of the arm
 * hard-errored at zero output tokens. Tolerating a sibling's id here is therefore a
 * contract, not laxity, and the refusal it replaces lives in the two callers that know
 * the whole id space: `packages/coding-agent/src/prompts/all-registries.ts` at prompt
 * assembly, and the bench runner before a container starts.
 *
 * What it does not catch: delivery of the variable into a Docker container, and the two
 * refusal layers themselves (`an-eval-prompt-override-must-name-a-prompt-some-registry-holds.test.ts`
 * in coding-agent, `arm-prompts.test.ts` in the DeepSWE suite).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { $env } from "../src/env";
import { parseEvalPromptOverridesJson, unclaimedEvalPromptOverrideIds } from "../src/eval-prompt-overrides";
import { definePromptRegistry, type PromptEntry } from "../src/prompt-registry";

const SAMPLE_PROMPTS = {
	"tools/bash": {
		text: "ORIGINAL BASH INSTRUCTIONS",
		purpose: "How to drive the shell",
		sections: [{ id: "body", name: null, purpose: "the whole thing", optional: false }],
	},
	"tools/read": {
		text: "ORIGINAL READ INSTRUCTIONS",
		purpose: "How to read a file",
	},
	"dialect/anthropic": {
		text: "ORIGINAL DIALECT GUIDE",
		purpose: "How to write a tool call",
	},
} satisfies Record<string, PromptEntry>;

/** A second registry, standing in for the sibling package whose ids are not these. */
const SIBLING_PROMPTS = {
	"compaction/summarize": {
		text: "ORIGINAL SUMMARY INSTRUCTIONS",
		purpose: "How to compact a session",
	},
} satisfies Record<string, PromptEntry>;

describe("parseEvalPromptOverridesJson", () => {
	it("returns an empty object for undefined or whitespace", () => {
		expect(parseEvalPromptOverridesJson(undefined)).toEqual({});
		expect(parseEvalPromptOverridesJson("")).toEqual({});
		expect(parseEvalPromptOverridesJson("   \n\t ")).toEqual({});
	});

	it("parses a valid map of prompt overrides", () => {
		expect(parseEvalPromptOverridesJson('{"tools/bash":"NEW","tools/read":"ALSO NEW"}')).toEqual({
			"tools/bash": "NEW",
			"tools/read": "ALSO NEW",
		});
	});

	it("throws on invalid JSON", () => {
		expect(() => parseEvalPromptOverridesJson("{not json")).toThrow(/is not valid JSON/);
	});

	it("throws on a payload that is not an object of ids", () => {
		expect(() => parseEvalPromptOverridesJson("[1,2]")).toThrow(/must be a JSON object.*got an array/s);
		expect(() => parseEvalPromptOverridesJson("null")).toThrow(/must be a JSON object.*got null/s);
		expect(() => parseEvalPromptOverridesJson('"text"')).toThrow(/must be a JSON object.*got string/s);
	});

	it("throws when a replacement is not text", () => {
		expect(() => parseEvalPromptOverridesJson('{"tools/bash":42}')).toThrow(
			/value for "tools\/bash" must be a string, got number/,
		);
		expect(() => parseEvalPromptOverridesJson('{"tools/bash":null}')).toThrow(/must be a string, got object/);
	});
});

describe("definePromptRegistry with VEYYON_EVAL_PROMPTS", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = $env.VEYYON_EVAL_PROMPTS;
		delete $env.VEYYON_EVAL_PROMPTS;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete $env.VEYYON_EVAL_PROMPTS;
		} else {
			$env.VEYYON_EVAL_PROMPTS = originalEnv;
		}
	});

	it("serves the caller's own table by identity when no override is set", () => {
		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		// Identity, not equality: the production path must not copy the table. A registry
		// is read once per tool per turn, so a spread here is paid by every session to
		// serve a benchmark that is not running.
		expect(reg.prompts).toBe(SAMPLE_PROMPTS);
		for (const id of reg.ids) {
			const original = SAMPLE_PROMPTS[id];
			expect(reg.text(id)).toBe(original.text);
			expect(reg.prompts[id].text).toBe(original.text);
			expect(reg.prompts[id].purpose).toBe(original.purpose);
			expect(reg.require(id).text).toBe(original.text);
		}
	});

	it("replaces text consistently across prompts[id].text, text(id), and require(id)", () => {
		const replacement = "TRIMMED BASH INSTRUCTIONS";
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bash": replacement });

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		expect(reg.prompts["tools/bash"].text).toBe(replacement);
		expect(reg.text("tools/bash")).toBe(replacement);
		expect(reg.require("tools/bash").text).toBe(replacement);

		// Every other row is the shipped one, and the replaced row keeps everything the
		// registry declares ABOUT the prompt: a swapped body is the only variable.
		expect(reg.text("tools/read")).toBe(SAMPLE_PROMPTS["tools/read"].text);
		expect(reg.require("dialect/anthropic").text).toBe(SAMPLE_PROMPTS["dialect/anthropic"].text);
		expect(reg.prompts["tools/bash"].purpose).toBe(SAMPLE_PROMPTS["tools/bash"].purpose);
		expect(reg.prompts["tools/bash"].sections).toEqual(SAMPLE_PROMPTS["tools/bash"].sections);
		expect([...reg.ids]).toEqual(["tools/bash", "tools/read", "dialect/anthropic"]);
		expect(reg.fileFor("tools/bash")).toBe("packages/test/prompts/tools/bash.md");
	});

	it("applies every id in the map that this registry owns", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bash": "NEW BASH", "tools/read": "NEW READ" });

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		expect(reg.text("tools/bash")).toBe("NEW BASH");
		expect(reg.text("tools/read")).toBe("NEW READ");
		expect(reg.text("dialect/anthropic")).toBe(SAMPLE_PROMPTS["dialect/anthropic"].text);
	});

	it("serves its own prompts unchanged when the override names another registry's id", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bash": "TRIMMED BASH" });

		// The sibling is built FIRST, which is the real import order that broke: the id
		// belongs to a registry that does not exist yet, and a refusal here kills the agent
		// before the owning registry is ever constructed.
		const sibling = definePromptRegistry("packages/sibling/prompts", SIBLING_PROMPTS);

		for (const id of sibling.ids) {
			expect(sibling.text(id)).toBe(SIBLING_PROMPTS[id].text);
			expect(sibling.prompts[id].text).toBe(SIBLING_PROMPTS[id].text);
			expect(sibling.require(id).text).toBe(SIBLING_PROMPTS[id].text);
		}
		expect(sibling.has("tools/bash")).toBe(false);
		// Still unclaimed, so a caller that knows every registry can still refuse it.
		expect(unclaimedEvalPromptOverrideIds()).toEqual(["tools/bash"]);

		const owner = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		expect(owner.text("tools/bash")).toBe("TRIMMED BASH");
		expect(unclaimedEvalPromptOverrideIds()).toEqual([]);
	});

	it("reports an id no registry claimed, which is what the refusal layers read", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bsh": "TYPO", "tools/read": "REAL" });

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);
		definePromptRegistry("packages/sibling/prompts", SIBLING_PROMPTS);

		expect(reg.text("tools/read")).toBe("REAL");
		expect(unclaimedEvalPromptOverrideIds()).toEqual(["tools/bsh"]);
	});

	it("forgets its claims when the variable changes, so one process can run two scenarios", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bash": "FIRST" });
		expect(definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS).text("tools/bash")).toBe("FIRST");
		expect(unclaimedEvalPromptOverrideIds()).toEqual([]);

		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/gone": "SECOND" });
		expect(definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS).text("tools/bash")).toBe(
			SAMPLE_PROMPTS["tools/bash"].text,
		);
		expect(unclaimedEvalPromptOverrideIds()).toEqual(["tools/gone"]);
	});

	it("announces each replaced prompt once, naming the registry it altered", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			$env.VEYYON_EVAL_PROMPTS = JSON.stringify({ "tools/bash": "OVERRIDDEN BASH" });

			definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);
			// A second construction of the same registry (a re-import, or a test) must not
			// print a second banner: the warning names a state, not an event.
			definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const warned = warnSpy.mock.calls.flat().join(" ");
			expect(warned).toContain("EVAL-ONLY prompt override is ACTIVE (VEYYON_EVAL_PROMPTS)");
			expect(warned).toContain("[tools/bash]");
			// The id names the file; the directory it is relative to is its registry's to state.
			expect(warned).not.toContain("packages/test/prompts");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("says nothing at all when no override is set", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});
