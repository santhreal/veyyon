import { isRecord, kebabToCamel } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";
import { bannerTable, describeBanner, splitBanneredDocument, startsWithBanner } from "./banner-grammar";
import { BANNERED_TEMPLATE_SECTIONS, TEMPLATE_SECTION_CAMEL_KEYS, TEMPLATE_SECTION_IDS } from "./section-registry";
import {
	assembleSection,
	STATEMENT_SECTIONS,
	type StatementContext,
	type StatementOverrides,
} from "./statement-registry";

/**
 * Composition seam for the default system-prompt template.
 *
 * WHY THIS EXISTS: the template is one file (`prompts/session/system-prompt.md`)
 * so a human can read it top to bottom, and the rewrite tooling and the
 * `--all` prompt glob can treat it as a single document. But prompt experiments
 * want to swap ONE region — say the tool-policy block — while leaving every
 * other region, and every `{{#if <setting>}}` conditional in it, byte-for-byte
 * untouched. Editing the monolith by hand is how delegation settings
 * (`taskIrcEnabled`, `eagerTasksAlways`) were silently dropped: an edit meant
 * for one region deleted a branch in another.
 *
 * This module keeps the single source file AND exposes a section view of it.
 * The file's own top-level banners (`ROLE\n====`, `TOOL POLICY\n====`, …) are
 * the section boundaries, so the decomposition mirrors the document's existing
 * structure rather than inventing a new one — the same banners
 * `prompt-sections.ts` keys off for reordering. Splitting on the banner start
 * offsets and rejoining with an empty separator reproduces the file
 * byte-for-byte, so `assembleDefaultTemplate()` with no overrides equals the
 * original template exactly.
 */

/** A named region of the default template, in document order. */
export interface DefaultTemplateSections {
	/** `<system-conventions>` preamble, before the ROLE banner. */
	conventions: string;
	/** ROLE banner section: who the agent is. */
	role: string;
	/** RUNTIME banner section: workstation, tool inventory, memory. */
	runtime: string;
	/** TOOL POLICY banner section: tool rules, delegation, LSP/AST. */
	toolPolicy: string;
	/** EXECUTION WORKFLOW banner section: how work is carried out. */
	executionWorkflow: string;
	/** DELIVERY CONTRACT banner section: output contract, personality. */
	deliveryContract: string;
}

/**
 * Canonical section order. Concatenation reproduces the original template.
 *
 * DERIVED from the one registry in `section-registry.ts`, not written out here.
 * This list and the banner table below used to be hand-maintained alongside a
 * second, independent copy in `prompt-sections.ts`; renaming a section meant
 * editing both, and nothing caught it when only one was updated.
 */
export const DEFAULT_TEMPLATE_SECTION_ORDER = TEMPLATE_SECTION_CAMEL_KEYS as readonly (keyof DefaultTemplateSections)[];

/**
 * The banner line that opens each non-preamble section, matched verbatim at the
 * start of a line. `conventions` has no banner: it is whatever precedes ROLE.
 * Order matters — the banners must appear in the template in this sequence, and
 * that order is the registry's document order.
 */
const SECTION_BANNERS: readonly { key: keyof DefaultTemplateSections; name: string }[] = BANNERED_TEMPLATE_SECTIONS.map(
	b => ({
		key: kebabToCamel(b.id) as keyof DefaultTemplateSections,
		name: b.name,
	}),
);

/** The template's bannered sections, in the order the document must present them. */
const EXPECTED_TEMPLATE_SECTIONS = BANNERED_TEMPLATE_SECTIONS.map(b => ({ id: b.id as string, name: b.name }));

/**
 * Split the single template file into its named sections.
 *
 * Fails loudly if a banner is missing or out of order, because a missing banner
 * would collapse two sections into one and let an override target the wrong
 * region. That refusal now comes from `splitBanneredDocument`'s `expect`, which
 * is the SAME parser the reorder and inspection paths use. This file used to
 * carry its own `indexOf` scanner, so the product had two implementations of one
 * grammar that disagreed on exactly this point: this one threw, the other folded
 * the missing region into its predecessor and reported nothing. Sharing the
 * parser is what makes the two agree; `expect` is what keeps this caller strict.
 *
 * Each section keeps its banner and all trailing content up to the next banner,
 * so the slices rejoin with `""` byte-for-byte.
 */
export function splitDefaultTemplate(template: string): DefaultTemplateSections {
	const regions = splitBanneredDocument(template, {
		banners: bannerTable(BANNERED_TEMPLATE_SECTIONS),
		expect: EXPECTED_TEMPLATE_SECTIONS,
		label: "the default system prompt",
	});
	// The registry's kebab ids are the parser's vocabulary; the camelCase keys are
	// a view for the override API. Converting here keeps that a rename rather than
	// a second parse, which is what the two-spelling split used to be.
	const parts = regions.map(
		region =>
			[
				(region.name === "preamble"
					? DEFAULT_TEMPLATE_SECTION_ORDER[0]
					: kebabToCamel(region.name)) as keyof DefaultTemplateSections,
				region.text,
			] as const,
	);
	return Object.fromEntries(parts) as unknown as DefaultTemplateSections;
}

