/**
 * Registry of every section in the model's system prompt.
 *
 * Declares section identity, order, purpose, source class, and banner name.
 * Statement modules provide static text; runtime producers supply volatile text.
 */
import { kebabToCamel, type PromptSection } from "@veyyon/utils";
import { hasBanner, renderBanner } from "./banner-grammar";

export interface TemplateSection extends PromptSection {
	readonly source: "template";
}

/**
 * Source origin for a runtime section's text.
 *
 * `option` is passed by the caller to `buildSystemPrompt`; `computed` is produced
 * directly by the builder.
 */
export type RuntimeSectionInput = { readonly kind: "computed" } | { readonly kind: "option"; readonly key: string };

export interface RuntimeSection extends PromptSection {
	readonly source: "runtime";
	/** Runtime sections always carry a registry-owned banner, so never `null`. */
	readonly name: string;
	readonly input: RuntimeSectionInput;
}

/**
 * A row in the system prompt's section list: static-prefix or runtime-sourced.
 *
 * This union extends the shared `PromptSection` shape with source information
 * used for provider-cache boundaries.
 */
export type SystemPromptSection = TemplateSection | RuntimeSection;

/**
 * Static cached-prefix sections in model-visible order.
 *
 * Bodies come from statement modules and are inserted into the outer template.
 */
export const TEMPLATE_SECTIONS = [
	{
		id: "conventions",
		source: "template",
		name: null,
		purpose: "<system-conventions> preamble, everything before the ROLE banner",
		optional: false,
	},
	{ id: "role", source: "template", name: "ROLE", purpose: "who the agent is", optional: false },
	{
		id: "runtime",
		source: "template",
		name: "RUNTIME",
		purpose: "workstation, tool inventory, memory",
		optional: false,
	},
	{
		id: "tool-policy",
		source: "template",
		name: "TOOL POLICY",
		purpose: "tool rules, delegation, LSP/AST",
		optional: false,
	},
	{
		id: "execution-workflow",
		source: "template",
		name: "EXECUTION WORKFLOW",
		purpose: "how work is carried out",
		optional: false,
	},
	{
		id: "delivery-contract",
		source: "template",
		name: "DELIVERY CONTRACT",
		purpose: "output contract, personality",
		optional: false,
	},
] as const satisfies readonly TemplateSection[];

/**
 * Sections assembled from runtime state, in emission order.
 *
 * Preserves literal types via `as const satisfies` so downstream code can
 * query computed section IDs and option keys directly from this array.
 */
export const RUNTIME_SECTIONS = [
	{
		id: "project",
		source: "runtime",
		name: "PROJECT",
		input: { kind: "computed" },
		purpose: "environment, cwd, context files, workspace tree, active repo context",
		// Renders even with an empty workspace tree and no context files: it always
		// carries at least the environment framing and the cwd.
		optional: false,
	},
	{
		id: "shorthand",
		source: "runtime",
		name: "SHORTHAND",
		input: { kind: "option", key: "argotPreamble" },
		purpose: "the shorthand notation block, taught when the encode gate is open",
		optional: true,
	},
	{
		id: "shorthand-handles",
		source: "runtime",
		name: "SHORTHAND HANDLES",
		input: { kind: "option", key: "argotHandles" },
		purpose: "the handle table for loaded projects, so the model can learn the handles at all",
		optional: true,
	},
	{
		id: "available-secrets",
		source: "runtime",
		name: "AVAILABLE SECRETS",
		input: { kind: "option", key: "secretInventory" },
		purpose:
			"the credential placeholders this session can actually spend, named but never valued, so a session that did not watch them being stored still knows they exist",
		optional: true,
	},
] as const satisfies readonly RuntimeSection[];

/** One entry of {@link TEMPLATE_SECTIONS}, with its literal id and name intact. */
export type TemplateSectionEntry = (typeof TEMPLATE_SECTIONS)[number];

/** One entry of {@link RUNTIME_SECTIONS}, with its literal id, kind and key intact. */
export type RuntimeSectionEntry = (typeof RUNTIME_SECTIONS)[number];

