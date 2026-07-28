/**
 * One parser cuts every registry-assembled bannered prompt.
 *
 * The outer template no longer carries sections or banners. Strict callers and
 * lenient callers share `splitBanneredDocument`; the caller chooses whether
 * missing sections are errors by supplying an expected registry list.
 */
import { describe, expect, it } from "bun:test";
import { bannerTable, splitBanneredDocument } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import {
	assembleDefaultTemplate,
	assembleStatementSections,
} from "@veyyon/coding-agent/system-prompt-builder/default-template";
import {
	applyPromptSectionOrder,
	splitPromptSections,
} from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";
import { BANNERED_TEMPLATE_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";

const TEMPLATE = assembleDefaultTemplate(assembleStatementSections({}));
const TEMPLATE_BANNERS = bannerTable(BANNERED_TEMPLATE_SECTIONS);
const EXPECTED = BANNERED_TEMPLATE_SECTIONS.map(section => ({ id: section.id as string, name: section.name }));

/** A miniature document with the real grammar, so failures are readable. */
const DOC = [
	"preamble line",
	"",
	"ROLE",
	"==============",
	"role body",
	"",
	"RUNTIME",
	"==============",
	"runtime body",
].join("\n");

describe("strict and lenient parsing share one grammar", () => {
	/**
	 * A renamed registry banner must fail the strict path rather than folding the
	 * missing section into its predecessor.
	 */
	it("reports a renamed banner as a missing section", () => {
		const mangled = TEMPLATE.replace("TOOL POLICY\n==", "TOOL POLICE\n==");

		expect(() =>
			splitBanneredDocument(mangled, { banners: TEMPLATE_BANNERS, expect: EXPECTED, label: "test document" }),
		).toThrow(/tool-policy/);
	});

	/**
	 * Custom prompts may legitimately have no banners, so omission of `expect`
	 * keeps the same parser deliberately lenient.
	 */
	it("reads a bannerless document as one region in lenient mode", () => {
		expect(splitPromptSections("just prose, no banners anywhere", TEMPLATE_BANNERS)).toEqual([
			{ name: "preamble", text: "just prose, no banners anywhere" },
		]);
	});

	/** Out-of-order sections must be distinguished from absent sections. */
	it("reports order separately from absence", () => {
		const swapped = [
			"preamble line",
			"",
			"RUNTIME",
			"==============",
			"runtime body",
			"",
			"ROLE",
			"==============",
			"role body",
		].join("\n");

		expect(() =>
			splitBanneredDocument(swapped, {
				banners: TEMPLATE_BANNERS,
				expect: [
					{ id: "role", name: "ROLE" },
					{ id: "runtime", name: "RUNTIME" },
				],
				label: "test document",
			}),
		).toThrow(/out of order.*"runtime", "role".*expected.*"role", "runtime"/s);
	});

	/** Strict errors must name the document whose assembly is malformed. */
	it("includes the caller label in a missing-section error", () => {
		expect(() =>
			splitBanneredDocument(TEMPLATE.replace("ROLE\n==", "ROLES\n=="), {
				banners: TEMPLATE_BANNERS,
				expect: EXPECTED,
				label: "assembled system prompt",
			}),
		).toThrow(/assembled system prompt/);
	});
});

describe("one scan, two separator conventions", () => {
	/**
	 * Exact regions must rejoin the registry-assembled document without changing
	 * any instruction or separator byte.
	 */
	it("rejoins the assembled static prompt byte for byte", () => {
		const regions = splitBanneredDocument(TEMPLATE, { banners: TEMPLATE_BANNERS, expect: EXPECTED });

		expect(regions.map(region => region.text).join("")).toBe(TEMPLATE);
	});
	/**
	 * The reorder view drops exactly one trailing newline per region, because the
	 * separator belongs BETWEEN regions there. Moving a region that carried its own
	 * newline would drag a blank line around with it and strand the section that
	 * inherited last place without one.
	 */
	it("rejoins a rendered document with a newline separator", () => {
		const regions = splitPromptSections(DOC, TEMPLATE_BANNERS);

		expect(regions.map(region => region.text).join("\n")).toBe(DOC);
	});

	/**
	 * The two views describe the same cut. Asserted directly so a change to one
	 * convention cannot quietly move a boundary in the other.
	 */
	it("cuts at the same boundaries in both conventions", () => {
		const exact = splitBanneredDocument(DOC, { banners: TEMPLATE_BANNERS });
		const forReorder = splitPromptSections(DOC, TEMPLATE_BANNERS);

		expect(forReorder.map(region => region.name)).toEqual(exact.map(region => region.name));
		expect(forReorder.map(region => region.text)).toEqual(
			exact.map((region, index) => (index === exact.length - 1 ? region.text : region.text.replace(/\n$/, ""))),
		);
	});

	/**
	 * The awkward input the old line-wise splitter had to document as an exception:
	 * a banner on line 0, so there is no preamble and no separator to reason about.
	 * Byte slicing has no special case for it, and reordering must not fabricate a
	 * leading newline.
	 */
	it("handles a document that opens on a banner without inventing a newline", () => {
		const leading = ["ROLE", "==============", "role body", "", "RUNTIME", "==============", "runtime body"].join(
			"\n",
		);
		const regions = splitPromptSections(leading, TEMPLATE_BANNERS);

		expect(regions[0]).toEqual({ name: "preamble", text: "" });
		expect(applyPromptSectionOrder(leading, ["role", "runtime"])).toBe(leading);
	});
});

describe("reordering stays a permutation, not a rewrite", () => {
	/** Identity order must be a no-op to the byte, or every render drifts. */
	it("returns the document unchanged when the order is its own order", () => {
		expect(applyPromptSectionOrder(DOC, ["role", "runtime"])).toBe(DOC);
	});

	/**
	 * Swapping moves whole regions and loses nothing.
	 *
	 * Note the trailing newline in the result. A region runs to the start of the
	 * next banner, so the blank line that separated `role` from `runtime` belongs
	 * to `role` and travels with it. That is the correct reading of "move this
	 * section": its own spacing goes along. The bytes are asserted exactly rather
	 * than trimmed, because a splitter that quietly normalized whitespace here
	 * would be rewriting the prompt while claiming to permute it.
	 */
	it("swaps two sections without losing or duplicating a byte", () => {
		const swapped = applyPromptSectionOrder(DOC, ["runtime", "role"]);

		expect(swapped).toBe(
			[
				"preamble line",
				"",
				"RUNTIME",
				"==============",
				"runtime body",
				"ROLE",
				"==============",
				"role body",
				"",
			].join("\n"),
		);
		expect(splitPromptSections(swapped, TEMPLATE_BANNERS).map(region => region.name)).toEqual([
			"preamble",
			"runtime",
			"role",
		]);
	});

	/**
	 * The permutation property, stated over content rather than layout: whatever
	 * the order, the same set of section bodies comes back. This is what stops a
	 * harness `promptSectionOrder` from dropping a slice of the system prompt.
	 */
	it("preserves the exact set of section bodies under either order", () => {
		const bodies = (document: string): string[] =>
			splitPromptSections(document, TEMPLATE_BANNERS)
				.map(region => `${region.name}:${region.text.trim()}`)
				.sort();

		expect(bodies(applyPromptSectionOrder(DOC, ["runtime", "role"]))).toEqual(bodies(DOC));
	});
});
