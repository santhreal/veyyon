/**
 * What a prompt banner IS, and how to cut a document at one — for every prompt.
 *
 * The grammar is `NAME`, a newline, then a rule of `=`. Four questions follow from
 * it and each is answered here once: how a banner is WRITTEN ({@link renderBanner}),
 * how one is RECOGNISED ({@link isBannerUnderline}, {@link leadingBannerName},
 * {@link startsWithBanner}), how a set of them becomes the table a parser is driven
 * by ({@link bannerTable}), and how a document is CUT at them
 * ({@link splitBanneredDocument}). Every one of the four used to be answered in more
 * than one place and the answers disagreed — see each function for the specific
 * damage.
 *
 * WHY THIS IS ITS OWN MODULE. The grammar lived inside `section-registry.ts`, the
 * system prompt's own list of rows, which put a universal rule inside a specific
 * registry: `prompts/registry.ts` describes the subagent prompt and every other
 * registered prompt with the same grammar, so it had to reach into the system
 * prompt's module to ask what a banner looks like. A leaf that depends on nothing
 * but the language is the right home for a rule every registry obeys, and it makes
 * the direction of the dependency read correctly — registries import the grammar,
 * not the other way round.
 *
 * WHY THE SPLITTER IS HERE and not beside the system prompt's section list. It was
 * in `prompt-sections.ts`, whose own header called it "section machinery for the
 * default system-prompt template" while it exported the one parser that cuts EVERY
 * bannered prompt in the product. That mislabelling was not cosmetic: it is what
 * let the splitter close over the system prompt's banner table in the first place, so
 * handing it the subagent prompt — same grammar — recognised only the banners the two
 * happen to share and folded the rest away without a word. A parser belongs with the
 * grammar it parses, where nothing about it can quietly become specific to one
 * document. The table is now a required argument for the same reason: there is no
 * default to fall back to and therefore no prompt this module knows.
 *
 * Nothing here knows which prompts exist or which sections they have.
 */

/**
 * The underline under every banner name, and the ONE place its width is decided.
 *
 * Three widths used to ship in one product: `session/system-prompt.md` underlined
 * with 14, `subagent/system-prompt.md` with 35, and the assembler pasted
 * `"=".repeat(33)` onto a registry field that already ended in `==`, so runtime
 * sections arrived at the model with 35 while the template sections above them had
 * 14. The registry field was neither width — a two-character stub that worked only
 * because every consumer either matched it as a PREFIX or immediately threw the
 * underline away to recover the name.
 *
 * 14 rather than 35 because the choice is not free: the template sections are
 * block 0, the byte-stable prefix a provider caches, and changing them would
 * invalidate that cache once for every user. Runtime sections sit outside block 0,
 * so moving them to the template's width costs nothing.
 *
 * The splitter matches a RUN of `=`, so no width is load-bearing for parsing. What
 * is load-bearing is that one value is written down once.
 */
const BANNER_UNDERLINE = "==============";

/**
 * A section's banner, as the bytes the model receives and the splitter looks for.
 *
 * The single producer. Registries declare a NAME and nothing else, so a row cannot
 * pick up an underline of its own, and the `.split("\n")[0]` that four consumers
 * used to run in order to get the name back out has no reason to exist.
 */
export function renderBanner(name: string): string {
	return `${name}\n${BANNER_UNDERLINE}`;
}

/**
 * The shortest underline that opens a section.
 *
 * The RECOGNITION width, deliberately not the emission width. The splitter has
 * always accepted any run of at least this many `=`, and it has to keep doing so: a
 * user's `PROMPT_SECTIONS/role.md` replacement is written by hand and underlined by
 * eye, and refusing one for using a different number of `=` would reject a file the
 * splitter parses perfectly well.
 *
 * It lived as a bare `"===="` inside the splitter's line loop and as an implicit
 * `startsWith(banner)` in the override validator, where the banner happened to end
 * in two `=`. So the product had two answers to "does this line open a section" and
 * neither was written down: the validator accepted a two-character underline the
 * splitter would then refuse to cut on, which is a section override that validates
 * and silently does not apply.
 */
const MIN_BANNER_UNDERLINE = "====";

/** Whether a line is the `====` rule under a banner name. */
export function isBannerUnderline(line: string | undefined): boolean {
	return line?.startsWith(MIN_BANNER_UNDERLINE) === true;
}

/**
 * The banner form to quote at a user whose file was refused.
 *
 * The message has to say how many `=` are needed, and the number it says has to be
 * the number the check applies. Writing `an "===="` into the prose stated the rule a
 * second time in English, where nothing compares it against the constant: a change
 * to the accepted width would leave the error telling the user to write the length
 * that no longer works, which is worse than an error with no detail at all.
 */
