import { describe, expect, it } from "bun:test";
import {
	applyPromptSectionOrder,
	PROMPT_SECTION_NAMES,
	splitPromptSections,
} from "@veyyon/coding-agent/prompt-sections";
import systemPromptTemplate from "../../src/prompts/system/system-prompt.md" with { type: "text" };

// A miniature render with the same banner grammar as the real template.
const RENDERED = [
	"<system-conventions>preamble</system-conventions>",
	"",
	"ROLE",
	"==============",
	"role body",
	"",
	"RUNTIME",
	"==============",
	"runtime body",
	"",
	"TOOL POLICY",
	"==============",
	"tool policy body",
	"",
	"EXECUTION WORKFLOW",
	"==============",
	"workflow body",
	"",
	"DELIVERY CONTRACT",
	"==============",
	"contract body",
].join("\n");

describe("splitPromptSections", () => {
	it("round-trips: joining section texts reproduces the input", () => {
		const sections = splitPromptSections(RENDERED);
		expect(sections.map(s => s.text).join("\n")).toBe(RENDERED);
		expect(sections.map(s => s.name)).toEqual([
			"preamble",
			"role",
			"runtime",
			"tool-policy",
			"execution-workflow",
			"delivery-contract",
		]);
	});

	it("finds every canonical section in the real shipped template", () => {
		const names = splitPromptSections(systemPromptTemplate).map(s => s.name);
		for (const name of PROMPT_SECTION_NAMES) {
			expect(names).toContain(name);
		}
	});
});

describe("applyPromptSectionOrder", () => {
	it("returns the input unchanged without an order", () => {
		expect(applyPromptSectionOrder(RENDERED, undefined)).toBe(RENDERED);
		expect(applyPromptSectionOrder(RENDERED, [])).toBe(RENDERED);
	});

	it("emits listed sections first, preamble pinned, rest in template order", () => {
		const result = applyPromptSectionOrder(RENDERED, ["delivery-contract", "tool-policy"]);
		const idx = (banner: string) => result.indexOf(banner);
		expect(result.startsWith("<system-conventions>preamble</system-conventions>")).toBe(true);
		expect(idx("DELIVERY CONTRACT")).toBeLessThan(idx("TOOL POLICY"));
		expect(idx("TOOL POLICY")).toBeLessThan(idx("ROLE"));
		expect(idx("ROLE")).toBeLessThan(idx("RUNTIME"));
		expect(idx("RUNTIME")).toBeLessThan(idx("EXECUTION WORKFLOW"));
		// Nothing dropped: every body line survives the reorder.
		for (const body of ["role body", "runtime body", "tool policy body", "workflow body", "contract body"]) {
			expect(result).toContain(body);
		}
	});

	it("a full-identity order reproduces the input", () => {
		expect(applyPromptSectionOrder(RENDERED, [...PROMPT_SECTION_NAMES])).toBe(RENDERED);
	});

	it("skips names missing from the render instead of corrupting the prompt", () => {
		const noBanners = "custom prompt with no banner sections";
		expect(applyPromptSectionOrder(noBanners, ["tool-policy"])).toBe(noBanners);
	});
});
