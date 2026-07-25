/**
 * The single registry of every block that can reach the model's system prompt.
 *
 * WHY THIS EXISTS. The prompt used to be described in three places that could
 * disagree with each other, and one of them could disagree silently:
 *
 *   1. `system-prompt-builder/default-template.ts` defined the template's five
 *      banner sections one way (camelCase keys, `indexOf` byte-offset splitting)
 *      so that evals could override one region.
 *   2. `prompt-sections.ts` defined the SAME five sections a second, independent
 *      way (kebab-case names, line-by-line splitting) so the harness could
 *      reorder them.
 *   3. `system-prompt.ts` appended four MORE blocks after the rendered template
 *      with ad-hoc `push()` calls, so those blocks appeared in neither of the
 *      above and could be neither overridden nor reordered.
 *
 * The two section tables had to be edited in lockstep with nothing enforcing it,
 * and their failure modes were asymmetric: the splitter in (1) throws on a
 * missing banner, while (2) simply fails to recognise the line and folds the
 * section into its predecessor. Two views of one document, able to diverge with
 * no test failing.
 *
 * This module is the one owner. Section identity (id, banner, order) is declared
 * here once; the template splitter, the reorderer, the assembler, and the
 * settings-parity coverage contract all derive from it. Adding a block means
 * adding an entry here, and a block that is not registered cannot reach the
 * model.
 *
 * The point of that is not tidiness. An eval can only be a controlled experiment
 * over regions it can address: with the appended blocks outside the registry
 * there was no arm vehicle for, say, the shorthand-notation preamble at all, so
 * the one lever most likely to change adoption could not be A/B tested.
 */

/**
 * How a block reaches the prompt.
 *
 * `template-section` blocks are regions of the single default template file,
 * delimited by that file's own banner lines. `appended` blocks are separate
 * strings concatenated after the rendered template; they have no banner and are
 * supplied by the caller.
 */
export type PromptBlockKind = "template-section" | "appended";

export interface PromptBlock {
	/**
	 * Canonical, stable id. This is the ONE spelling. Any other form a surface
	 * needs (a camelCase override key, a kebab config name) is derived from it,
	 * never restated, so the spellings cannot drift apart.
	 */
	readonly id: string;
	readonly kind: PromptBlockKind;
	/**
	 * For `template-section`: the banner line opening the region, matched at the
	 * start of a line. Absent for the leading conventions preamble, which is
	 * whatever precedes the first banner, and for every `appended` block.
	 */
	readonly banner?: string;
	/**
	 * The option or setting that gates this block, when it is conditional.
	 *
	 * This is what lets the settings-parity coverage contract span BOTH tiers.
	 * Previously it derived gating identifiers from the template's `{{#if x}}`
	 * conditionals, which meant a block gated by a plain TypeScript `if` in the
	 * assembler could never appear in the contract, and could silently stop
	 * rendering with every test still green. That is the exact failure the parity
	 * guard was built to prevent, and it had simply relocated to where the guard
	 * could not look.
	 */
	readonly gate?: string;
	/** One line on what the block carries, for the registry to be self-describing. */
	readonly purpose: string;
}

/**
 * Every block, in the order it reaches the model.
 *
 * Concatenating the template sections reproduces the template file byte for
 * byte, so this order is not a preference: for the `template-section` entries it
 * is a fact about `prompts/system/system-prompt.md` and the splitter asserts it.
 */
export const PROMPT_BLOCKS: readonly PromptBlock[] = [
	{
		id: "conventions",
		kind: "template-section",
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

/** The template's regions, in document order. */
export const TEMPLATE_SECTION_BLOCKS: readonly PromptBlock[] = PROMPT_BLOCKS.filter(
	b => b.kind === "template-section",
);

/** The blocks concatenated after the rendered template, in order. */
export const APPENDED_BLOCKS: readonly PromptBlock[] = PROMPT_BLOCKS.filter(b => b.kind === "appended");

/** Canonical ids of the template sections, in document order. */
export const TEMPLATE_SECTION_IDS: readonly string[] = TEMPLATE_SECTION_BLOCKS.map(b => b.id);

/**
 * The banner-bearing sections, in document order.
 *
 * `conventions` is excluded because it has no banner: it is defined as whatever
 * precedes the first one. Both the splitter and the reorderer need exactly this
 * list, which is why it is derived here rather than written out twice.
 */
export const BANNERED_SECTION_BLOCKS: readonly (PromptBlock & { banner: string })[] =
	TEMPLATE_SECTION_BLOCKS.filter((b): b is PromptBlock & { banner: string } => b.banner !== undefined);

/** Look up a block by its canonical id, or `undefined`. */
export function promptBlockById(id: string): PromptBlock | undefined {
	return PROMPT_BLOCKS.find(b => b.id === id);
}

/**
 * Convert a canonical kebab id to the camelCase key the template-override API
 * uses (`tool-policy` -> `toolPolicy`).
 *
 * Derived rather than declared: the override keys and the section ids used to be
 * two hand-written lists, so renaming a section meant editing both and a mistake
 * went unnoticed. Now one is a pure function of the other.
 */
export function camelSectionKey(id: string): string {
	return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** The camelCase override keys for the template sections, in document order. */
export const TEMPLATE_SECTION_CAMEL_KEYS: readonly string[] = TEMPLATE_SECTION_IDS.map(camelSectionKey);

/** Every gate named by a registered block, deduped, for the parity coverage contract. */
export const REGISTERED_BLOCK_GATES: readonly string[] = [
	...new Set(PROMPT_BLOCKS.map(b => b.gate).filter((g): g is string => g !== undefined)),
];
