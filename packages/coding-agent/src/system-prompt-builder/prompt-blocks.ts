/**
 * The single registry of every block that can reach the model's system prompt.
 *
 * WHY THIS EXISTS. The prompt used to be described in three places that could
 * disagree with each other, and one of them could disagree silently:
 *
 *   1. `default-template.ts` defined the template's five banner sections one way
 *      (camelCase keys, `indexOf` byte-offset splitting) so evals could override
 *      one region.
 *   2. `prompt-sections.ts` defined the SAME five sections a second, independent
 *      way (kebab-case names, line-by-line splitting) so the harness could
 *      reorder them.
 *   3. `system-prompt.ts` appended four MORE blocks after the rendered template
 *      with ad-hoc `push()` calls, so those appeared in neither of the above and
 *      could be neither overridden nor reordered.
 *
 * The two section tables had to be edited in lockstep with nothing enforcing it,
 * and their failure modes were asymmetric: the splitter in (1) throws on a
 * missing banner, while (2) simply fails to recognise the line and folds the
 * section into its predecessor. Two views of one document, able to diverge with
 * no test failing.
 *
 * This module is the one owner. Section identity (id, banner, order) is declared
 * here once; the template splitter, the reorderer, the assembler, and the
 * settings-parity contract all derive from it. A block that is not registered
 * cannot reach the model, and — because the ids below are a literal union — a new
 * block is a COMPILE error at every site that must handle it, rather than a
 * silent omission.
 *
 * The point is not tidiness. An eval is only a controlled experiment over regions
 * it can address: with the appended blocks outside the registry there was no arm
 * vehicle for the shorthand preamble at all, so the one lever most likely to
 * change adoption could not be A/B tested.
 */
import { kebabToCamel } from "@veyyon/utils";

/**
 * Canonical ids, in the order the blocks reach the model.
 *
 * Concatenating the template sections reproduces the template file byte for
 * byte, so for those entries this order is not a preference: it is a fact about
 * `prompts/system/system-prompt.md`, and the splitter asserts it.
 */
export const TEMPLATE_SECTION_IDS = [
	"conventions",
	"role",
	"runtime",
	"tool-policy",
	"execution-workflow",
	"delivery-contract",
] as const;

export const APPENDED_BLOCK_IDS = [
	"project-footer",
	"repo-context",
	"shorthand-preamble",
	"shorthand-handles",
] as const;

/** A region of the single default template file, delimited by that file's banners. */
export type TemplateSectionId = (typeof TEMPLATE_SECTION_IDS)[number];
/** A string concatenated after the rendered template; no banner, supplied by the caller. */
export type AppendedBlockId = (typeof APPENDED_BLOCK_IDS)[number];
export type PromptBlockId = TemplateSectionId | AppendedBlockId;

/**
 * A template region. `banner` is the line opening it, matched at the start of a
 * line, or `null` for the leading conventions preamble — which is DEFINED as
 * whatever precedes the first banner and so cannot have one. Modelling that as
 * `null` rather than an optional field keeps "has no banner" a deliberate
 * statement instead of a field someone forgot to fill in.
 */
export interface TemplateSectionBlock {
	readonly id: TemplateSectionId;
	readonly kind: "template-section";
	readonly banner: string | null;
	readonly purpose: string;
}

export interface AppendedBlock {
	readonly id: AppendedBlockId;
	readonly kind: "appended";
	readonly purpose: string;
}

export type PromptBlock = TemplateSectionBlock | AppendedBlock;

/** The template's regions, in document order. */
export const TEMPLATE_SECTION_BLOCKS: readonly TemplateSectionBlock[] = [
	{
		id: "conventions",
		kind: "template-section",
		banner: null,
		purpose: "<system-conventions> preamble, everything before the ROLE banner",
	},
	{ id: "role", kind: "template-section", banner: "ROLE\n==", purpose: "who the agent is" },
	{
		id: "runtime",
		kind: "template-section",
		banner: "RUNTIME\n==",
		purpose: "workstation, tool inventory, memory",
	},
	{
		id: "tool-policy",
		kind: "template-section",
		banner: "TOOL POLICY\n==",
		purpose: "tool rules, delegation, LSP/AST",
	},
	{
		id: "execution-workflow",
		kind: "template-section",
		banner: "EXECUTION WORKFLOW\n==",
		purpose: "how work is carried out",
	},
	{
		id: "delivery-contract",
		kind: "template-section",
		banner: "DELIVERY CONTRACT\n==",
		purpose: "output contract, personality",
	},
];

/** The blocks concatenated after the rendered template, in emission order. */
export const APPENDED_BLOCKS: readonly AppendedBlock[] = [
	{
		id: "project-footer",
		kind: "appended",
		purpose: "environment, cwd, workspace, dir-context; rendered from the project template",
	},
	{
		id: "repo-context",
		kind: "appended",
		purpose: "active repo context block, when one is resolved",
	},
	{
		id: "shorthand-preamble",
		kind: "appended",
		purpose: "the shorthand notation block, taught when the encode gate is open",
	},
	{
		id: "shorthand-handles",
		kind: "appended",
		purpose: "the handle table for loaded projects, so the model can learn the handles at all",
	},
];

/** Every block, in the order it reaches the model. */
export const PROMPT_BLOCKS: readonly PromptBlock[] = [...TEMPLATE_SECTION_BLOCKS, ...APPENDED_BLOCKS];

/**
 * The banner-bearing sections, in document order.
 *
 * `conventions` is excluded because it has no banner. Both the splitter and the
 * reorderer need exactly this list, which is why it is derived here rather than
 * written out twice.
 */
export const BANNERED_SECTION_BLOCKS: readonly (TemplateSectionBlock & { banner: string })[] =
	TEMPLATE_SECTION_BLOCKS.filter((b): b is TemplateSectionBlock & { banner: string } => b.banner !== null);

/**
 * The camelCase override keys for the template sections, in document order.
 *
 * Derived, never declared: the override keys and the section ids used to be two
 * hand-written lists, so renaming a section meant editing both and nothing caught
 * a mistake. `kebabToCamel` (@veyyon/utils) owns the conversion itself, so this
 * file does not hand-roll a second copy of it either.
 */
export const TEMPLATE_SECTION_CAMEL_KEYS: readonly string[] = TEMPLATE_SECTION_IDS.map(kebabToCamel);
