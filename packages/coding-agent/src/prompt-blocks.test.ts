/**
 * The prompt-block registry contract.
 *
 * WHY THIS SUITE EXISTS. The system prompt was described in three places that
 * could disagree, and the disagreement could be silent:
 *
 *   - `system-prompt-builder/default-template.ts` declared the five banner
 *     sections one way (camelCase keys, `indexOf` byte-offset splitting) for
 *     eval overrides.
 *   - `prompt-sections.ts` declared the SAME five sections a second, independent
 *     way (kebab names, line-by-line splitting) for runtime reordering.
 *   - `system-prompt.ts` appended four MORE blocks with ad-hoc `push()` calls,
 *     so they appeared in neither and could be neither overridden nor reordered.
 *
 * Nothing forced the two section tables to agree, and their failure modes were
 * asymmetric: the offset splitter THROWS on a missing banner while the line
 * splitter silently folds the section into its predecessor. So one view of the
 * prompt could quietly lose a section boundary the other still saw.
 *
 * Worse, the settings-parity guard could not see the appended tier at all. It
 * derives its gating identifiers from the template's `{{#if}}` conditionals, and
 * its render helper returns `systemPrompt[0]` — literally only the first block.
 * A block gated by a plain TypeScript `if` in the assembler could therefore stop
 * rendering entirely with every test still green, which is the exact class of
 * bug the parity guard was built to prevent, just relocated to where it could
 * not look.
 *
 * These tests lock the single registry that removes all three holes: both
 * section tables are DERIVED from it, the appended tier is assembled FROM it,
 * and adding a block without covering it fails here.
 */

import { describe, expect, it } from "bun:test";
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import {
	APPENDED_BLOCKS,
	BANNERED_SECTION_BLOCKS,
	camelSectionKey,
	PROMPT_BLOCKS,
	promptBlockById,
	TEMPLATE_SECTION_BLOCKS,
	TEMPLATE_SECTION_IDS,
} from "./prompt-blocks";
import { PROMPT_SECTION_NAMES, splitPromptSections } from "./prompt-sections";
import { assembleDefaultTemplate, DEFAULT_TEMPLATE_SECTION_ORDER } from "./system-prompt-builder/default-template";