/**
 * The shipped default sections, sliced once from the single source file.
 *
 * WHAT THIS IS NOW, which is not what it was. Every one of these six sections is assembled from the
 * statement registry and spliced in over the top (see {@link statementSectionOverrides}), so no BODY
 * here reaches a model: `system-prompt.md` supplies the document's shape, and the statements supply
 * its text. `statement-wiring.test.ts` asserts that every key is covered, so this cannot quietly
 * become a second source of prompt text again.
 *
 * The file keeps its copy of each section on purpose, as the FROZEN PRE-MIGRATION REFERENCE the byte
 * gate compares against: `statement-assembly.test.ts` and `statement-wiring.test.ts` render both
 * documents across a 33-point matrix and assert the words are identical. Deleting the copy would
 * remove the only independent statement of what the prompt said before the migration and leave a
 * snapshot of the registry's own output in its place, which proves nothing about the conversion. It is
 * test data with a shape, not a second owner.
 */
export const DEFAULT_TEMPLATE_SECTIONS: DefaultTemplateSections = splitDefaultTemplate(
	sessionPrompts["session/system-prompt"].text,
);

/**
 * Assemble the default template from its sections. Pass `overrides` to swap
 * individual sections for an experiment without disturbing the rest; omit it to
 * get the shipped template verbatim (byte-for-byte identical to the source
 * file).
 */
export function assembleDefaultTemplate(overrides: Partial<DefaultTemplateSections> = {}): string {
	const sections = { ...DEFAULT_TEMPLATE_SECTIONS, ...overrides };
	return DEFAULT_TEMPLATE_SECTION_ORDER.map(key => sections[key]).join("");
}

/**
 * The converted sections' text, as overrides for {@link assembleDefaultTemplate}.
 *
 * THIS IS THE SEAM THE STATEMENT REGISTRY REACHES THE PRODUCT THROUGH, and it is deliberately the
 * override seam rather than a branch inside `assembleDefaultTemplate`. That function's contract is
 * that with no overrides it returns the shipped file byte-for-byte, which `default-template.test.ts`
 * asserts; splicing statements inside it would break that contract and, worse, would make the
 * function's output depend on a render context it has no business knowing about. As an override map
 * the statements go through the one path that already guarantees, in `resolveSectionOverrides`'s
 * words, that overriding one section never touches another.
 *
 * The result is TEMPLATE text: `{{#each}}`, `{{toolRefs.task}}` and intra-line `{{#if}}` are still
 * unexpanded, because the caller splices this into the document it renders once. See
 * `assembleSection`.
 *
 * OPERATOR OVERRIDES WIN over statements, which is why the caller spreads this map FIRST. An
 * operator who replaces a section is replacing its text, and statements are text; a converted
 * section that ignored `.veyyon/prompt-sections/role.md` because its bytes now come from a registry
 * would be a feature quietly lost to a refactor. `statement-wiring.test.ts` pins the precedence.
 *
 * AND IT TRANSLATES BETWEEN THE TWO SEPARATOR CONVENTIONS, which is the one subtlety here and was a
 * real one-byte bug before it was: the whole prompt came out two bytes short and the difference was
 * the blank line before `ROLE`. `prompt-sections.ts` documents both conventions on one splitter. The
 * SLICER view, which `splitDefaultTemplate` uses and {@link assembleDefaultTemplate} joins with
 * `""`, keeps each section's trailing separator INSIDE the section, because it reassembles a file.
 * The REORDERER view keeps the separator between sections, because a section that carried one would
 * drag a stray newline along when it moved. `assembleSection` produces the reorderer's shape, since
 * a statement must not own a byte that only exists because of where its section currently sits. So
 * the separator is added here, where the function knows it is producing slicer input, and the last
 * section gets none because there is nothing after it to separate from.
 *
 * The separator is one newline, which is the same thing `applyPromptSectionOrder` joins with. It is
 * not measured off the section being replaced: reading the file's copy of a section to learn how to
 * replace it would make the statements agree with the template by construction and the byte gates
 * would have nothing left to prove.
 */
export function statementSectionOverrides(
	context: StatementContext,
	statementOverrides: StatementOverrides = {},
): Partial<DefaultTemplateSections> {
	const lastSection = DEFAULT_TEMPLATE_SECTION_ORDER[DEFAULT_TEMPLATE_SECTION_ORDER.length - 1];
	const entries = STATEMENT_SECTIONS.map(section => {
		const key = kebabToCamel(section) as keyof DefaultTemplateSections;
		const separator = key === lastSection ? "" : "\n";
		return [key, `${assembleSection(section, context, statementOverrides)}${separator}`] as const;
	});
	return Object.fromEntries(entries) as Partial<DefaultTemplateSections>;
}

