/**
 * The single registry of every section of the model's system prompt.
 *
 * WHY THIS EXISTS. The prompt used to be described in three places that could
 * disagree with each other, and one of them could disagree silently:
 *
 *   1. `default-template.ts` defined the template's banner sections one way
 *      (camelCase keys, `indexOf` byte-offset splitting) so evals could override
 *      one region.
 *   2. `prompt-sections.ts` defined the SAME sections a second, independent way
 *      (kebab-case names, line-by-line splitting) so the harness could reorder
 *      them.
 *   3. `system-prompt.ts` appended MORE blocks after the rendered template with
 *      ad-hoc `push()` calls. Those had no banners, so they appeared in neither
 *      of the above: they could not be reordered and could not be overridden.
 *
 * That third group was the real damage. It made the prompt two-tiered for no
 * reason anyone chose — the split tracked PROVENANCE (text from the .md file vs
 * text computed at runtime), which is an implementation detail, and leaked it
 * into the prompt's structure as a capability difference. The one section an eval
 * most wants to ablate, the shorthand notation, was in the tier the override
 * mechanism could not touch.
 *
 * There is now ONE model: the prompt is an ordered list of banner-delimited
 * sections. `source` records where a section's text comes from, and that is all
 * it does — every section is split, addressed, and overridden the same way.
 *
 * BANNER OWNERSHIP, which differs by source and is deliberate:
 *   - `template` sections carry their banner INSIDE
 *     `prompts/system/system-prompt.md`, because those banners are the split
 *     points of a single readable document. The registry asserts they match
 *     (`prompt-blocks.test.ts`) rather than owning them.
 *   - `runtime` sections get their banner from THIS file, prepended at assembly.
 *     Their text is computed (or supplied by the lexpack SDK), so there is no
 *     document to carry it, and having the assembler prepend a registered banner
 *     keeps one owner instead of asking each producer to remember one.
 *
 * ORDER is the order the model receives. For `template` sections it is also a
 * fact about the .md file — concatenating them reproduces it byte for byte, and
 * the splitter asserts that.
 *
 * WHY THE ARRAY BOUNDARY SURVIVES: `buildSystemPrompt` still returns template
 * sections in one entry and runtime sections in their own. That is a caching
 * contract, not a structural tier — the static prefix stays byte-stable so the
 * provider can cache it, while a volatile section (the handle table, which
 * changes whenever a dictionary loads) cannot invalidate it. Sections are
 * uniformly addressable across that boundary; only reordering ACROSS it is
 * refused, because that would move volatile text into the cached prefix.
 */
import { kebabToCamel } from "@veyyon/utils";

/** Where a section's text comes from. Provenance only: it confers no capability. */
export type PromptSectionSource = "template" | "runtime";

/**
 * Sections rendered from `prompts/system/system-prompt.md`, in document order.
 * `conventions` is the leading region and has no banner of its own: it is DEFINED
 * as whatever precedes the first one, so `banner` is `null` rather than optional.
 */
export const TEMPLATE_SECTION_IDS = [
	"conventions",
	"role",
	"runtime",
	"tool-policy",
	"execution-workflow",
	"delivery-contract",
] as const;

/**
 * Sections assembled from runtime state, in emission order.
 *
 * `project` carries the workstation/environment framing, the discovered context
 * files, the workspace tree, the cwd line, AND the active-repo-context clause.
 * That last one used to be its own block; it is the same concern by every
 * measure that matters — same input (the cwd), same lifetime, same invalidation
 * — and splitting it meant two things to remember on a working-directory change.
 * Exactly one of them got remembered, which is how the prompt kept describing
 * the previous project after a `/cd`.
 *
 * The two shorthand sections stay SEPARATE despite being one feature, because
 * they are separately meaningful: teaching the notation with no handle table is
 * the inert case, and an eval must be able to run it as its own arm to tell
 * "the model ignored available handles" from "there were no handles".
 */
export const RUNTIME_SECTION_IDS = ["project", "shorthand", "shorthand-handles"] as const;

export type TemplateSectionId = (typeof TEMPLATE_SECTION_IDS)[number];
export type RuntimeSectionId = (typeof RUNTIME_SECTION_IDS)[number];
export type PromptSectionId = TemplateSectionId | RuntimeSectionId;

interface PromptSectionBase {
	readonly banner: string | null;
	/** One line on what the section carries, so the registry is self-describing. */
	readonly purpose: string;
}

