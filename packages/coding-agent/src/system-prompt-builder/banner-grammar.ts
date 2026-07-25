/**
 * What a prompt banner IS, for every prompt in the product.
 *
 * The grammar is `NAME`, a newline, then a rule of `=`. Three questions follow from
 * it and each is answered here once: how a banner is WRITTEN ({@link renderBanner}),
 * how one is RECOGNISED ({@link isBannerUnderline}, {@link leadingBannerName},
 * {@link startsWithBanner}), and how a set of them becomes the table a splitter is
 * driven by ({@link bannerTable}). Every one of the three used to be answered in
 * more than one place and the answers disagreed — see each function for the
 * specific damage.
 *
 * WHY THIS IS ITS OWN MODULE. It lived inside `section-registry.ts`, which is the
 * system prompt's own list of rows. That put a universal rule inside a specific
 * registry: `prompts/registry.ts` describes the subagent prompt and every other
 * registered prompt with the same grammar, so it had to reach into the system
 * prompt's module to ask what a banner looks like. A leaf that depends on nothing
 * but the language is the right home for a rule every registry obeys, and it makes
 * the direction of the dependency read correctly — registries import the grammar,
 * not the other way round.
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
 * A banner-delimited region of a prompt — ANY prompt in the product.
 *
 * The one description of what a section is. Both registries build their row types
 * on this: `section-registry.ts` adds `source` and `input` for the system prompt,
 * `prompts/registry.ts` uses it as-is for every other prompt. They were separate
 * interfaces, both exported as `PromptSection` from sibling modules, so a reader
 * importing "the" `PromptSection` got whichever their editor offered — and each had
 * grown a field the other lacked.
 */
export interface BanneredSection {
	readonly id: string;
	/**
	 * The banner's name line, or `null` for a section with no banner.
	 *
	 * The NAME, never the rendered banner: {@link renderBanner} owns the underline,
	 * so a row cannot ship a width of its own and the name is readable without
	 * parsing it back out of a two-line string.
	 */
	readonly name: string | null;
	/** One line on what the section carries, so a registry is self-describing. */
	readonly purpose: string;
	/**
	 * Whether this section is allowed to be absent from an assembled prompt.
	 *
	 * The field that makes an inspection meaningful, and it is a CLAIM rather than a
	 * note: an absent optional section is a feature being off, an absent required one
	 * means assembly broke, and a reader who cannot tell those apart cannot tell a
	 * correct minimal prompt from a truncated one.
	 *
	 * `system-prompt-section-presence.test.ts` holds the system prompt's rows to that
	 * in both directions, so the flag cannot quietly become decoration: a required
	 * section must render with the barest possible options, and an optional one must
	 * be absent until its input is supplied.
	 */
	readonly optional: boolean;
}

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
