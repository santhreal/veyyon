import { isRecord, kebabToCamel } from "@veyyon/utils";
import { PROMPTS } from "../prompts/registry";
import { bannerTable, describeBanner, startsWithBanner } from "./banner-grammar";
import { splitBanneredDocument } from "./prompt-sections";
import { BANNERED_TEMPLATE_SECTIONS, TEMPLATE_SECTION_CAMEL_KEYS } from "./section-registry";

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

/** The shipped default sections, sliced once from the single source file. */
export const DEFAULT_TEMPLATE_SECTIONS: DefaultTemplateSections = splitDefaultTemplate(
	PROMPTS["session/system-prompt"].text,
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
 */
export function resolveSectionOverrides(
	raw: Readonly<Record<string, unknown>> | undefined,
): Partial<DefaultTemplateSections> {
	if (!raw) return {};
	const valid = new Set<string>(DEFAULT_TEMPLATE_SECTION_ORDER);
	const out: Partial<DefaultTemplateSections> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!valid.has(key)) {
			throw new Error(
				`section override names unknown section "${key}"; ` +
					`valid sections: ${DEFAULT_TEMPLATE_SECTION_ORDER.join(", ")}`,
			);
		}
		if (typeof value !== "string") {
			throw new Error(
				`section override for "${key}" must be a string, got ${value === null ? "null" : typeof value}`,
			);
		}
		const name = SECTION_REQUIRED_BANNER[key as keyof DefaultTemplateSections];
		if (name && !startsWithBanner(value, name)) {
			throw new Error(
				`section override for "${key}" must begin with its section banner: ${describeBanner(name)}, ` +
					"so the banner boundary is preserved. A section override replaces one banner region and " +
					"MUST keep that region's banner; start from the shipped section text.",
			);
		}
		out[key as keyof DefaultTemplateSections] = value;
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
