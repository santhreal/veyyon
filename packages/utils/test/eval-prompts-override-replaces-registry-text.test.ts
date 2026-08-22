/**
 * WHY: A benchmark comparing prompt variants across arms must be able to swap registry text
 * via VEYYON_EVAL_PROMPTS without editing the source files in the shared repository tree (which
 * would affect both arms identically). If any accessor (prompts[id].text, text(id), require(id))
 * bypasses the override, downstream consumers reach the un-overridden text, producing an
 * invalid benchmark trial that looks successful. This suite defends that all three accessors
 * agree on the overridden text, that an unknown id fails loudly naming the invalid id and near
 * misses, that an absent env leaves every prompt across the entire registry byte-identical,
 * and that non-string/malformed payloads are refused.
 *
 * What it does not catch: Multi-process isolation or Docker container environment delivery
 * (covered by deepswe-bench).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { $env } from "../src/env";
import { definePromptRegistry, type PromptEntry, parseEvalPromptOverridesJson } from "../src/prompt-registry";

const SAMPLE_PROMPTS = {
	"tools/bash": {
		text: "original bash prompt text",
		purpose: "terminal operations",
		sections: [{ id: "when-to-use", name: "WHEN TO USE", purpose: "scoping", optional: false }],
	},
	"tools/read": {
		text: "original read prompt text",
		purpose: "file reading",
	},
	"dialect/anthropic": {
		text: "original anthropic prompt text",
		purpose: "anthropic tool calling",
	},
} satisfies Record<string, PromptEntry>;

describe("parseEvalPromptOverridesJson", () => {
	it("returns an empty object for undefined or whitespace", () => {
		expect(parseEvalPromptOverridesJson(undefined)).toEqual({});
		expect(parseEvalPromptOverridesJson("")).toEqual({});
		expect(parseEvalPromptOverridesJson("   \n\t  ")).toEqual({});
	});

	it("parses valid JSON map of prompt overrides", () => {
		const raw = JSON.stringify({
			"tools/bash": "trimmed bash text",
			"dialect/anthropic": "custom dialect",
		});
		expect(parseEvalPromptOverridesJson(raw)).toEqual({
			"tools/bash": "trimmed bash text",
			"dialect/anthropic": "custom dialect",
		});
	});

	it("throws on invalid JSON", () => {
		expect(() => parseEvalPromptOverridesJson("{not json")).toThrow(
			/VEYYON_EVAL_PROMPTS is set but is not valid JSON/,
		);
	});

	it("throws on non-object JSON values (arrays, primitives, null)", () => {
		expect(() => parseEvalPromptOverridesJson("[]")).toThrow(/must be a JSON object/);
		expect(() => parseEvalPromptOverridesJson("null")).toThrow(/must be a JSON object/);
		expect(() => parseEvalPromptOverridesJson('"a string"')).toThrow(/must be a JSON object/);
		expect(() => parseEvalPromptOverridesJson("42")).toThrow(/must be a JSON object/);
		expect(() => parseEvalPromptOverridesJson("true")).toThrow(/must be a JSON object/);
	});

	it("throws when a map value is not a string", () => {
		const raw = JSON.stringify({ "tools/bash": 123 });
		expect(() => parseEvalPromptOverridesJson(raw)).toThrow(
			/VEYYON_EVAL_PROMPTS value for "tools\/bash" must be a string, got number/,
		);
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

	it("leaves every row byte-identical when env is absent (asserted across all registered IDs)", () => {
		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		// Must assert across EVERY id the registry enumerates at run time, not a sample
		for (const id of reg.ids) {
			const original = SAMPLE_PROMPTS[id];
			expect(reg.text(id)).toBe(original.text);
			expect(reg.prompts[id].text).toBe(original.text);
			expect(reg.prompts[id].purpose).toBe(original.purpose);
			if ("sections" in original) {
				expect((reg.prompts[id] as PromptEntry).sections).toEqual(original.sections);
			}
			expect(reg.require(id).text).toBe(original.text);
		}
	});

	it("replaces text consistently across prompts[id].text, text(id), and require(id)", () => {
		const replacement = "TRIMMED BASH INSTRUCTIONS";
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({
			"tools/bash": replacement,
		});

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		// All three accessors MUST return the identical overridden text
		expect(reg.prompts["tools/bash"].text).toBe(replacement);
		expect(reg.text("tools/bash")).toBe(replacement);
		expect(reg.require("tools/bash").text).toBe(replacement);

		// Non-overridden prompts remain untouched
		expect(reg.prompts["tools/read"].text).toBe(SAMPLE_PROMPTS["tools/read"].text);
		expect(reg.text("tools/read")).toBe(SAMPLE_PROMPTS["tools/read"].text);
		expect(reg.require("tools/read").text).toBe(SAMPLE_PROMPTS["tools/read"].text);

		// Metadata (purpose, sections) is preserved on the overridden row
		expect(reg.prompts["tools/bash"].purpose).toBe(SAMPLE_PROMPTS["tools/bash"].purpose);
		expect(reg.prompts["tools/bash"].sections).toEqual(SAMPLE_PROMPTS["tools/bash"].sections);
	});

	it("supports multiple simultaneous overrides in one env map", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({
			"tools/bash": "NEW BASH",
			"tools/read": "NEW READ",
		});

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		expect(reg.text("tools/bash")).toBe("NEW BASH");
		expect(reg.text("tools/read")).toBe("NEW READ");
		expect(reg.text("dialect/anthropic")).toBe(SAMPLE_PROMPTS["dialect/anthropic"].text);
	});

	it("throws on an unknown prompt id and names the invalid id and directory", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({
			"tools/bash_invalid_typo": "some replacement",
		});

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		expect(() => reg.text("tools/bash")).toThrow(/unknown prompt "tools\/bash_invalid_typo"/);
		expect(() => reg.require("tools/bash")).toThrow(/unknown prompt "tools\/bash_invalid_typo"/);
		expect(() => reg.prompts).toThrow(/unknown prompt "tools\/bash_invalid_typo"/);
	});

	it("suggests the nearest registered id for typos in VEYYON_EVAL_PROMPTS", () => {
		$env.VEYYON_EVAL_PROMPTS = JSON.stringify({
			"tools/bsh": "some replacement",
		});

		const reg = definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

		let message = "";
		try {
			reg.text("tools/bash");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}

		expect(message).toContain('unknown prompt "tools/bsh"');
		expect(message).toContain('Did you mean "tools/bash"?');
	});

	it("announces the active override once via console.warn", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			$env.VEYYON_EVAL_PROMPTS = JSON.stringify({
				"tools/bash": "OVERRIDDEN BASH",
			});

			definePromptRegistry("packages/test/prompts", SAMPLE_PROMPTS);

			expect(warnSpy).toHaveBeenCalled();
			const warned = warnSpy.mock.calls.flat().join(" ");
			expect(warned).toContain("EVAL-ONLY prompt override is ACTIVE (VEYYON_EVAL_PROMPTS)");
			expect(warned).toContain("[tools/bash]");
		} finally {
			warnSpy.mockRestore();
		}
	});
});
