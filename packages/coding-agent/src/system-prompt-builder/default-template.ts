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

/** The banner each section must lead with. `conventions` has no banner. */
const SECTION_REQUIRED_BANNER: Partial<Record<keyof DefaultTemplateSections, string>> = Object.fromEntries(
	SECTION_BANNERS.map(({ key, banner }) => [key, banner]),
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
			throw new Error(`section override for "${key}" must be a string, got ${value === null ? "null" : typeof value}`);
		}
		const banner = SECTION_REQUIRED_BANNER[key as keyof DefaultTemplateSections];
		if (banner && !value.startsWith(banner)) {
			throw new Error(
				`section override for "${key}" must begin with its section banner ` +
					`"${banner.replace("\n", "\\n")}…" so the banner boundary is preserved. A section override ` +
					"replaces one banner region and MUST keep that region's banner; start from the shipped section text.",
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
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			"VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS must be a JSON object of section -> replacement text, " +
				`got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}`,
		);
	}
	return resolveSectionOverrides(parsed as Record<string, unknown>);
}
