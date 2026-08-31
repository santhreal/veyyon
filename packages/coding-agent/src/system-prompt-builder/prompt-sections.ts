/**
 * System-prompt section discovery and ordering.
 *
 * Static sections are assembled from statement modules and bannered by the
 * section registry before this module sees them. Runtime sections are emitted
 * separately. This module derives both vocabularies from the registry, uses the
 * shared banner parser, and applies harness-profile ordering without crossing
 * the provider-cache boundary between static and volatile parts.
 */
import { logger, once } from "@veyyon/utils";
import { bannerTable, leadingBannerName, type RenderedSection, splitBanneredDocument } from "./banner-grammar";
import { BANNERED_SECTIONS, BANNERED_TEMPLATE_SECTIONS } from "./section-registry";

export type PromptSectionName = string;

/*
 * The three derivations below are computed ON FIRST USE rather than while this
 * module is evaluating.
 *
 * Reading an imported binding at module top level makes the value depend on
 * evaluation ORDER: if anything ever causes this module to be evaluated before
 * `section-registry.ts` has finished, the binding is still in its temporal dead
 * zone and the read throws `ReferenceError: BANNERED_TEMPLATE_SECTIONS is not
 * defined`, which aborts the whole process at import time rather than failing
 * one call. That was seen once, under one particular `bun test` file ordering,
 * and did not recur; the direct import graph in this directory is acyclic, so
 * there was nothing to point at and fix.
 *
 * Deferring the read removes the question. By the time any of these functions is
 * CALLED the module graph is fully evaluated, so no ordering can observe the
 * binding early.
 *
 * Each memoizes through `once`, the shared no-argument memoizer, rather than through
 * a module-level `let` and a `??=` written out three times. Three copies of a caching
 * pattern is three chances to get the cache wrong in a way that only one of them
 * shows: `??=` in particular re-runs forever if the derivation ever returns an empty
 * string or zero, which these do not today and nothing was checking.
 */

/**
 * The reorderable section names, DERIVED from the one registry in
 * `section-registry.ts` rather than restated here.
 *
 * This list and the banner table below used to be a second, independent
 * definition of the same five sections that `system-prompt-builder/default-template.ts`
 * also defined, with different spellings (`tool-policy` vs `toolPolicy`) and a
 * different parser. Keeping them in step was manual.
 *
 * Deriving both from one registry fixed WHICH banners exist. It did not fix what
 * happened when one was absent, and this comment used to claim otherwise: the two
 * parsers still disagreed there, one refusing and one silently folding the region
 * away. That is settled separately, by there being one parser
 * ({@link splitBanneredDocument}) whose caller chooses strictness.
 */
export const promptSectionNames: () => readonly string[] = once(() => BANNERED_SECTIONS.map(b => b.id));

/**
 * Bannered sections in the static cached-prefix document.
 *
 * {@link applyPromptSectionOrder} can reorder only this one document.
 * {@link applyPromptSectionOrderToParts} can also reorder runtime parts.
 */
export const templateSectionNames: () => readonly string[] = once(() => BANNERED_TEMPLATE_SECTIONS.map(b => b.id));

/**
 * The system prompt's own banner table: the default this module's splitter uses.
 *
 * {@link bannerTable} over the system prompt's rows, not a second `fromEntries`
 * beside it. It was written out separately here, which meant the system prompt's
 * table was built by different code from every other prompt's — the one place a
 * disagreement about which banners exist could not be seen by reading either.
 */
const sectionBannerToName: () => Record<string, PromptSectionName> = once(() => bannerTable(BANNERED_SECTIONS));

/**
 * Split a rendered prompt on its banner lines, reporting what is there.
 *
 * The DISCOVERY view of {@link splitBanneredDocument}: a custom template with no
 * banners is one preamble region, which is a correct answer rather than a
 * failure, so this path does not pass `expect`. Callers that require particular
 * sections (the template slicer) reach the underlying splitter directly.
 *
 * SEPARATOR CONVENTION, which is the one thing this view changes. The underlying
 * split is byte-exact: each region runs to the start of the next banner, so it
 * carries the newline that separates them and the regions rejoin with `""`. That
 * is what the template slicer wants, because it reassembles a file. A reorderer
 * wants the opposite: the separator belongs BETWEEN regions, not inside one, or
 * moving a region carries a stray newline with it and the section that inherits
 * last place loses one. So this view drops exactly one trailing newline per
 * region and its consumers join with `"\n"`.
 *
 * One scan, two documented conventions, rather than the two scanners this
 * replaced. Round-trip holds under `join("\n")` whenever the document has a real
 * preamble; a banner on line 0 leaves an empty preamble with no separator to
 * drop, which {@link applyPromptSectionOrder} handles by not emitting it.
 */
export function splitPromptSections(
	rendered: string,
	banners: Record<string, PromptSectionName> = sectionBannerToName(),
): RenderedSection[] {
	return splitBanneredDocument(rendered, { banners }).map((region, index, all) => ({
		name: region.name,
		text: index === all.length - 1 ? region.text : region.text.replace(/\n$/, ""),
	}));
}

/**
 * Reorder the rendered prompt's banner sections. `order` lists section names
 * (see {@link promptSectionNames}); listed sections are emitted in that order
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
	// `splitPromptSections` hands back separator-free regions (see its note), so
	// the "\n" between them is restored here. An empty preamble is dropped rather
	// than emitted: a document whose first line is a banner has no separator to
	// restore, and joining one in would fabricate a leading newline.
	const parts = [...(preamble && preamble.text !== "" ? [preamble] : []), ...ordered, ...rest];
	return parts.map(s => s.text).join("\n");
}

/**
 * Reorder sections across the fully assembled prompt.
 *
 * `parts[0]` is the static statement-assembled cached prefix. Each later part is
 * one volatile runtime section. Ordering applies within both groups from one
 * requested list, but runtime sections remain after `parts[0]` so a changing
 * handle table cannot invalidate the provider-cached prefix. Unknown or
 * unhonored names are reported rather than silently ignored.
 */
export function applyPromptSectionOrderToParts(
	parts: readonly string[],
	order: readonly string[] | undefined,
): string[] {
	if (!order || order.length === 0 || parts.length === 0) return [...parts];
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

	// The other way an order goes unhonoured, and the one that used to pass in
	// silence. Every runtime part stays after `parts[0]` no matter what `order`
	// says, because moving one into the cached prefix would invalidate it on every
	// dictionary load. So a caller asking for a runtime section AHEAD of a template
	// section gets a prompt that does not match the order it requested — and the
	// loop above says nothing, because both names are perfectly well known.
	//
	// The refusal is deliberate; being quiet about it was not. An eval arm that
	// ordered `["shorthand", "role", ...]` to test whether teaching the notation
	// first changes behaviour would have run the control by mistake and recorded it
	// as the treatment.
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
