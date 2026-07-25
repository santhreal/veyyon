/**
 * Section machinery for the default system-prompt template.
 *
 * The template (`prompts/session/system-prompt.md`) is organized into banner
 * sections (`ROLE\n====`, `RUNTIME\n====`, ...). This leaf module owns the
 * canonical section names and the split/reorder primitives so both the prompt
 * builder (`system-prompt.ts`) and per-model harness profiles
 * (`harness/model-profile.ts`) share one definition without an import cycle.
 */
import { logger } from "@veyyon/utils";
import { bannerTable, isBannerUnderline, leadingBannerName } from "./banner-grammar";
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
 * binding early. Each memoizes, so the cost is one map on first use.
 */

let promptSectionNamesCache: readonly string[] | undefined;
let templateSectionNamesCache: readonly string[] | undefined;
let sectionBannerToNameCache: Record<string, PromptSectionName> | undefined;

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
export function promptSectionNames(): readonly string[] {
	promptSectionNamesCache ??= BANNERED_SECTIONS.map(b => b.id);
	return promptSectionNamesCache;
}

/**
 * The subset that lives in the template FILE.
 *
 * {@link applyPromptSectionOrder} works on one rendered document, so a caller
 * reordering just the template can only name these. The whole-prompt entry point
 * is {@link applyPromptSectionOrderToParts}, which accepts every name in
 * {@link promptSectionNames} because it can see the runtime sections too.
 */
export function templateSectionNames(): readonly string[] {
	templateSectionNamesCache ??= BANNERED_TEMPLATE_SECTIONS.map(b => b.id);
	return templateSectionNamesCache;
}

/**
 * The system prompt's own banner table: the default this module's splitter uses.
 *
 * {@link bannerTable} over the system prompt's rows, not a second `fromEntries`
 * beside it. It was written out separately here, which meant the system prompt's
 * table was built by different code from every other prompt's — the one place a
 * disagreement about which banners exist could not be seen by reading either.
 */
function sectionBannerToName(): Record<string, PromptSectionName> {
	sectionBannerToNameCache ??= bannerTable(BANNERED_SECTIONS);
	return sectionBannerToNameCache;
}

/**
 * One fragment of a SPLIT prompt: a banner name and the text under it.
 *
 * Deliberately not called `PromptSection`: that name belongs to the registry
 * entry in `section-registry.ts`, which describes a section's identity, banner name
 * and source. This is the runtime result of cutting a rendered document at those
 * banners. Two sibling files exporting one name for two different things is how
 * a reader ends up importing the wrong one.
 */
export interface RenderedSection {
	name: PromptSectionName | "preamble";
	text: string;
}

/**
 * THE splitter. One implementation cuts every bannered document in the product.
 *
 * WHY THIS IS ONE FUNCTION. There used to be two, for the same `NAME\n====`
 * grammar, and they disagreed about the case that matters. `splitDefaultTemplate`
 * walked byte offsets with `indexOf` and THREW on a missing or out-of-order
 * banner. This module's line-wise splitter did not recognise the line at all and
 * folded the region into its predecessor, silently. They also used different key
 * spellings and different round-trip contracts. Unifying only the banner TABLE
 * (which the registry now owns) fixed which banners exist and left both of those
 * differences standing: one source of truth for the vocabulary says nothing
 * about what either parser does when a word is absent, and the silent one is the
 * path that reorders and inspects the assembled prompt. A renamed banner
 * therefore shipped a prompt with a region folded away, reporting nothing, while
 * the strict path would have refused to build at all.
 *
 * BYTE OFFSETS, NOT LINES, because that is the only version with an exact
 * round-trip: every byte of the input lands in exactly one region, so
 * `regions.map(r => r.text).join("")` reproduces the input for ANY input,
 * including the awkward one where a banner sits on line 0 and there is no
 * preamble newline to reason about. The line-wise version had to document that
 * case as an exception its consumer worked around.
 *
 * A banner still only matches at a line start with an underline beneath it, per
 * {@link isBannerUnderline} — the one place that rule is written down, shared with
 * the section-override validator so a replacement is accepted exactly when this
 * splitter will cut on it.
 *
 * `expect` is what makes it fail closed. Pass the ids a caller REQUIRES and the
 * split raises when one is missing or out of order, naming the document, rather
 * than returning a shape the caller cannot tell apart from a correct one. Omit
 * it and the split reports what it found, which is the right behaviour for a
 * custom template that legitimately has no banners at all.
 */
