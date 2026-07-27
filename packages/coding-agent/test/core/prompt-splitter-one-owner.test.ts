/**
 * One parser cuts every bannered prompt, and both callers agree about failure.
 *
 * THE BUG THIS LOCKS OUT. The product had two implementations of the same
 * `NAME\n====` grammar. `splitDefaultTemplate` walked byte offsets and THREW on
 * a missing or out-of-order banner. `splitPromptSections` walked lines and
 * silently folded an unrecognised banner into the section above it. The section
 * DEFINITIONS had been unified into `section-registry.ts`, and that unification was
 * mistaken for the whole fix: `prompt-sections.ts` said in its own doc comment
 * that deriving both banner tables from one registry "removes the possibility"
 * of divergence. It does not. One source of truth for WHICH banners exist says
 * nothing about what either parser does when one is ABSENT, and the two answered
 * that question differently.
 *
 * The consequence was reachable and quiet. Rename a banner in the template and
 * the build refuses, which is correct. Rename it in anything the reorder or
 * inspect path handles (a custom template, an eval section override, the
 * subagent prompt) and the region is folded into its predecessor, nothing is
 * reported, and the model receives a prompt with a section silently merged away.
 * That is the same shape as the defect where a subagent's model setting appeared
 * to be honoured and was not.
 *
 * So these tests are differential on purpose: they feed the SAME mangled
 * document to both entry points and assert the behaviour is one behaviour. A
 * test that only checked "the strict path throws" would have passed throughout
 * the entire period the bug existed.
 */
import { describe, expect, it } from "bun:test";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import { bannerTable, splitBanneredDocument } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { splitDefaultTemplate } from "@veyyon/coding-agent/system-prompt-builder/default-template";
import {
	applyPromptSectionOrder,
	splitPromptSections,
} from "@veyyon/coding-agent/system-prompt-builder/prompt-sections";
import { BANNERED_TEMPLATE_SECTIONS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";

const TEMPLATE = PROMPTS["session/system-prompt"].text;
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

describe("both callers refuse the same broken document", () => {
	/**
	 * The differential that matters. Before unification the strict caller threw on
	 * this input and the lenient one returned a plausible-looking result with the
	 * region folded away, so the same template was "broken" or "fine" depending on
	 * which path reached it first.
	 */
	it("agrees that a renamed banner means a missing section", () => {
		const mangled = TEMPLATE.replace("TOOL POLICY\n==", "TOOL POLICE\n==");

		expect(() => splitDefaultTemplate(mangled)).toThrow(/tool-policy/);
		expect(() =>
			splitBanneredDocument(mangled, { banners: TEMPLATE_BANNERS, expect: EXPECTED, label: "test document" }),
		).toThrow(/tool-policy/);
	});

	/**
	 * The lenient view is still lenient, and that is a deliberate difference in
	 * POLICY rather than in parsing. A custom system prompt legitimately has no
	 * banners, so reporting it as broken would refuse a supported configuration.
	 * What changed is that leniency is now a caller's choice expressed by omitting
	 * `expect`, not a second parser that cannot be strict at all.
	 */
	it("still reads a bannerless document as one region rather than an error", () => {
		const regions = splitPromptSections("just prose, no banners anywhere", TEMPLATE_BANNERS);

		expect(regions).toEqual([{ name: "preamble", text: "just prose, no banners anywhere" }]);
	});

	/** Out-of-order banners are a different repair, so they get a different error. */
	it("reports order separately from absence, naming both sections", () => {
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

	/** The error must say which document, or a reader cannot find the file. */
	it("names the document it was reading", () => {
		expect(() => splitDefaultTemplate(TEMPLATE.replace("ROLE\n==", "ROLES\n=="))).toThrow(
			/the default system prompt/,
		);
	});
});

describe("one scan, two separator conventions", () => {
	/**
	 * The template slicer reassembles a FILE, so its regions must carry every byte
	 * including the newline before the next banner. `assembleDefaultTemplate()`
	 * with no overrides has to equal the shipped file exactly, or an experiment
	 * that overrides one section silently reformats the rest.
	 */
	it("rejoins the shipped template byte for byte with an empty separator", () => {
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
