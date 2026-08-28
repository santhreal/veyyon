/** What a prompt banner IS, and how to cut a document at one — for every prompt. The grammar is `NAME`, a newline, then a rule of `=`. Four questions follow from */

/** The underline under every banner name, and the ONE place its width is decided. Three widths used to ship in one product: `session/system-prompt.md` underlined */
const BANNER_UNDERLINE = "==============";

/** A section's banner, as the bytes the model receives and the splitter looks for. The single producer. Registries declare a NAME and nothing else, so a row cannot */
export function renderBanner(name: string): string {
	return `${name}\n${BANNER_UNDERLINE}`;
}

/** The shortest underline that opens a section. The RECOGNITION width, deliberately not the emission width. The splitter has */
const MIN_BANNER_UNDERLINE = "====";

/** Whether a line is the `====` rule under a banner name. */
export function isBannerUnderline(line: string | undefined): boolean {
	return line !== undefined && /^={4,}\r?$/.test(line);
}

/** The banner form to quote at a user whose file was refused. The message has to say how many `=` are needed, and the number it says has to be */
export function describeBanner(name: string): string {
	return `"${name}" followed by a line of at least ${MIN_BANNER_UNDERLINE.length} "=" characters`;
}

/** The banner name `text` opens with, or `undefined` if it opens with none. The one answer to "which section does this text begin?", and the underline check */
export function leadingBannerName(text: string): string | undefined {
	const [first, second] = text.split("\n", 2);
	if (first === undefined || !isBannerUnderline(second)) return undefined;
	return first.trim();
}

/** Whether `text` opens with the banner for `name`. The predicate view of {@link leadingBannerName}, used by the override validator */
export function startsWithBanner(text: string, name: string): boolean {
	return leadingBannerName(text) === name;
}

/** Banner name line to section id, for any registry of bannered sections. The table every splitter is driven by. Building it takes a registry as an */
export function bannerTable(
	sections: readonly { readonly name: string | null; readonly id: string }[],
): Record<string, string> {
	return Object.fromEntries(sections.filter(hasBanner).map(section => [section.name, section.id]));
}

/** One fragment of a SPLIT prompt: a banner name and the text under it. Deliberately not called `PromptSection`: that name belongs to the registry row in */
export interface RenderedSection {
	name: string;
	text: string;
}

/** THE splitter. One implementation cuts every bannered document in the product. grammar, and they disagreed about the case that matters. `splitDefaultTemplate` */
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

/** Refuse body text that would be parsed as one or more registered sections. Section and statement overrides are prose-only surfaces. Letting one carry a */
export function assertNoRegisteredBanners(text: string, banners: Record<string, string>, label: string): void {
	const found = splitBanneredDocument(text, { banners })
		.filter(region => region.name !== "preamble")
		.map(region => region.name);
	if (found.length === 0) return;
	throw new Error(
		`${label} must contain body text only, without registered section banners; ` +
			`found ${found.map(id => `"${id}"`).join(", ")}. The section registry adds that banner automatically.`,
	);
}

/** Refuse a document whose banners do not match what the caller requires. Separate from the scan so the message can say WHICH way it failed. "missing" */
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

/** The row shape a bannered section has lives in `@veyyon/utils` as `PromptSection`, not here. */

/** A section that opens with a banner, as opposed to a leading region that has none. One predicate rather than the structurally identical inline ones each derived */
export function hasBanner<T extends { readonly name: string | null }>(section: T): section is T & { name: string } {
	return section.name !== null;
}
