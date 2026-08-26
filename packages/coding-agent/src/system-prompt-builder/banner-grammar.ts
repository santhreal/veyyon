/**
 * Prompt banner grammar and document splitting utilities.
 * Defines banner emission, recognition, table construction, and document slicing.
 */

/** Canonical underline string placed beneath every prompt banner name. */
const BANNER_UNDERLINE = "==============";

/** Render a section name and its canonical underline as a banner. */
export function renderBanner(name: string): string {
	return `${name}\n${BANNER_UNDERLINE}`;
}

/** Minimum underline length required to recognize a banner header. */
const MIN_BANNER_UNDERLINE = "====";

/** Whether a line is the `====` rule under a banner name. */
export function isBannerUnderline(line: string | undefined): boolean {
	return line !== undefined && /^={4,}\r?$/.test(line);
}

/** Human-readable description of the expected banner format for error messages. */
export function describeBanner(name: string): string {
	return `"${name}" followed by a line of at least ${MIN_BANNER_UNDERLINE.length} "=" characters`;
}

/**
 * Returns the banner name that `text` opens with, or `undefined` if none matches.
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
 * Build a lookup map of banner name lines to section IDs from a registry.
 */
export function bannerTable(
	sections: readonly { readonly name: string | null; readonly id: string }[],
): Record<string, string> {
	return Object.fromEntries(sections.filter(hasBanner).map(section => [section.name, section.id]));
}

/** One fragment of a split prompt: a banner name and its associated body text. */
export interface RenderedSection {
	name: string;
	text: string;
}

/**
 * Split a bannered document into sections using byte offsets.
 * Validates expected sections and ordering when `options.expect` is provided.
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
 * Validate that body text contains no registered section banners.
 * @throws Error if any registered banner is detected in the text
 */
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

/**
 * Assert that found banners match expected section IDs and order.
 * @throws Error on missing or out-of-order sections
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

/** Note: `PromptSection` row interface is defined in `@veyyon/utils`. */

/** Type guard checking whether a section row declares a non-null banner name. */
export function hasBanner<T extends { readonly name: string | null }>(section: T): section is T & { name: string } {
	return section.name !== null;
}
