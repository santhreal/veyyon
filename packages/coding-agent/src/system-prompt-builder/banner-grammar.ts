const BANNER_UNDERLINE = "==============";

export function renderBanner(name: string): string {
	return `${name}\n${BANNER_UNDERLINE}`;
}

const MIN_BANNER_UNDERLINE = "====";

export function isBannerUnderline(line: string | undefined): boolean {
	return line !== undefined && /^={4,}\r?$/.test(line);
}

export function describeBanner(name: string): string {
	return `"${name}" followed by a line of at least ${MIN_BANNER_UNDERLINE.length} "=" characters`;
}

export function leadingBannerName(text: string): string | undefined {
	const [first, second] = text.split("\n", 2);
	if (first === undefined || !isBannerUnderline(second)) return undefined;
	return first.trim();
}

export function startsWithBanner(text: string, name: string): boolean {
	return leadingBannerName(text) === name;
}

export function bannerTable(
	sections: readonly { readonly name: string | null; readonly id: string }[],
): Record<string, string> {
	return Object.fromEntries(sections.filter(hasBanner).map(section => [section.name, section.id]));
}

export interface RenderedSection {
	name: string;
	text: string;
}

export function splitBanneredDocument(
	document: string,
	options: {
		readonly banners: Record<string, string>;
		readonly expect?: readonly { readonly id: string; readonly name: string }[];
		readonly label?: string;
	},
): RenderedSection[] {
	const banners = options.banners;
	const lines = document.split("\n");

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

export function hasBanner<T extends { readonly name: string | null }>(section: T): section is T & { name: string } {
	return section.name !== null;
}