export function describeBanner(name: string): string {
	return `"${name}" followed by a line of at least ${MIN_BANNER_UNDERLINE.length} "=" characters`;
}

/**
 * The banner name `text` opens with, or `undefined` if it opens with none.
 *
 * The one answer to "which section does this text begin?", and the underline check
 * is the whole point of it being one. The prompt reorderer used to answer it
 * privately with `part.split("\n", 1)[0].trim()` and no underline check at all,
 * while the splitter cutting the same document required one. So the two disagreed
 * about identity on any text whose first line happens to match a banner name: the
 * reorderer would claim a section the splitter does not see, and rank a part by a
 * banner that is not there.
 *
 * Assembled runtime parts always carry their underline, so nothing was observed to
 * break. That is what a latent divergence looks like from the outside, and it is
 * the reason the rule is written once rather than twice.
 */
export function leadingBannerName(text: string): string | undefined {
	const [first, second] = text.split("\n", 2);
	if (first === undefined || !isBannerUnderline(second)) return undefined;
	return first.trim();
}

/**
 * Whether `text` opens with the banner for `name`.
 *
 * The predicate view of {@link leadingBannerName}, used by the override validator
 * so a replacement is accepted exactly when the splitter will cut on it.
 */
export function startsWithBanner(text: string, name: string): boolean {
	return leadingBannerName(text) === name;
}

/**
 * Banner name line to section id, for any registry of bannered sections.
 *
 * The table every splitter is driven by. Building it takes a registry as an
 * argument rather than closing over one, which is what lets a single splitter serve
 * every registered prompt: the splitter used to close over the system prompt's
 * table, so handing it the subagent prompt — the same `NAME\n====` grammar —
 * recognised only the banners the two happen to share and folded the rest into the
 * preceding section, reporting nothing.
 *
 * It lives here rather than beside that splitter because the system prompt had a
 * second, private copy of the same `Object.fromEntries` over its own rows, with the
 * banner filter written out inline again instead of asking {@link hasBanner}. Two
 * spellings of one table is how a banner ends up recognised by one caller and
 * missed by another.
 */
export function bannerTable(
	sections: readonly { readonly name: string | null; readonly id: string }[],
): Record<string, string> {
	return Object.fromEntries(sections.filter(hasBanner).map(section => [section.name, section.id]));
}

/**
 * One fragment of a SPLIT prompt: a banner name and the text under it.
 *
 * Deliberately not called `PromptSection`: that name belongs to the registry row in
 * `@veyyon/utils`, which describes a section's identity, purpose and whether it may
 * be absent. This is the runtime result of cutting a rendered document at those
 * banners. One name for two different things is how a reader ends up importing the
 * wrong one.
 */
export interface RenderedSection {
	name: string;
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
		/** Name line to section id, from {@link bannerTable}. Required: the grammar knows no prompt. */
		readonly banners: Record<string, string>;
		/** Sections that MUST appear, in this order. Omit for a discovery-only split. */
		readonly expect?: readonly { readonly id: string; readonly name: string }[];
		/** Named in the error when `expect` is not satisfied. */
		readonly label?: string;
	},
): RenderedSection[] {
	const banners = options.banners;
	const lines = document.split("\n");

	// Offsets are collected first so every region is a slice of the original and
	// nothing is rebuilt from parts. `cursor` tracks the byte position of the line
	// being examined, including the "\n" that `split` consumed.
	const found: Array<{ name: string; at: number }> = [];
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
		const entry = found[i] as { name: string };
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
	found: readonly string[],
	expected: readonly { readonly id: string; readonly name: string }[],
	label: string,
): void {
	const describe = (section: { id: string; name: string }): string => `"${section.id}" (${section.name} banner)`;

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
 * The row shape a bannered section has lives in `@veyyon/utils` as `PromptSection`,
 * not here.
 *
 * This module owns the GRAMMAR: what a banner looks like in bytes, and how to cut a
 * document at one. What a registry ROW claims about a section (its id, purpose and
 * whether it may be absent) is a separate question, and four packages ship registries
 * that need the answer, so the shape sits in the one package they all depend on. The
 * two used to be one declaration here, which meant `@veyyon/ai` could not describe a
 * prompt's sections without importing the coding agent's system-prompt internals.
 */

/**
 * A section that opens with a banner, as opposed to a leading region that has none.
 *
 * One predicate rather than the structurally identical inline ones each derived
 * list used to carry. They were written separately, so they could drift on what
 * "has a banner" means, and a reader had to compare them character by character to
 * find out that they had not.
 */
export function hasBanner<T extends { readonly name: string | null }>(section: T): section is T & { name: string } {
	return section.name !== null;
}
