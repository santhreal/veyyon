/**
 * Section machinery for the default system-prompt template.
 *
 * The template (`prompts/system/system-prompt.md`) is organized into banner
 * sections (`ROLE\n====`, `RUNTIME\n====`, ...). This leaf module owns the
 * canonical section names and the split/reorder primitives so both the prompt
 * builder (`system-prompt.ts`) and per-model harness profiles
 * (`harness/model-profile.ts`) share one definition without an import cycle.
 */
import { logger } from "@veyyon/utils";

/** Kebab-case names of the default template's banner sections, in template order. */
export const PROMPT_SECTION_NAMES = [
	"role",
	"runtime",
	"tool-policy",
	"execution-workflow",
	"delivery-contract",
] as const;

export type PromptSectionName = (typeof PROMPT_SECTION_NAMES)[number];

const SECTION_BANNER_TO_NAME: Record<string, PromptSectionName> = {
	ROLE: "role",
	RUNTIME: "runtime",
	"TOOL POLICY": "tool-policy",
	"EXECUTION WORKFLOW": "execution-workflow",
	"DELIVERY CONTRACT": "delivery-contract",
};

export interface PromptSection {
	name: PromptSectionName | "preamble";
	text: string;
}

/**
 * Split a rendered default-template prompt on its `NAME\n====` banner lines.
 * Text before the first banner is the "preamble" (system conventions), which
 * always stays first and is always emitted as `sections[0]`.
 *
 * Round-trip: joining the section texts with "\n" reproduces the input WHENEVER
 * the input has a real preamble, i.e. its first line is not itself a banner. The
 * real system-prompt template always leads with a multi-line conventions
 * preamble, so this holds for every production render. The one exception is a
 * banner on line 0: then the preamble text is "" with no separating newline in
 * the source, and a naive `join("\n")` fabricates a leading newline. The
 * reorder consumer ({@link applyPromptSectionOrder}) handles that case by
 * dropping an empty-text preamble from the join, so it never fabricates one.
 */
export function splitPromptSections(rendered: string): PromptSection[] {
	const lines = rendered.split("\n");
	const sections: PromptSection[] = [];
	let current: PromptSection = { name: "preamble", text: "" };
	let buf: string[] = [];
	const flush = () => {
		current.text = buf.join("\n");
		sections.push(current);
		buf = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const bannerName = SECTION_BANNER_TO_NAME[lines[i].trim()];
		if (bannerName && lines[i + 1]?.startsWith("====")) {
			flush();
			current = { name: bannerName, text: "" };
		}
		buf.push(lines[i]);
	}
	flush();
	return sections;
}

/**
 * Reorder the rendered prompt's banner sections. `order` lists section names
 * (see {@link PROMPT_SECTION_NAMES}); listed sections are emitted in that order
 * after the preamble, and any unlisted sections follow in template order. A
 * name that does not exist in the render (e.g. a custom template without
 * banners, or a typo) is reported loudly and skipped, never silently applied.
 */
export function applyPromptSectionOrder(rendered: string, order: readonly string[] | undefined): string {
	if (!order || order.length === 0) return rendered;
	const sections = splitPromptSections(rendered);
	const bodySections = sections.filter(s => s.name !== "preamble");
	const knownNames = new Set(bodySections.map(s => s.name as string));
	// Track emitted sections by IDENTITY, not by name. Keying by name would
	// collapse two same-named banners (possible in a custom template) into one,
	// and then the "rest" pass would drop the other by name, a silent content
	// loss. By identity, every section is emitted exactly once regardless of
	// name collisions: a duplicated name in `order` emits all its instances at
	// that position, and nothing is ever dropped.
	const emitted = new Set<PromptSection>();
	const handledNames = new Set<string>();
	const ordered: PromptSection[] = [];
	for (const name of order) {
		if (handledNames.has(name)) continue;
		handledNames.add(name);
		if (!knownNames.has(name)) {
			logger.warn("harness promptSectionOrder names a section missing from the rendered system prompt", {
				section: name,
				known: [...knownNames],
			});
			continue;
		}
		for (const section of bodySections) {
			if (section.name === name && !emitted.has(section)) {
				emitted.add(section);
				ordered.push(section);
			}
		}
	}
	const rest = bodySections.filter(s => !emitted.has(s));
	const preamble = sections.find(s => s.name === "preamble");
	const parts = [...(preamble && preamble.text !== "" ? [preamble] : []), ...ordered, ...rest];
	return parts.map(s => s.text).join("\n");
}