export type TemplateSectionId = TemplateSectionEntry["id"];
export type RuntimeSectionId = RuntimeSectionEntry["id"];

/** Template section IDs in document order, derived from {@link TEMPLATE_SECTIONS}. */
export const TEMPLATE_SECTION_IDS: readonly TemplateSectionId[] = TEMPLATE_SECTIONS.map(section => section.id);

/** The ids of the runtime sections, in emission order, read off the rows. */
export const RUNTIME_SECTION_IDS: readonly RuntimeSectionId[] = RUNTIME_SECTIONS.map(section => section.id);

/**
 * IDs of sections whose text the builder produces, derived from registry rows
 * with `input.kind === "computed"`.
 */
export type ComputedRuntimeSectionId = Extract<RuntimeSectionEntry, { input: { kind: "computed" } }>["id"];

/** Option keys declared by the registry as a union of string literals. */
export type OptionBackedSectionKey = Extract<RuntimeSectionEntry, { input: { kind: "option" } }>["input"]["key"];

/** Banner introducing the argot handle table, derived from the registered section. */
const SHORTHAND_HANDLES_SECTION = RUNTIME_SECTIONS[2];

/** Compile-time assertion that the positional index matches `shorthand-handles`. */
const _assertHandlesRow: (typeof SHORTHAND_HANDLES_SECTION)["id"] extends "shorthand-handles" ? true : never = true;
void _assertHandlesRow;

export const ARGOT_HANDLES_BANNER: string = renderBanner(SHORTHAND_HANDLES_SECTION.name);

/** Every section, in the order it reaches the model. */
export const SYSTEM_PROMPT_SECTIONS: readonly SystemPromptSection[] = [...TEMPLATE_SECTIONS, ...RUNTIME_SECTIONS];

/**
 * All banner-bearing sections in order (template and runtime).
 *
 * Used by splitter and reorderer so all bannered sections are addressable.
 */
export const BANNERED_SECTIONS: readonly (SystemPromptSection & { name: string })[] =
	SYSTEM_PROMPT_SECTIONS.filter(hasBanner);

/**
 * Banner-bearing static sections.
 *
 * These rows define the banner table used to split, inspect, override, and
 * reorder the statement-assembled cached prefix.
 */
export const BANNERED_TEMPLATE_SECTIONS: readonly (TemplateSection & { name: string })[] =
	TEMPLATE_SECTIONS.filter(hasBanner);

/** Type-level counterpart to {@link kebabToCamel} for registry-derived keys. */
type KebabToCamelKey<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${Head}${Capitalize<KebabToCamelKey<Tail>>}`
	: Value;

/** Internal camel-case key for one static section. */
export type TemplateSectionKey = KebabToCamelKey<TemplateSectionId>;

/** CamelCase override keys for template sections in document order. */
export const TEMPLATE_SECTION_CAMEL_KEYS: readonly TemplateSectionKey[] = TEMPLATE_SECTION_IDS.map(
	kebabToCamel,
) as TemplateSectionKey[];

/**
 * Prefix assembled section body text with its registered banner.
 * Returns empty string if body text is missing or whitespace-only.
 */
export function withSectionBanner(
	section: SystemPromptSection & { readonly name: string },
	text: string | undefined,
): string {
	const body = text?.trim();
	if (!body) return "";
	return `${renderBanner(section.name)}\n\n${body}`;
}

/** Runtime sections whose text arrives as a `buildSystemPrompt` option. */
export type OptionBackedRuntimeSection = Extract<RuntimeSectionEntry, { input: { kind: "option" } }>;

/** Type guard narrowing a registry row to option-backed runtime sections. */
export function isOptionBackedSection(section: RuntimeSectionEntry): section is OptionBackedRuntimeSection {
	return section.input.kind === "option";
}

export const OPTION_BACKED_RUNTIME_SECTIONS: readonly OptionBackedRuntimeSection[] =
	RUNTIME_SECTIONS.filter(isOptionBackedSection);
