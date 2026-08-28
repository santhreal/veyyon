/** System-prompt section discovery and ordering. Static sections are assembled from statement modules and bannered by the */
import { logger, once } from "@veyyon/utils";
import { bannerTable, leadingBannerName, type RenderedSection, splitBanneredDocument } from "./banner-grammar";
import { BANNERED_SECTIONS, BANNERED_TEMPLATE_SECTIONS } from "./section-registry";

export type PromptSectionName = string;

/* The three derivations below are computed ON FIRST USE rather than while this module is evaluating. */

/** The reorderable section names, DERIVED from the one registry in `section-registry.ts` rather than restated here. */
export const promptSectionNames: () => readonly string[] = once(() => BANNERED_SECTIONS.map(b => b.id));

/** Bannered sections in the static cached-prefix document. {@link applyPromptSectionOrder} can reorder only this one document. */
export const templateSectionNames: () => readonly string[] = once(() => BANNERED_TEMPLATE_SECTIONS.map(b => b.id));

/** The system prompt's own banner table: the default this module's splitter uses. {@link bannerTable} over the system prompt's rows, not a second `fromEntries` */
const sectionBannerToName: () => Record<string, PromptSectionName> = once(() => bannerTable(BANNERED_SECTIONS));

/** Split a rendered prompt on its banner lines, reporting what is there. The DISCOVERY view of {@link splitBanneredDocument}: a custom template with no */
export function splitPromptSections(
	rendered: string,
	banners: Record<string, PromptSectionName> = sectionBannerToName(),
): RenderedSection[] {
	return splitBanneredDocument(rendered, { banners }).map((region, index, all) => ({
		name: region.name,
		text: index === all.length - 1 ? region.text : region.text.replace(/\n$/, ""),
	}));
}

/** Reorder the rendered prompt's banner sections. `order` lists section names (see {@link promptSectionNames}); listed sections are emitted in that order */
export function applyPromptSectionOrder(rendered: string, order: readonly string[] | undefined): string {
	if (!order || order.length === 0) return rendered;
	const sections = splitPromptSections(rendered);
	const bodySections = sections.filter(s => s.name !== "preamble");
	const knownNames = new Set(bodySections.map(s => s.name as string));
	// Track emitted sections by IDENTITY, not by name. Keying by name would collapse two same-named banners (possible in a custom template) into one,
	const emitted = new Set<RenderedSection>();
	const handledNames = new Set<string>();
	const ordered: RenderedSection[] = [];
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
	// `splitPromptSections` hands back separator-free regions (see its note), so the "\n" between them is restored here. An empty preamble is dropped rather
	const parts = [...(preamble && preamble.text !== "" ? [preamble] : []), ...ordered, ...rest];
	return parts.map(s => s.text).join("\n");
}

/** Reorder sections across the fully assembled prompt. `parts[0]` is the static statement-assembled cached prefix. Each later part is */
export function applyPromptSectionOrderToParts(
	parts: readonly string[],
	order: readonly string[] | undefined,
): string[] {
	if (!order || order.length === 0 || parts.length === 0) return parts.slice();
	const [template, ...runtimeParts] = parts;

	const rank = new Map<string, number>();
	order.forEach((name, index) => {
		if (!rank.has(name)) rank.set(name, index);
	});

	// A runtime part is identified by the banner it leads with, through the same
	// grammar `splitPromptSections` cuts on — underline check included — so the two
	// can never disagree about which section a part is.
	const identify = (part: string): string | undefined => {
		const name = leadingBannerName(part);
		return name === undefined ? undefined : sectionBannerToName()[name];
	};
	const templateNames = new Set(templateSectionNames());
	const runtimeNames = new Set(runtimeParts.map(identify).filter((name): name is string => name !== undefined));
	const known = new Set<string>([...templateNames, ...runtimeNames]);
	for (const name of order) {
		if (!known.has(name)) {
			logger.warn("harness promptSectionOrder names a section missing from the assembled system prompt", {
				section: name,
				known: [...known],
			});
		}
	}

	// The other way an order goes unhonoured, and the one that used to pass in silence. Every runtime part stays after `parts[0]` no matter what `order`
	const lastTemplateAt = order.findLastIndex(name => templateNames.has(name));
	const crossing = order.filter((name, index) => runtimeNames.has(name) && index < lastTemplateAt);
	if (crossing.length > 0) {
		logger.warn(
			"harness promptSectionOrder asks a runtime section to precede a static section; it will stay after the cached prefix",
			{
				sections: crossing,
				reason:
					"parts[0] is the provider-cached prefix and runtime sections are volatile, so the boundary is not crossed",
			},
		);
	}

	const orderedRuntime = runtimeParts
		.map((part, index) => ({ part, index, rank: rank.get(identify(part) ?? "") ?? Number.POSITIVE_INFINITY }))
		// Stable within equal rank: an unlisted runtime section keeps registry order.
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map(entry => entry.part);

	return [
		applyPromptSectionOrder(
			template,
			order.filter(name => templateNames.has(name)),
		),
		...orderedRuntime,
	];
}