export interface TemplateSection extends PromptSectionBase {
	readonly id: TemplateSectionId;
	readonly source: "template";
}

export interface RuntimeSection extends PromptSectionBase {
	readonly id: RuntimeSectionId;
	readonly source: "runtime";
	/** Runtime sections always carry a registry-owned banner. */
	readonly banner: string;
}

export type PromptSection = TemplateSection | RuntimeSection;

/** The template's regions, in document order. */
export const TEMPLATE_SECTIONS: readonly TemplateSection[] = [
	{
		id: "conventions",
		source: "template",
		banner: null,
		purpose: "<system-conventions> preamble, everything before the ROLE banner",
	},
	{ id: "role", source: "template", banner: "ROLE\n==", purpose: "who the agent is" },
	{
		id: "runtime",
		source: "template",
		banner: "RUNTIME\n==",
		purpose: "workstation, tool inventory, memory",
	},
	{
		id: "tool-policy",
		source: "template",
		banner: "TOOL POLICY\n==",
		purpose: "tool rules, delegation, LSP/AST",
	},
	{
		id: "execution-workflow",
		source: "template",
		banner: "EXECUTION WORKFLOW\n==",
		purpose: "how work is carried out",
	},
	{
		id: "delivery-contract",
		source: "template",
		banner: "DELIVERY CONTRACT\n==",
		purpose: "output contract, personality",
	},
];

/** The sections assembled from runtime state, in emission order. */
export const RUNTIME_SECTIONS: readonly RuntimeSection[] = [
	{
		id: "project",
		source: "runtime",
		banner: "PROJECT\n==",
		purpose: "environment, cwd, context files, workspace tree, active repo context",
	},
	{
		id: "shorthand",
		source: "runtime",
		banner: "SHORTHAND\n==",
		purpose: "the shorthand notation block, taught when the encode gate is open",
	},
	{
		id: "shorthand-handles",
		source: "runtime",
		banner: "SHORTHAND HANDLES\n==",
		purpose: "the handle table for loaded projects, so the model can learn the handles at all",
	},
];

/** Every section, in the order it reaches the model. */
export const PROMPT_SECTIONS: readonly PromptSection[] = [...TEMPLATE_SECTIONS, ...RUNTIME_SECTIONS];

/**
 * Every banner-bearing section, in order — template and runtime alike.
 *
 * This is what makes the model uniform: the splitter and the reorderer key off
 * THIS list, so a runtime section is as addressable as a template one. Only
 * `conventions` is absent, because it has no banner to find.
 */
export const BANNERED_SECTIONS: readonly (PromptSection & { banner: string })[] = PROMPT_SECTIONS.filter(
	(s): s is PromptSection & { banner: string } => s.banner !== null,
);

/**
 * The banner-bearing sections OF THE TEMPLATE FILE only.
 *
 * `default-template.ts` splits `system-prompt.md` on these offsets, so it must
 * look for exactly the banners that file contains — a runtime banner is not in
 * it, and searching for one would throw. The reorderer, which works on the
 * assembled prompt, uses {@link BANNERED_SECTIONS} instead.
 */
export const BANNERED_TEMPLATE_SECTIONS: readonly (TemplateSection & { banner: string })[] =
	TEMPLATE_SECTIONS.filter((s): s is TemplateSection & { banner: string } => s.banner !== null);

/**
 * The camelCase override keys for the template sections, in document order.
 *
 * Derived, never declared: the override keys and the section ids used to be two
 * hand-written lists, so renaming a section meant editing both and nothing caught
 * a mistake. `kebabToCamel` (@veyyon/utils) owns the conversion itself, so this
 * file does not hand-roll a second copy of it either.
 */
export const TEMPLATE_SECTION_CAMEL_KEYS: readonly string[] = TEMPLATE_SECTION_IDS.map(kebabToCamel);

/**
 * Prefix a runtime section's rendered text with its registered banner.
 *
 * Returns "" for empty text so an absent section stays absent rather than
 * becoming a bare banner with nothing under it — a heading promising content
 * that is not there reads as a truncation bug to the model.
 */
export function withSectionBanner(section: RuntimeSection, text: string | undefined): string {
	const body = text?.trim();
	if (!body) return "";
	return `${section.banner}${"=".repeat(33)}\n\n${body}`;
}
