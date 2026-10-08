import { isRecord, kebabToCamel } from "@veyyon/utils";
import { sessionPrompts } from "../prompts/session/rows";
import { assertNoRegisteredBanners, bannerTable } from "./banner-grammar";
import {
	SYSTEM_PROMPT_SECTIONS,
	TEMPLATE_SECTION_CAMEL_KEYS,
	TEMPLATE_SECTION_IDS,
	TEMPLATE_SECTIONS,
	type TemplateSectionKey,
	withSectionBanner,
} from "./section-registry";
import {
	STATEMENT_SECTIONS,
	type StatementContext,
	type StatementOverrides,
	sectionTemplates,
} from "./statement-registry";

const SYSTEM_SECTION_BANNERS = bannerTable(SYSTEM_PROMPT_SECTIONS);

/**
 * The default prompt template is deliberately only one structural slot.
 *
 * Prompt prose belongs to statement modules. Section names, order, and banners
 * belong to the registries. Keeping prose or banners in the template would
 * create a second source that could drift from the modular assembly.
 */
export const DEFAULT_TEMPLATE_SLOT = "{{templateSections}}";

const DEFAULT_TEMPLATE_SOURCE = sessionPrompts["session/system-prompt"].text;

/** Complete static section map, derived from the registry's section-id union. */
export type DefaultTemplateSections = Record<TemplateSectionKey, string>;

/** Every static section as the templates it is written from ({@link sectionTemplates}). */
export type DefaultTemplateSectionTemplates = Record<TemplateSectionKey, readonly string[]>;

/** Canonical section order, derived from the section registry. */
export const DEFAULT_TEMPLATE_SECTION_ORDER = TEMPLATE_SECTION_CAMEL_KEYS;

/**
 * Fail at module load if prose or section structure returns to the template.
 *
 * Whitespace around the slot is harmless source formatting. Any other token is
 * a second prompt source and is rejected before a session can start.
 */
function assertModularDefaultTemplate(source: string): void {
	if (source.trim() === DEFAULT_TEMPLATE_SLOT) return;
	throw new Error(
		"prompts/session/system-prompt.md must contain only {{templateSections}}. " +
			"Put prompt prose in system-prompt-builder/statements and section structure in the registries.",
	);
}

assertModularDefaultTemplate(DEFAULT_TEMPLATE_SOURCE);

/**
 * The complete modular section body as the templates it is written from: each section's
 * templates, or its override where one is given, in canonical order, with one newline between
 * adjacent sections. `buildSystemPrompt` renders them with `prompt.renderSequence`.
 *
 * Requiring every section removes the old fallback to prose copied into the
 * template. A missing statement section is already rejected by the statement
 * registry, and TypeScript rejects an incomplete section map here.
 */
export function defaultTemplatePieces(
	sections: DefaultTemplateSectionTemplates,
	overrides: Partial<DefaultTemplateSections> = {},
): string[] {
	const pieces: string[] = [];
	for (const [index, key] of DEFAULT_TEMPLATE_SECTION_ORDER.entries()) {
		if (index > 0) pieces.push("\n");
		const override = overrides[key];
		if (override === undefined) pieces.push(...sections[key]);
		else pieces.push(override);
	}
	return pieces;
}

/** The complete modular section body as one template: the {@link defaultTemplatePieces} of `sections`, joined. */
export function assembleDefaultTemplate(sections: DefaultTemplateSections): string {
	return defaultTemplatePieces(sectionsAsTemplates(sections)).join("");
}

/**
 * Every default-template section as the templates it is written from, from statement modules.
 *
 * Each entry is still Handlebars template text. The caller renders the complete
 * sequence as one document, so formatting and variable expansion remain
 * document-wide rather than varying with statement boundaries.
 */
export function assembleStatementSectionTemplates(
	context: StatementContext,
	statementOverrides: StatementOverrides = {},
): DefaultTemplateSectionTemplates {
	const entries = STATEMENT_SECTIONS.map(section => {
		const key = kebabToCamel(section) as TemplateSectionKey;
		return [key, sectionTemplates(section, context, statementOverrides)] as const;
	});
	return Object.fromEntries(entries) as unknown as DefaultTemplateSectionTemplates;
}

/** Every default-template section's template text: its {@link assembleStatementSectionTemplates}, joined. */
export function assembleStatementSections(
	context: StatementContext,
	statementOverrides: StatementOverrides = {},
): DefaultTemplateSections {
	return joinSectionTemplates(assembleStatementSectionTemplates(context, statementOverrides));
}

/** Each section's templates joined into its template text. */
export function joinSectionTemplates(sections: DefaultTemplateSectionTemplates): DefaultTemplateSections {
	const joined = Object.entries(sections).map(([key, templates]) => [key, templates.join("")] as const);
	return Object.fromEntries(joined) as unknown as DefaultTemplateSections;
}

/** Each section's template text as a one-template sequence. */
function sectionsAsTemplates(sections: DefaultTemplateSections): DefaultTemplateSectionTemplates {
	const wrapped = Object.entries(sections).map(([key, text]) => [key, [text]] as const);
	return Object.fromEntries(wrapped) as unknown as DefaultTemplateSectionTemplates;
}

/**
 * Validate and assemble a raw section-body replacement map.
 *
 * Unknown names and non-string values fail loudly. Replacement files contain
 * body text only. The assembler adds the registered banner, so banners cannot
 * drift or be duplicated by a custom section. Both operator-facing kebab-case
 * ids and the internal camel-case keys are accepted.
 */
export function resolveSectionOverrides(
	raw: Readonly<Record<string, unknown>> | undefined,
): Partial<DefaultTemplateSections> {
	if (!raw) return {};
	type Target = {
		readonly key: keyof DefaultTemplateSections;
		readonly section: (typeof TEMPLATE_SECTIONS)[number];
	};
	const bySection = new Map<string, Target>();
	for (const section of TEMPLATE_SECTIONS) {
		const key = kebabToCamel(section.id) as keyof DefaultTemplateSections;
		const target = { key, section };
		bySection.set(key, target);
		bySection.set(section.id, target);
	}

	const out: Partial<DefaultTemplateSections> = {};
	for (const [rawKey, value] of Object.entries(raw)) {
		const target = bySection.get(rawKey);
		if (target === undefined) {
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

		const { key, section } = target;
		assertNoRegisteredBanners(value, SYSTEM_SECTION_BANNERS, `section override for "${rawKey}"`);
		if (section.name === null) {
			out[key] = value;
			continue;
		}
		out[key] = withSectionBanner(section, value);
	}
	return out;
}

/**
 * Parse and validate the eval-only section-body override payload carried by
 * `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`.
 *
 * Malformed JSON, non-object payloads, unknown sections, non-string values, and
 * legacy values carrying their own banner all fail loudly. Empty input is the
 * only quiet case and means the production prompt.
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
