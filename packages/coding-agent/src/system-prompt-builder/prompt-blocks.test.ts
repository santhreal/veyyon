/**
 * The prompt-section registry contract.
 *
 * WHY THIS SUITE EXISTS. The system prompt was described in three places that
 * could disagree, and the disagreement could be silent:
 *
 *   - `default-template.ts` declared the template's banner sections one way
 *     (camelCase keys, `indexOf` byte-offset splitting) for eval overrides.
 *   - `prompt-sections.ts` declared the SAME sections a second, independent way
 *     (kebab names, line-by-line splitting) for runtime reordering.
 *   - `system-prompt.ts` appended further blocks with ad-hoc `push()` calls.
 *     Those had no banners, so they appeared in neither: they could not be
 *     reordered and could not be overridden.
 *
 * Nothing forced the two section tables to agree, and their failure modes were
 * asymmetric: the offset splitter THROWS on a missing banner while the line
 * splitter silently folds the section into its predecessor. So one view of the
 * prompt could quietly lose a boundary the other still saw.
 *
 * The appended group was the worse problem. That split tracked PROVENANCE (text
 * from the .md file vs text computed at runtime) and leaked it into the prompt's
 * structure as a capability difference — the shorthand notation, the section an
 * eval most wants to ablate, sat in the tier the override mechanism could not
 * reach. There is now one model: an ordered list of banner-delimited sections,
 * with `source` recording provenance and conferring nothing.
 *
 * These tests lock that: both derived tables come from the registry, and runtime
 * sections are addressable exactly like template ones.
 */

import { describe, expect, it } from "bun:test";
import { kebabToCamel } from "@veyyon/utils";
import { PROMPTS } from "../prompts/registry";
import { assembleDefaultTemplate, DEFAULT_TEMPLATE_SECTION_ORDER } from "./default-template";
import {
	BANNERED_SECTIONS,
	BANNERED_TEMPLATE_SECTIONS,
	PROMPT_SECTIONS,
	RUNTIME_SECTION_IDS,
	RUNTIME_SECTIONS,
	TEMPLATE_SECTION_IDS,
	TEMPLATE_SECTIONS,
	withSectionBanner,
} from "./prompt-blocks";
import { promptSectionNames, splitPromptSections } from "./prompt-sections";

