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

/**
 * Adversarial split cases. `splitPromptSections` is the load-bearing tokenizer:
 * a banner it misses merges two sections (a later reorder then moves the wrong
 * span), and a non-banner line it mistakes for a banner splits a section in the
 * middle. These pin the exact banner grammar (`NAME` on its own line
 * immediately followed by a `====` line) against inputs designed to fool it.
 */
describe("splitPromptSections: adversarial grammar", () => {
	it("treats a banner name on the very first line as a section, with an empty preamble", () => {
		const noPreamble = ["ROLE", "====", "role body"].join("\n");
		const sections = splitPromptSections(noPreamble);
		expect(sections[0]).toEqual({ name: "preamble", text: "" });
		expect(sections[1].name).toBe("role");
		// Documented edge: with a banner on line 0 the preamble text is "" and
		// there was no separating newline in the source, so a NAIVE join("\n")
		// fabricates a leading newline (the round-trip claim only holds for a
		// real preamble). This asserts that observed behavior so a future change
		// to the split cannot silently alter it.
		expect(sections.map(s => s.text).join("\n")).toBe(`\n${noPreamble}`);
		// The real consumer compensates: it drops the empty preamble, so the
		// reorder path reproduces the input with NO fabricated leading newline.
		expect(applyPromptSectionOrder(noPreamble, ["role"])).toBe(noPreamble);
	});

	it("does NOT split on a banner word that is not followed by a ==== underline", () => {
		// "ROLE" here is prose, not a banner: the next line is not a `====` rule.
		const prose = ["preamble", "the word ROLE appears here", "but it is just prose"].join("\n");
		const sections = splitPromptSections(prose);
		expect(sections).toHaveLength(1);
		expect(sections[0].name).toBe("preamble");
		expect(sections[0].text).toBe(prose);
	});

	it("does NOT split on a ==== underline whose preceding line is not a known banner name", () => {
		const heading = ["preamble", "Some Heading", "====", "body under a non-banner heading"].join("\n");
		const sections = splitPromptSections(heading);
		expect(sections).toHaveLength(1);
		expect(sections[0].name).toBe("preamble");
	});

	it("tolerates surrounding whitespace on the banner line (trimmed match)", () => {
		const padded = ["preamble", "   ROLE   ", "====", "role body"].join("\n");
		const sections = splitPromptSections(padded);
		expect(sections.map(s => s.name)).toEqual(["preamble", "role"]);
		expect(sections.map(s => s.text).join("\n")).toBe(padded);
	});

	it("handles consecutive banners with an empty body between them", () => {
		const empty = ["preamble", "ROLE", "====", "RUNTIME", "====", "runtime body"].join("\n");
		const sections = splitPromptSections(empty);
		expect(sections.map(s => s.name)).toEqual(["preamble", "role", "runtime"]);
		// The empty ROLE section is still present; round-trip is exact.
		expect(sections.map(s => s.text).join("\n")).toBe(empty);
	});

	it("round-trips exactly regardless of trailing newline", () => {
		for (const suffix of ["", "\n", "\n\n"]) {
			const input = RENDERED + suffix;
			expect(
				splitPromptSections(input)
					.map(s => s.text)
					.join("\n"),
			).toBe(input);
		}
	});
});

/** Deterministic permutation generator (Date.now/Math.random are unavailable here). */
function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	const out: T[][] = [];
	for (let i = 0; i < items.length; i++) {
		const rest = [...items.slice(0, i), ...items.slice(i + 1)];
		for (const p of permutations(rest)) out.push([items[i], ...p]);
	}
	return out;
}

/** Multiset of section bodies (name + text pairs), order-independent, sorted for comparison. */
function sectionMultiset(rendered: string): string[] {
	return splitPromptSections(rendered)
		.map(s => `${s.name} ${s.text}`)
		.sort();
}

/**
 * The core reorder invariant, stated as a property over ALL 120 permutations of
 * the five banner names: reordering is a PERMUTATION of sections, never a
 * rewrite. It must (1) preserve the exact multiset of section bodies: no loss,
 * no duplication, no mutation, and (2) always keep the preamble first. This is
 * the contract that stops a `promptSectionOrder` harness override from silently
 * dropping or corrupting a slice of the system prompt.
 */
