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
import { BANNERED_SECTIONS, BANNERED_TEMPLATE_SECTIONS } from "./prompt-blocks";

/**
 * The reorderable section names, DERIVED from the one registry in
 * `prompt-blocks.ts` rather than restated here.
 *
 * This list and the banner map below used to be a second, independent
 * definition of the same five sections that `system-prompt-builder/default-template.ts`
 * also defined, with different spellings (`tool-policy` vs `toolPolicy`) and a
 * different parser. Keeping them in step was manual, and the divergence would
 * have been silent: the other splitter throws on a missing banner, whereas this
 * one simply does not recognise the line and folds the section into its
 * predecessor. Deriving both from one source removes the possibility.
 */
export const PROMPT_SECTION_NAMES = BANNERED_SECTIONS.map(b => b.id) as readonly string[];

/**
 * The subset that lives in the template FILE.
 *
 * {@link applyPromptSectionOrder} works on one rendered document, so a caller
 * reordering just the template can only name these. The whole-prompt entry point
 * is {@link applyPromptSectionOrderToParts}, which accepts every name in
 * {@link PROMPT_SECTION_NAMES} because it can see the runtime sections too.
 */
export const TEMPLATE_SECTION_NAMES = BANNERED_TEMPLATE_SECTIONS.map(b => b.id) as readonly string[];

export type PromptSectionName = string;

/**
 * Banner text (the bare `NAME` line, without the `====` underline) to canonical
 * id. Built from the registry's banner declarations, so a banner can never be
 * recognised by one splitter and missed by the other.
 */
const SECTION_BANNER_TO_NAME: Record<string, PromptSectionName> = Object.fromEntries(
	BANNERED_SECTIONS.map(b => [b.banner.split("\n")[0] as string, b.id]),
);

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

/**
 * Reorder the sections of a fully assembled prompt — template AND runtime.
 *
 * `buildSystemPrompt` returns the prompt as parts: `parts[0]` is the rendered
 * template (many banner sections in one string) and each later part is a single
 * runtime section carrying its own banner. That split is a CACHING contract —
 * the template prefix stays byte-stable so a provider can cache it, and a
 * volatile section like the handle table must not sit inside it.
 *
 * So ordering is applied in both places from ONE list: template sections are
 * permuted within `parts[0]`, and the runtime parts are permuted among
 * themselves, each by its rank in `order`. `parts[0]` stays first regardless,
 * because moving a runtime section ahead of it would drop volatile text into the
 * cached prefix and invalidate it on every dictionary load. A name that matches
 * neither is reported loudly and skipped, exactly as the single-document path
 * does — never silently ignored.
 */
export function applyPromptSectionOrderToParts(parts: readonly string[], order: readonly string[] | undefined): string[] {
	if (!order || order.length === 0 || parts.length === 0) return [...parts];
	const [template, ...runtimeParts] = parts;

	const rank = new Map<string, number>();
	order.forEach((name, index) => {
		if (!rank.has(name)) rank.set(name, index);
	});

	// A runtime part is identified by the banner it leads with, which is the same
	// key `splitPromptSections` uses, so the two can never disagree about identity.
	const identify = (part: string): string | undefined => SECTION_BANNER_TO_NAME[part.split("\n", 1)[0].trim()];
	const known = new Set<string>([
		...TEMPLATE_SECTION_NAMES,
		...runtimeParts.map(identify).filter((name): name is string => name !== undefined),
	]);
	for (const name of order) {
		if (!known.has(name)) {
			logger.warn("harness promptSectionOrder names a section missing from the assembled system prompt", {
				section: name,
				known: [...known],
			});
		}
	}

	const orderedRuntime = runtimeParts
		.map((part, index) => ({ part, index, rank: rank.get(identify(part) ?? "") ?? Number.POSITIVE_INFINITY }))
		// Stable within equal rank: an unlisted runtime section keeps registry order.
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(entry => entry.part);

	return [applyPromptSectionOrder(template, order.filter(name => TEMPLATE_SECTION_NAMES.includes(name))), ...orderedRuntime];
}
