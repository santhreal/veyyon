import { kebabToCamel, type PromptSection } from "@veyyon/utils";
import { hasBanner, renderBanner } from "./banner-grammar";

export interface TemplateSection extends PromptSection {
	readonly source: "template";
}

export type RuntimeSectionInput = { readonly kind: "computed" } | { readonly kind: "option"; readonly key: string };

export interface RuntimeSection extends PromptSection {
	readonly source: "runtime";
	readonly name: string;
	readonly input: RuntimeSectionInput;
}

export type SystemPromptSection = TemplateSection | RuntimeSection;

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

export const RUNTIME_SECTIONS = [
	{
		id: "project",
		source: "runtime",
		name: "PROJECT",
		input: { kind: "computed" },
		purpose: "environment, cwd, context files, workspace tree, active repo context",
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

export type TemplateSectionEntry = (typeof TEMPLATE_SECTIONS)[number];

export type RuntimeSectionEntry = (typeof RUNTIME_SECTIONS)[number];

export type TemplateSectionId = TemplateSectionEntry["id"];
export type RuntimeSectionId = RuntimeSectionEntry["id"];

export const TEMPLATE_SECTION_IDS: readonly TemplateSectionId[] = TEMPLATE_SECTIONS.map(section => section.id);

export const RUNTIME_SECTION_IDS: readonly RuntimeSectionId[] = RUNTIME_SECTIONS.map(section => section.id);

export type ComputedRuntimeSectionId = Extract<RuntimeSectionEntry, { input: { kind: "computed" } }>["id"];

export type OptionBackedSectionKey = Extract<RuntimeSectionEntry, { input: { kind: "option" } }>["input"]["key"];

const SHORTHAND_HANDLES_SECTION = RUNTIME_SECTIONS[2];

const _assertHandlesRow: (typeof SHORTHAND_HANDLES_SECTION)["id"] extends "shorthand-handles" ? true : never = true;
void _assertHandlesRow;

export const ARGOT_HANDLES_BANNER: string = renderBanner(SHORTHAND_HANDLES_SECTION.name);

export const SYSTEM_PROMPT_SECTIONS: readonly SystemPromptSection[] = [...TEMPLATE_SECTIONS, ...RUNTIME_SECTIONS];

export const BANNERED_SECTIONS: readonly (SystemPromptSection & { name: string })[] =
	SYSTEM_PROMPT_SECTIONS.filter(hasBanner);

export const BANNERED_TEMPLATE_SECTIONS: readonly (TemplateSection & { name: string })[] =
	TEMPLATE_SECTIONS.filter(hasBanner);

type KebabToCamelKey<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${Head}${Capitalize<KebabToCamelKey<Tail>>}`
	: Value;

export type TemplateSectionKey = KebabToCamelKey<TemplateSectionId>;

export const TEMPLATE_SECTION_CAMEL_KEYS: readonly TemplateSectionKey[] = TEMPLATE_SECTION_IDS.map(
	kebabToCamel,
) as TemplateSectionKey[];

export function withSectionBanner(
	section: SystemPromptSection & { readonly name: string },
	text: string | undefined,
): string {
	const body = text?.trim();
	if (!body) return "";
	return `${renderBanner(section.name)}\n\n${body}`;
}

export type OptionBackedRuntimeSection = Extract<RuntimeSectionEntry, { input: { kind: "option" } }>;

export function isOptionBackedSection(section: RuntimeSectionEntry): section is OptionBackedRuntimeSection {
	return section.input.kind === "option";
}

export const OPTION_BACKED_RUNTIME_SECTIONS: readonly OptionBackedRuntimeSection[] =
	RUNTIME_SECTIONS.filter(isOptionBackedSection);