describe("prompt-section registry: structural invariants", () => {
	/** Ids are the join key for every derived table, so a duplicate would make one
	 * of them silently shadow the other. */
	it("gives every section a unique id", () => {
		const ids = PROMPT_SECTIONS.map(s => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	/** The registry is only authoritative if it is exhaustive. */
	it("accounts for every section as either template- or runtime-sourced", () => {
		expect(TEMPLATE_SECTIONS.length + RUNTIME_SECTIONS.length).toBe(PROMPT_SECTIONS.length);
		expect(PROMPT_SECTIONS.every(s => s.source === "template" || s.source === "runtime")).toBe(true);
	});

	/** The declared id lists are what the literal-union types are built from, so a
	 * table that drifts from its id list would make the compile-time exhaustiveness
	 * checks describe a different set than the runtime registry. */
	it("keeps each section table in step with the id list its union is built from", () => {
		expect(TEMPLATE_SECTIONS.map(s => s.id)).toEqual([...TEMPLATE_SECTION_IDS]);
		expect(RUNTIME_SECTIONS.map(s => s.id)).toEqual([...RUNTIME_SECTION_IDS]);
	});

	/** `conventions` is the leading region, DEFINED as whatever precedes the first
	 * banner, so it is the only section that can lack one. A runtime section with
	 * no banner would be unaddressable — the exact old defect. */
	it("gives every section a banner except the leading conventions region", () => {
		const withoutBanner = PROMPT_SECTIONS.filter(s => s.banner === null).map(s => s.id);
		expect(withoutBanner).toEqual(["conventions"]);
		expect(RUNTIME_SECTIONS.every(s => s.banner.length > 0)).toBe(true);
	});

	/** A registry nobody can read is a lookup table, not documentation. */
	it("documents a purpose for every section", () => {
		expect(PROMPT_SECTIONS.filter(s => !s.purpose.trim()).map(s => s.id)).toEqual([]);
	});
});

describe("prompt-section registry: the shipped template agrees with the registry", () => {
	/** THE anti-divergence lock for the template file. A renamed banner used to
	 * require edits in two hand-written tables; now it fails here instead of
	 * silently changing one view of the prompt. */
	it("finds every registered template banner in the shipped template, in order", () => {
		let from = 0;
		for (const section of BANNERED_TEMPLATE_SECTIONS) {
			const at = PROMPTS["system/system-prompt"].text.indexOf(section.banner, from);
			expect({ id: section.id, found: at >= 0 }).toEqual({ id: section.id, found: true });
			from = at + section.banner.length;
		}
	});

	/** The whole override mechanism rests on reassembly being lossless. */
	it("reassembles the template byte-for-byte from its registered sections", () => {
		expect(assembleDefaultTemplate()).toBe(PROMPTS["system/system-prompt"].text);
	});

	/** The template splitter must look for exactly the banners the .md contains. A
	 * runtime banner is not in that file, and searching for one would throw. */
	it("excludes runtime sections from the template-file view", () => {
		const templateIds = new Set<string>(BANNERED_TEMPLATE_SECTIONS.map(s => s.id));
		for (const id of RUNTIME_SECTION_IDS) expect(templateIds.has(id)).toBe(false);
	});
});

describe("prompt-section registry: derived tables cannot drift apart", () => {
	/** The consumers spell sections differently (`toolPolicy` vs `tool-policy`).
	 * That is fine only while one spelling is a pure function of the other. */
	it("keeps the override key order identical to the registry section order", () => {
		expect(DEFAULT_TEMPLATE_SECTION_ORDER.map(String)).toEqual(TEMPLATE_SECTION_IDS.map(kebabToCamel));
	});

	/** The reorderer must see EVERY bannered section, runtime included. This is the
	 * unification in one assertion: before it, the list stopped at the template. */
	it("makes every bannered section reorderable, runtime sections included", () => {
		expect([...promptSectionNames()]).toEqual(BANNERED_SECTIONS.map(s => s.id));
		for (const id of RUNTIME_SECTION_IDS) expect(promptSectionNames()).toContain(id);
	});
});

describe("prompt-section registry: runtime sections are first-class", () => {
	const shorthand = RUNTIME_SECTIONS.find(s => s.id === "shorthand");
	if (!shorthand) throw new Error("the shorthand runtime section is missing from the registry");

	/** Runtime banners are owned by the registry (their text is computed, so no
	 * document carries one). Prepending at assembly keeps ONE owner instead of
	 * asking every producer to remember a banner. */
	it("prefixes a runtime section's text with its registered banner", () => {
		const out = withSectionBanner(shorthand, "notation body");
		expect(out.startsWith("SHORTHAND\n==")).toBe(true);
		expect(out).toContain("notation body");
	});

	/** A heading promising content that is not there reads as a truncation bug to
	 * the model, so an absent section must stay fully absent — banner included. */
	it("emits nothing at all for empty or whitespace-only text", () => {
		expect(withSectionBanner(shorthand, undefined)).toBe("");
		expect(withSectionBanner(shorthand, "")).toBe("");
		expect(withSectionBanner(shorthand, "   \n  ")).toBe("");
	});

	/** The payoff: a banner-carrying runtime section is recognised by the SAME
	 * line splitter that handles template sections, so it reorders and overrides
	 * identically. This is precisely what the appended tier could never do. */
	it("is recognised by the shared splitter, exactly like a template section", () => {
		const names = splitPromptSections(withSectionBanner(shorthand, "notation body"))
			.filter(s => s.name !== "preamble")
			.map(s => s.name);
		expect(names).toEqual(["shorthand"]);
	});
});
