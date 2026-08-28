import { logger, once } from "@veyyon/utils";
import { bannerTable, leadingBannerName, type RenderedSection, splitBanneredDocument } from "./banner-grammar";
import { BANNERED_SECTIONS, BANNERED_TEMPLATE_SECTIONS } from "./section-registry";

export type PromptSectionName = string;

export const promptSectionNames: () => readonly string[] = once(() => BANNERED_SECTIONS.map(b => b.id));

export const templateSectionNames: () => readonly string[] = once(() => BANNERED_TEMPLATE_SECTIONS.map(b => b.id));

const sectionBannerToName: () => Record<string, PromptSectionName> = once(() => bannerTable(BANNERED_SECTIONS));

export function splitPromptSections(
	rendered: string,
	banners: Record<string, PromptSectionName> = sectionBannerToName(),
): RenderedSection[] {
	return splitBanneredDocument(rendered, { banners }).map((region, index, all) => ({
		name: region.name,
		text: index === all.length - 1 ? region.text : region.text.replace(/\n$/, ""),
	}));
}

export function applyPromptSectionOrder(rendered: string, order: readonly string[] | undefined): string {
	if (!order || order.length === 0) return rendered;
	const sections = splitPromptSections(rendered);
	const bodySections = sections.filter(s => s.name !== "preamble");
	const knownNames = new Set(bodySections.map(s => s.name as string));
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
	const parts = [...(preamble && preamble.text !== "" ? [preamble] : []), ...ordered, ...rest];
	return parts.map(s => s.text).join("\n");
}

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