export function splitBanneredDocument(
	document: string,
	options: {
		readonly banners?: Record<string, PromptSectionName>;
		/** Sections that MUST appear, in this order. Omit for a discovery-only split. */
		readonly expect?: readonly { readonly id: PromptSectionName; readonly name: string }[];
		/** Named in the error when `expect` is not satisfied. */
		readonly label?: string;
	} = {},
): RenderedSection[] {
	const banners = options.banners ?? sectionBannerToName();
	const lines = document.split("\n");

	// Offsets are collected first so every region is a slice of the original and
	// nothing is rebuilt from parts. `cursor` tracks the byte position of the line
	// being examined, including the "\n" that `split` consumed.
	const found: Array<{ name: PromptSectionName; at: number }> = [];
	let cursor = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const name = banners[line.trim()];
		if (name !== undefined && isBannerUnderline(lines[i + 1])) found.push({ name, at: cursor });
		cursor += line.length + 1;
	}

	if (options.expect) {
		assertExpectedBanners(
			found.map(entry => entry.name),
			options.expect,
			options.label ?? "prompt",
		);
	}

	const bounds = [0, ...found.map(entry => entry.at), document.length];
	const regions: RenderedSection[] = [{ name: "preamble", text: document.slice(bounds[0], bounds[1]) }];
	for (let i = 0; i < found.length; i++) {
		const entry = found[i] as { name: PromptSectionName };
		regions.push({ name: entry.name, text: document.slice(bounds[i + 1], bounds[i + 2]) });
	}
	return regions;
}

/**
 * Refuse a document whose banners do not match what the caller requires.
 *
 * Separate from the scan so the message can say WHICH way it failed. "missing"
 * and "out of order" are different repairs: the first means the document lost a
 * region, the second means the registry's document order no longer describes the
 * file. Reporting only "did not match" would leave the reader to diff by eye.
 *
 * The message names the BANNER LINE as well as the section id, because the
 * banner name is the line to search the document for while the id is the row to
 * look up in `section-registry.ts`, and a reader needs both to make the repair.
 */
function assertExpectedBanners(
	found: readonly PromptSectionName[],
	expected: readonly { readonly id: PromptSectionName; readonly name: string }[],
	label: string,
): void {
	const describe = (section: { id: PromptSectionName; name: string }): string =>
		`"${section.id}" (${section.name} banner)`;

	const missing = expected.filter(section => !found.includes(section.id));
	if (missing.length > 0) {
		throw new Error(
			`${label} is missing the section${missing.length === 1 ? "" : "s"} ${missing.map(describe).join(", ")}; ` +
				`it contains ${found.length === 0 ? "no registered banners" : found.map(id => `"${id}"`).join(", ")}. ` +
				"Either the document lost a section or section-registry.ts no longer describes it.",
		);
	}

	const expectedIds = expected.map(section => section.id);
	const inExpectedOrder = found.filter(id => expectedIds.includes(id));
	if (inExpectedOrder.some((id, index) => id !== expectedIds[index])) {
		throw new Error(
			`${label} has its sections out of order: found ${inExpectedOrder.map(id => `"${id}"`).join(", ")}, ` +
				`expected ${expectedIds.map(id => `"${id}"`).join(", ")}. ` +
				"Section order in section-registry.ts is the document's order, so one of the two has to move.",
		);
	}
}

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
			"harness promptSectionOrder asks a runtime section to precede a template section; it will stay after the cached prefix",
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
