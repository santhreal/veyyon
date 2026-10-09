import type { UnreleasedCategory, UnreleasedEntry, UnreleasedLayout, UnreleasedSection } from "../types";

const UNRELEASED_PATTERN = /^##\s+\[?Unreleased\]?/i;
const SECTION_PATTERN = /^###\s+(.*)$/;
// A changelog bullet and its entry text. Keep a Changelog uses `-`; Markdown
// also allows `*`, so both are accepted. Single owner of the bullet contract:
// the same character class decides "is this a bullet?" and strips the marker,
// so a `*` line can never be recognized by one and dropped by the other.
const BULLET_ENTRY_PATTERN = /^[-*]\s*(.*)$/;

/**
 * Locate the Unreleased section and record the line span of every `### <Category>`
 * heading and every entry under it. An entry is a bullet plus the lines indented
 * deeper than its marker (wrapped text and nested bullets), including blank lines
 * that separate such indented lines. Every other line keeps no role beyond its
 * position, so an edit built on this layout can leave it byte-for-byte intact.
 */
export function parseUnreleasedLayout(content: string): UnreleasedLayout {
	const lines = content.split("\n");
	const startLine = lines.findIndex(line => UNRELEASED_PATTERN.test(line.trim()));
	if (startLine === -1) {
		throw new Error("No [Unreleased] section found in changelog");
	}

	let endLine = lines.length;
	for (let i = startLine + 1; i < lines.length; i += 1) {
		if (lines[i].startsWith("## ")) {
			endLine = i;
			break;
		}
	}

	const categories: UnreleasedCategory[] = [];
	let category: UnreleasedCategory | undefined;
	let preambleEnd = startLine + 1;
	let i = startLine + 1;
	while (i < endLine) {
		const line = lines[i];
		const heading = SECTION_PATTERN.exec(line);
		if (heading) {
			category = { name: heading[1].trim(), headingLine: i, contentEnd: i + 1, entries: [] };
			categories.push(category);
			i += 1;
			continue;
		}
		if (line.trim() === "") {
			i += 1;
			continue;
		}
		if (!category) {
			// Text and bullets before the first category belong to no category.
			i += 1;
			preambleEnd = i;
			continue;
		}
		const entry = readEntry(lines, i, endLine);
		i = entry?.endLine ?? i + 1;
		if (entry) category.entries.push(entry);
		category.contentEnd = i;
	}

	return { lines, startLine, endLine, preambleEnd, categories };
}

export function parseUnreleasedSection(content: string): UnreleasedSection {
	const layout = parseUnreleasedLayout(content);
	return { startLine: layout.startLine, endLine: layout.endLine, entries: unreleasedEntries(layout) };
}

/** Entry texts grouped by category heading, in file order. Same-named headings share one list. */
function unreleasedEntries(layout: UnreleasedLayout): Record<string, string[]> {
	const byName = new Map<string, string[]>();
	for (const category of layout.categories) {
		if (!category.name) continue;
		let texts = byName.get(category.name);
		if (!texts) {
			texts = [];
			byName.set(category.name, texts);
		}
		for (const entry of category.entries) texts.push(entry.text);
	}
	// `Object.fromEntries` defines own properties, so a heading named `toString` or
	// `__proto__` is an ordinary key rather than a read of Object.prototype.
	return Object.fromEntries(byName);
}

/** Read the entry whose bullet is at `start`, or `undefined` when that line is not a non-empty bullet. */
function readEntry(lines: string[], start: number, end: number): UnreleasedEntry | undefined {
	const first = lines[start];
	const text = BULLET_ENTRY_PATTERN.exec(first.trim())?.[1];
	if (!text) return undefined;
	const indent = indentOf(first);
	const parts = [text];
	let endLine = start + 1;
	for (let i = start + 1; i < end; i += 1) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (indentOf(line) <= indent) break;
		parts.push(trimmed);
		endLine = i + 1;
	}
	return { text: parts.join(" "), startLine: start, endLine };
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}
