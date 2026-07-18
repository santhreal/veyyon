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
 * always stays first. Round-trips exactly: joining the section texts with "\n"
 * reproduces the input.
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
 * banners, or a typo) is reported loudly and skipped — never silently applied.
 */
export function applyPromptSectionOrder(rendered: string, order: readonly string[] | undefined): string {
	if (!order || order.length === 0) return rendered;
	const sections = splitPromptSections(rendered);
	const byName = new Map(sections.filter(s => s.name !== "preamble").map(s => [s.name as string, s]));
	const emitted = new Set<string>();
	const ordered: PromptSection[] = [];
	for (const name of order) {
		if (emitted.has(name)) continue;
		const section = byName.get(name);
		if (!section) {
			logger.warn("harness promptSectionOrder names a section missing from the rendered system prompt", {
				section: name,
				known: [...byName.keys()],
			});
			continue;
		}
		emitted.add(name);
		ordered.push(section);
	}
	const rest = sections.filter(s => s.name !== "preamble" && !emitted.has(s.name));
	const preamble = sections.find(s => s.name === "preamble");
	const parts = [...(preamble && preamble.text !== "" ? [preamble] : []), ...ordered, ...rest];
	return parts.map(s => s.text).join("\n");
}