describe("applyPromptSectionOrder: reorder is a content-preserving permutation", () => {
	const baseline = sectionMultiset(RENDERED);

	it("preserves the exact section multiset under every permutation of the order", () => {
		for (const order of permutations([...PROMPT_SECTION_NAMES])) {
			const result = applyPromptSectionOrder(RENDERED, order);
			expect(sectionMultiset(result)).toEqual(baseline);
		}
	});

	it("keeps the preamble first under every permutation of the order", () => {
		for (const order of permutations([...PROMPT_SECTION_NAMES])) {
			const result = applyPromptSectionOrder(RENDERED, order);
			expect(result.startsWith("<system-conventions>preamble</system-conventions>")).toBe(true);
		}
	});

	it("emits each listed section exactly at its ordered rank", () => {
		for (const order of permutations([...PROMPT_SECTION_NAMES])) {
			const result = applyPromptSectionOrder(RENDERED, order);
			const banners = {
				role: "ROLE",
				runtime: "RUNTIME",
				"tool-policy": "TOOL POLICY",
				"execution-workflow": "EXECUTION WORKFLOW",
				"delivery-contract": "DELIVERY CONTRACT",
			} as const;
			const positions = order.map(name => result.indexOf(banners[name as keyof typeof banners]));
			for (let i = 1; i < positions.length; i++) {
				expect(positions[i - 1]).toBeLessThan(positions[i]);
			}
		}
	});
});

/**
 * Duplicate / partial / unknown handling. These pin the exact edge behaviors of
 * the reorder primitive so a refactor cannot regress them silently.
 */
describe("applyPromptSectionOrder: duplicate, partial, and unknown names", () => {
	it("a partial order emits listed sections first, then unlisted in template order, losing nothing", () => {
		const result = applyPromptSectionOrder(RENDERED, ["runtime"]);
		expect(sectionMultiset(result)).toEqual(sectionMultiset(RENDERED));
		const idx = (b: string) => result.indexOf(b);
		expect(idx("RUNTIME")).toBeLessThan(idx("ROLE"));
		expect(idx("ROLE")).toBeLessThan(idx("TOOL POLICY"));
	});

	it("a name repeated in the order is emitted once, never duplicated", () => {
		const result = applyPromptSectionOrder(RENDERED, ["role", "role", "role"]);
		expect(sectionMultiset(result)).toEqual(sectionMultiset(RENDERED));
		// "role body" occurs exactly once in the output.
		expect(result.split("role body").length - 1).toBe(1);
	});

	it("mixes known and unknown names: known applied, unknown skipped, nothing dropped", () => {
		const result = applyPromptSectionOrder(RENDERED, ["delivery-contract", "does-not-exist", "role"]);
		expect(sectionMultiset(result)).toEqual(sectionMultiset(RENDERED));
		const idx = (b: string) => result.indexOf(b);
		expect(idx("DELIVERY CONTRACT")).toBeLessThan(idx("ROLE"));
	});

	/**
	 * Regression: a render with two same-named banners must NOT lose the first
	 * when that name is in the order. The prior implementation keyed sections by
	 * NAME (last-wins Map) and filtered the "rest" pass by name, so the first
	 * duplicate was silently dropped, a content-loss path on custom templates.
	 * The identity-keyed implementation emits every instance exactly once.
	 */
	it("preserves BOTH bodies of a duplicated banner name when that name is ordered", () => {
		const dupRole = [
			"preamble",
			"ROLE",
			"====",
			"first role body",
			"ROLE",
			"====",
			"second role body",
			"RUNTIME",
			"====",
			"runtime body",
		].join("\n");
		const result = applyPromptSectionOrder(dupRole, ["role"]);
		expect(result).toContain("first role body");
		expect(result).toContain("second role body");
		expect(result).toContain("runtime body");
		// Full multiset preserved: split to both role sections + runtime survive.
		expect(sectionMultiset(result)).toEqual(sectionMultiset(dupRole));
	});

	it("preserves both duplicated bodies even when the duplicated name is NOT in the order", () => {
		const dupRole = [
			"preamble",
			"ROLE",
			"====",
			"role-alpha",
			"ROLE",
			"====",
			"role-beta",
			"RUNTIME",
			"====",
			"run-gamma",
		].join("\n");
		const result = applyPromptSectionOrder(dupRole, ["runtime"]);
		expect(sectionMultiset(result)).toEqual(sectionMultiset(dupRole));
		expect(result).toContain("role-alpha");
		expect(result).toContain("role-beta");
		expect(result).toContain("run-gamma");
	});
});