/** The banner name each section must lead with. `conventions` has no banner. */
const SECTION_REQUIRED_BANNER: Partial<Record<keyof DefaultTemplateSections, string>> = Object.fromEntries(
	SECTION_BANNERS.map(({ key, name }) => [key, name]),
);

/**
 * Validate a raw `section -> replacement text` map (from
 * `systemPrompt.sectionOverrides` config) into a typed override map for
 * {@link assembleDefaultTemplate}.
 *
 * This is the single-section-experiment entry point, and it fails closed on
 * both ways an override could silently corrupt the prompt:
 *
 * 1. An unknown section name is rejected loudly. Silently ignoring it would run
 *    the eval against the UNMODIFIED prompt while the operator believes their
 *    change is live — a false result with no signal.
 * 2. A replacement that drops its section banner is rejected loudly. Each
 *    section is a `NAME\n====` banner region; `splitDefaultTemplate` and
 *    `prompt-sections.ts` both key off those banners. A replacement missing its
 *    banner would collapse two sections into one on the next split and let a
 *    later override target the wrong region — the exact silent-drop this seam
 *    exists to prevent. Requiring the banner also forces the author to edit the
 *    real section rather than hand-write a fresh block that quietly omits a
 *    settings-gated branch (e.g. the `{{#if eagerTasks}}` delegation block that
 *    lives in another section entirely).
 *
 * Overriding one section NEVER touches another: every non-overridden section,
 * and every `{{#if <setting>}}` conditional inside it, is reused byte-for-byte
 * from the shipped template, so a per-section override can never override a
 * setting or remove an unrelated block.
 *
 * A SECTION MAY BE NAMED EITHER WAY, and the reason is that this validator used
 * to accept only one of two spellings the product uses for the same six
 * sections. The registry's ids are kebab-case (`tool-policy`), and that is what
 * `veyyon prompt --sections` prints, what `.veyyon/PROMPT_SECTIONS/<id>.md`
 * files are named, what statement ids are prefixed with, and what every page of
 * `docs/system-prompt-customization.md` shows. The camelCase keys here exist
 * only because they are TypeScript property names. So an operator who read the
 * documentation, wrote `tool-policy` in config, and got told the valid sections
 * were `toolPolicy` and five other names they had never seen was being punished
 * for a spelling the product never showed them. Both spellings resolve to the
 * same section, and the error lists the kebab ids because those are the ones
 * the rest of the product speaks.
 */
export function resolveSectionOverrides(
	raw: Readonly<Record<string, unknown>> | undefined,
): Partial<DefaultTemplateSections> {
	if (!raw) return {};
	const bySection = new Map<string, keyof DefaultTemplateSections>([
		...DEFAULT_TEMPLATE_SECTION_ORDER.map(key => [key, key] as const),
		...TEMPLATE_SECTION_IDS.map(id => [id, kebabToCamel(id) as keyof DefaultTemplateSections] as const),
	]);
	const out: Partial<DefaultTemplateSections> = {};
	for (const [rawKey, value] of Object.entries(raw)) {
		const key = bySection.get(rawKey);
		if (key === undefined) {
			throw new Error(
				`section override names unknown section "${rawKey}"; ` +
					`valid sections: ${TEMPLATE_SECTION_IDS.join(", ")}`,
			);
		}
		if (typeof value !== "string") {
			throw new Error(
				`section override for "${rawKey}" must be a string, got ${value === null ? "null" : typeof value}`,
			);
		}
		// Echo what the operator WROTE, not the normalized key, or an operator who
		// used the kebab spelling reads an error about a name they did not type.
		const name = SECTION_REQUIRED_BANNER[key];
		if (name && !startsWithBanner(value, name)) {
			throw new Error(
				`section override for "${rawKey}" must begin with its section banner: ${describeBanner(name)}, ` +
					"so the banner boundary is preserved. A section override replaces one banner region and " +
					"MUST keep that region's banner; start from the shipped section text.",
			);
		}
		out[key] = value;
	}
	return out;
}

/**
 * Parse and validate the eval-only section-override payload carried by the
 * `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` environment variable (a JSON object of
 * `section -> replacement text`). This is a PURE parser — reading the env var,
 * gating, and the loud "non-production prompt" log live in the prompt builder.
 *
 * Every malformed input fails loudly rather than silently disabling the
 * override (which would run the eval against the production prompt while the
 * operator believes their change is live): non-JSON, a non-object payload, and
 * — via {@link resolveSectionOverrides} — unknown sections, non-string values,
 * and banner-less replacements all throw. An empty/whitespace value is the
 * only quiet case: it means "no override", the production prompt.
 */
export function parseSectionOverridesJson(raw: string | undefined): Partial<DefaultTemplateSections> {
	if (raw === undefined || raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS is set but is not valid JSON: ${err}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(
			"VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS must be a JSON object of section -> replacement text, " +
				`got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}`,
		);
	}
	return resolveSectionOverrides(parsed);
}
