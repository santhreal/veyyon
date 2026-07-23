import systemPromptTemplate from "../prompts/system/system-prompt.md" with { type: "text" };

/**
 * Composition seam for the default system-prompt template.
 *
 * WHY THIS EXISTS: the template is one file (`prompts/system/system-prompt.md`)
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

/** Canonical section order. Concatenation reproduces the original template. */
export const DEFAULT_TEMPLATE_SECTION_ORDER = [
	"conventions",
	"role",
	"runtime",
	"toolPolicy",
	"executionWorkflow",
	"deliveryContract",
] as const satisfies readonly (keyof DefaultTemplateSections)[];

/**
 * The banner line that opens each non-preamble section, matched verbatim at the
 * start of a line. `conventions` has no banner: it is whatever precedes ROLE.
 * Order matters — the banners must appear in the template in this sequence.
 */
const SECTION_BANNERS: readonly { key: keyof DefaultTemplateSections; banner: string }[] = [
	{ key: "role", banner: "ROLE\n==" },
	{ key: "runtime", banner: "RUNTIME\n==" },
	{ key: "toolPolicy", banner: "TOOL POLICY\n==" },
	{ key: "executionWorkflow", banner: "EXECUTION WORKFLOW\n==" },
	{ key: "deliveryContract", banner: "DELIVERY CONTRACT\n==" },
];

/**
 * Split the single template file into its named sections at banner offsets.
 *
 * Fails loudly (throws) if any banner is missing or out of order, because a
 * missing banner would silently collapse two sections into one and let an
 * override target the wrong region — exactly the silent-drop failure this seam
 * exists to prevent. Each section keeps its banner and all trailing content up
 * to the next banner, so the slices rejoin with `""` byte-for-byte.
 */
export function splitDefaultTemplate(template: string): DefaultTemplateSections {
	const offsets: number[] = [];
	let searchFrom = 0;
	for (const { key, banner } of SECTION_BANNERS) {
		const at = template.indexOf(banner, searchFrom);
		if (at < 0) {
			throw new Error(
				`default system prompt is missing the "${banner.replace("\n", "\\n")}" banner for section "${key}"; ` +
					"the section boundaries in default-template.ts no longer match the template",
			);
		}
		offsets.push(at);
		searchFrom = at + banner.length;
	}
	const bounds = [0, ...offsets, template.length];
	const parts = DEFAULT_TEMPLATE_SECTION_ORDER.map(
		(key, i) => [key, template.slice(bounds[i], bounds[i + 1])] as const,
	);
	return Object.fromEntries(parts) as unknown as DefaultTemplateSections;
}

/** The shipped default sections, sliced once from the single source file. */
export const DEFAULT_TEMPLATE_SECTIONS: DefaultTemplateSections = splitDefaultTemplate(systemPromptTemplate);

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