describe("prompt-block registry: structural invariants", () => {
	/** Ids are the join key for every derived table, so a duplicate would make one
	 * of them silently shadow the other. */
	it("gives every block a unique id", () => {
		const ids = PROMPT_BLOCKS.map(b => b.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	/** The registry is only authoritative if it is exhaustive: every block is one
	 * of the two kinds, so nothing can sit outside both tiers. */
	it("classifies every block as a template section or an appended block", () => {
		expect(TEMPLATE_SECTION_BLOCKS.length + APPENDED_BLOCKS.length).toBe(PROMPT_BLOCKS.length);
	});

	/** `conventions` is the leading region with no banner of its own; every other
	 * template section must declare the banner that opens it, or the splitters
	 * cannot find its boundary. */
	it("declares a banner for every template section except the leading conventions block", () => {
		const withoutBanner = TEMPLATE_SECTION_BLOCKS.filter(b => b.banner === undefined).map(b => b.id);
		expect(withoutBanner).toEqual(["conventions"]);
	});

	/** Lookup is used by callers addressing a block by name; an unknown id must be
	 * undefined rather than a wrong block. */
	it("resolves blocks by id and returns undefined for an unknown one", () => {
		expect(promptBlockById("role")?.kind).toBe("template-section");
		expect(promptBlockById("shorthand-preamble")?.kind).toBe("appended");
		expect(promptBlockById("no-such-block")).toBeUndefined();
	});
});

describe("prompt-block registry: the shipped template agrees with the registry", () => {
	/** THE anti-divergence lock for tier 1. Every banner the registry claims must
	 * actually open a section in the shipped template. A renamed banner in the
	 * template used to require edits in two hand-written tables; now it fails
	 * here instead of silently changing one view of the prompt. */
	it("finds every registered banner in the shipped template, in registry order", () => {
		let from = 0;
		for (const block of BANNERED_SECTION_BLOCKS) {
			const at = systemPromptTemplate.indexOf(block.banner, from);
			expect({ id: block.id, found: at >= 0 }).toEqual({ id: block.id, found: true });
			from = at + block.banner.length;
		}
	});

	/** The registry order is not a preference, it is a fact about the template
	 * file, and the whole override mechanism rests on reassembly being lossless. */
	it("reassembles the template byte-for-byte from its registered sections", () => {
		expect(assembleDefaultTemplate()).toBe(systemPromptTemplate);
	});

	/** The rendered prompt is split by a DIFFERENT parser (line-based) than the
	 * one that builds the override map (offset-based). Both must recognise the
	 * same set of sections, which is precisely what silently diverged before. */
	it("makes both splitters recognise the same sections", () => {
		const viaLineSplitter = splitPromptSections(systemPromptTemplate)
			.filter(s => s.name !== "preamble")
			.map(s => s.name);
		expect(viaLineSplitter).toEqual(BANNERED_SECTION_BLOCKS.map(b => b.id));
	});
});

describe("prompt-block registry: derived tables cannot drift apart", () => {
	/** The two consumers spell sections differently (`toolPolicy` vs
	 * `tool-policy`). That is fine only while one spelling is a pure function of
	 * the other; it was a defect while both were hand-written lists. */
	it("derives the camelCase override keys from the canonical kebab ids", () => {
		expect(camelSectionKey("tool-policy")).toBe("toolPolicy");
		expect(camelSectionKey("execution-workflow")).toBe("executionWorkflow");
		expect(camelSectionKey("role")).toBe("role");
	});

	/** The override API's section order must be exactly the registry's template
	 * sections, in document order, or an override targets the wrong region. */
	it("keeps the override key order identical to the registry section order", () => {
		expect(DEFAULT_TEMPLATE_SECTION_ORDER.map(String)).toEqual(TEMPLATE_SECTION_IDS.map(camelSectionKey));
	});

	/** The reorderer's name list must be exactly the registry's bannered sections.
	 * When these were two independent literals, adding a banner to one and not the
	 * other left a section reorderable but not overridable, or vice versa. */
	it("keeps the reorderable section names identical to the registry banners", () => {
		expect([...PROMPT_SECTION_NAMES]).toEqual(BANNERED_SECTION_BLOCKS.map(b => b.id));
	});

	/** The strongest form of the same claim: the two derived tables describe the
	 * same sections as each other, so neither can gain or lose one alone. */
	it("keeps the override table and the reorder table describing the same sections", () => {
		const fromOverrides = DEFAULT_TEMPLATE_SECTION_ORDER.filter(k => k !== "conventions");
		expect(fromOverrides.map(String)).toEqual(PROMPT_SECTION_NAMES.map(camelSectionKey));
	});
});

describe("prompt-block registry: the appended tier is addressable", () => {
	/** The reason the tier exists in the registry at all. Each appended block is
	 * declared with a stable id so an eval can name it as a controlled variable
	 * and the parity contract can see it; previously they were anonymous pushes. */
	it("registers every block appended after the template, in emission order", () => {
		expect(APPENDED_BLOCKS.map(b => b.id)).toEqual([
			"project-footer",
			"repo-context",
			"shorthand-preamble",
			"shorthand-handles",
		]);
	});

	/** Order is now declared data rather than an artifact of statement order in
	 * the assembler, which is what makes it reviewable and changeable safely. */
	it("keeps appended blocks last, after every template section", () => {
		const ids = PROMPT_BLOCKS.map(b => b.id);
		const lastSection = Math.max(...TEMPLATE_SECTION_IDS.map(id => ids.indexOf(id)));
		const firstAppended = Math.min(...APPENDED_BLOCKS.map(b => ids.indexOf(b.id)));
		expect(firstAppended).toBeGreaterThan(lastSection);
	});

	/** Every block states what it carries. A registry nobody can read is a lookup
	 * table, not documentation, and the point is that the prompt be describable
	 * without reading the assembler. */
	it("documents a purpose for every block", () => {
		const undocumented = PROMPT_BLOCKS.filter(b => !b.purpose || b.purpose.trim() === "").map(b => b.id);
		expect(undocumented).toEqual([]);
	});
});
