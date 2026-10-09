import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyChangelogEntries, applyChangelogProposals } from "../../src/commit/changelog/index";
import { parseUnreleasedLayout, parseUnreleasedSection } from "../../src/commit/changelog/parse";
import { CHANGELOG_CATEGORIES } from "../../src/commit/types";

/**
 * WHY: the commit flow adds and deletes changelog entries in the file it then stages.
 * It used to regenerate the whole `## [Unreleased]` body from the entries it parsed,
 * so one added bullet deleted every line the parser had no slot for: prose under the
 * heading, a category outside Keep-a-Changelog (`### Performance`), the continuation
 * line of a wrapped entry, the nesting of a sub-bullet, and the final newline of a
 * file whose Unreleased section ends it. A heading named after an `Object.prototype`
 * member (`### toString`) crashed the parser, an incoming section of that name crashed
 * the edit, and an entry differing from a proposal only by its trailing period was
 * neither found by a deletion nor recognised as a duplicate of an addition.
 *
 * The class this closes: an edit that changes a line it was not asked to change. The
 * sweep generates changelogs from every line shape below, with section names drawn
 * from CHANGELOG_CATEGORIES and every own property of Object.prototype at run time,
 * applies random additions and deletions, and checks the result against an oracle
 * built from the generator's own record of which lines form each entry — not from the
 * parser. Beyond the exact non-blank lines it checks the parsed entries, the final
 * newline, blank-run lengths, blank lines before headings, and that re-adding the
 * same entries changes nothing.
 *
 * Gap: the parser's own reading of Markdown is the boundary. A lazy continuation line
 * at column 0 is prose to it, so deleting its entry leaves that line behind, and a
 * `### ` line inside a code fence is read as a heading. No generated shape covers them.
 */

type Rand = () => number;

function mulberry32(seed: number): Rand {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const int = (rand: Rand, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(rand: Rand, items: readonly T[]): T => items[int(rand, 0, items.length - 1)];

const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
const UNKNOWN_NAMES = ["Performance", "Notes", ...PROTOTYPE_NAMES];
const WORDS = ["crash", "Retry", "parser", "flag", "cache", "export"];

// ---- the specification the oracle states independently of the implementation ----

const CANONICAL_BY_LOWER = new Map(CHANGELOG_CATEGORIES.map(section => [section.toLowerCase(), section]));

function canonical(name: string): string {
	const trimmed = name.trim();
	return CANONICAL_BY_LOWER.get(trimmed.toLowerCase()) ?? trimmed;
}

function rank(section: string): number {
	const index = (CHANGELOG_CATEGORIES as string[]).indexOf(section);
	return index === -1 ? CHANGELOG_CATEGORIES.length : index;
}

function key(text: string): string {
	return text.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
}

// ---- generator: a changelog plus the line span of every entry it wrote ----

interface GenEntry {
	start: number;
	end: number;
	text: string;
}

interface GenCategory {
	name: string;
	heading: number;
	lastNonBlank: number;
	entries: GenEntry[];
	prose: boolean;
}

interface GenDoc {
	lines: string[];
	content: string;
	preambleLast: number;
	categories: GenCategory[];
}

function phrase(rand: Rand): string {
	const words = Array.from({ length: int(rand, 1, 2) }, () => pick(rand, WORDS));
	const text = words.join(rand() < 0.15 ? "  " : " ");
	return rand() < 0.4 ? `${text}.` : text;
}

function caseVariant(rand: Rand, text: string): string {
	const roll = rand();
	if (roll < 0.2) return text.toLowerCase();
	if (roll < 0.3) return text.toUpperCase();
	return text;
}

/** A proposal's spelling of an existing entry: other case, period, spacing, padding. */
function textVariant(rand: Rand, text: string): string {
	let out = caseVariant(rand, text);
	if (rand() < 0.3) out = out.endsWith(".") ? out.slice(0, -1) : `${out}.`;
	if (rand() < 0.2) out = out.replace(/ /g, "  ");
	if (rand() < 0.2) out = `  ${out} `;
	return out;
}

function generate(rand: Rand): GenDoc {
	const lines: string[] = [];
	if (rand() < 0.5) lines.push("# Changelog", "");
	lines.push(pick(rand, ["## [Unreleased]", "## Unreleased", "## [unreleased]"]));
	let preambleLast = lines.length - 1;
	const blanks = (count: number) => {
		for (let i = 0; i < count; i += 1) lines.push("");
	};
	blanks(int(rand, 0, 2));
	for (let i = int(rand, 0, 2); i > 0; i -= 1) {
		lines.push(pick(rand, ["Highlights come first.", "- orphan bullet", "> A quoted remark."]));
		preambleLast = lines.length - 1;
		blanks(int(rand, 0, 1));
	}
	const categories: GenCategory[] = [];
	for (let c = int(rand, 0, 4); c > 0; c -= 1) {
		if (lines[lines.length - 1] !== "" && rand() < 0.8) lines.push("");
		const roll = rand();
		// A blank name makes `### `, a heading that ends the previous category and starts none.
		const name =
			roll < 0.05
				? ""
				: roll < 0.75
					? caseVariant(rand, pick(rand, CHANGELOG_CATEGORIES))
					: pick(rand, UNKNOWN_NAMES);
		lines.push(rand() < 0.85 ? `### ${name}` : `###  ${name} `);
		const category: GenCategory = {
			name,
			heading: lines.length - 1,
			lastNonBlank: lines.length - 1,
			entries: [],
			prose: false,
		};
		categories.push(category);
		const items = int(rand, 0, 4);
		for (let k = 0; k < items; k += 1) {
			if (k > 0 && rand() < 0.3) lines.push("");
			if (rand() < 0.3) {
				// Indented prose would join a preceding entry, so it only opens a category.
				const options =
					k === 0
						? ["Nothing yet.", "#### Subsection", "- ", "  Indented note."]
						: ["Nothing yet.", "#### Subsection", "- "];
				lines.push(pick(rand, options));
				category.prose = true;
			} else {
				const marker = rand() < 0.8 ? "-" : "*";
				const head = phrase(rand);
				const start = lines.length;
				let text = head;
				lines.push(`${marker} ${head}`);
				const shape = int(rand, 0, 3);
				if (shape === 1) {
					const tail = phrase(rand);
					lines.push(`  ${tail}`);
					text = `${head} ${tail}`;
				} else if (shape === 2) {
					const child = phrase(rand);
					lines.push(`  - ${child}`);
					text = `${head} - ${child}`;
				} else if (shape === 3) {
					const tail = phrase(rand);
					lines.push("", `  ${tail}`);
					text = `${head} ${tail}`;
				}
				category.entries.push({ start, end: lines.length, text });
			}
			category.lastNonBlank = lines.length - 1;
		}
		blanks(int(rand, 0, 2));
	}
	if (rand() < 0.5) lines.push("## [1.0.0] - 2024-01-01", "", "### Added", "- shipped");
	if (rand() < 0.5) lines.push("");
	return { lines, content: lines.join("\n"), preambleLast, categories };
}

/** A section-keyed record built with own properties, so `__proto__` is a key like any other. */
function record(pairs: Array<[string, string[]]>): Record<string, string[]> {
	return Object.fromEntries(pairs);
}

function proposal(rand: Rand, doc: GenDoc, existingBias: number): Record<string, string[]> {
	const pairs: Array<[string, string[]]> = [];
	for (let n = int(rand, 0, 3); n > 0; n -= 1) {
		const fromFile = doc.categories.length > 0 && rand() < existingBias;
		const category = fromFile ? pick(rand, doc.categories) : undefined;
		const name = category
			? caseVariant(rand, category.name)
			: rand() < 0.05
				? "  "
				: rand() < 0.7
					? caseVariant(rand, pick(rand, CHANGELOG_CATEGORIES))
					: pick(rand, UNKNOWN_NAMES);
		const items: string[] = [];
		for (let k = int(rand, 1, 3); k > 0; k -= 1) {
			const roll = rand();
			if (category && category.entries.length > 0 && roll < 0.5) {
				items.push(textVariant(rand, pick(rand, category.entries).text));
			} else if (roll < 0.9) {
				items.push(phrase(rand));
			} else {
				items.push(pick(rand, ["   ", ".", ""]));
			}
		}
		if (rand() < 0.2) items.push(textVariant(rand, items[0]));
		pairs.push([name, items]);
	}
	return record(pairs);
}

interface Expected {
	nonBlank: string[];
	entries: Record<string, string[]>;
	/** Each new category block: its heading and its line count, heading included. */
	created: Array<{ heading: string; size: number }>;
}

function oracle(doc: GenDoc, adding: Record<string, string[]>, deleting: Record<string, string[]>): Expected {
	const doomed = new Map<string, Set<string>>();
	for (const [name, items] of Object.entries(deleting)) {
		const section = canonical(name);
		if (!section) continue;
		const keys = doomed.get(section) ?? new Set<string>();
		for (const item of items) keys.add(key(item));
		doomed.set(section, keys);
	}
	const incoming = new Map<string, string[]>();
	for (const [name, items] of Object.entries(adding)) {
		const section = canonical(name);
		if (section) incoming.set(section, [...(incoming.get(section) ?? []), ...items]);
	}

	const removed = new Set<number>();
	const kept = new Map<string, Set<string>>();
	const firstOf = new Map<string, GenCategory>();
	const survivors = new Map<GenCategory, GenEntry[]>();
	for (const category of doc.categories) {
		const section = canonical(category.name);
		if (!firstOf.has(section)) firstOf.set(section, category);
		const keys = kept.get(section) ?? new Set<string>();
		kept.set(section, keys);
		const left: GenEntry[] = [];
		for (const entry of category.entries) {
			if (doomed.get(section)?.has(key(entry.text))) {
				for (let i = entry.start; i < entry.end; i += 1) removed.add(i);
			} else {
				keys.add(key(entry.text));
				left.push(entry);
			}
		}
		survivors.set(category, left);
	}

	const fresh = new Map<string, string[]>();
	for (const [section, items] of incoming) {
		const seen = kept.get(section) ?? new Set<string>();
		const bullets: string[] = [];
		for (const item of items) {
			const itemKey = key(item);
			if (!itemKey || seen.has(itemKey)) continue;
			seen.add(itemKey);
			bullets.push(item.trim());
		}
		if (bullets.length > 0) fresh.set(section, bullets);
	}

	const emptied = new Set<GenCategory>();
	for (const category of doc.categories) {
		const section = canonical(category.name);
		const receives = firstOf.get(section) === category && fresh.has(section);
		if (category.entries.length > 0 && survivors.get(category)?.length === 0 && !category.prose && !receives) {
			emptied.add(category);
			for (let i = category.heading; i <= category.lastNonBlank; i += 1) removed.add(i);
		}
	}

	const after = new Map<number, string[]>();
	const insertAfter = (line: number, added: string[]) => after.set(line, [...(after.get(line) ?? []), ...added]);
	const created: string[] = [];
	for (const [section, bullets] of fresh) {
		const target = firstOf.get(section);
		if (!target) {
			created.push(section);
			continue;
		}
		const last = target.entries.at(-1);
		insertAfter(
			last ? last.end - 1 : target.lastNonBlank,
			bullets.map(bullet => `- ${bullet}`),
		);
	}
	created.sort((a, b) => rank(a) - rank(b));
	for (const section of created) {
		let anchor = doc.preambleLast;
		for (const category of doc.categories) {
			if (!emptied.has(category) && rank(canonical(category.name)) < rank(section)) anchor = category.lastNonBlank;
		}
		insertAfter(anchor, [`### ${section}`, ...(fresh.get(section) ?? []).map(bullet => `- ${bullet}`)]);
	}

	const nonBlank: string[] = [];
	doc.lines.forEach((line, i) => {
		if (!removed.has(i) && line.trim() !== "") nonBlank.push(line);
		nonBlank.push(...(after.get(i) ?? []));
	});

	const entries = new Map<string, string[]>();
	for (const category of doc.categories) {
		const name = category.name.trim();
		if (emptied.has(category) || !name) continue;
		const texts = entries.get(name) ?? [];
		entries.set(name, texts);
		texts.push(...(survivors.get(category) ?? []).map(entry => entry.text));
		const section = canonical(category.name);
		if (firstOf.get(section) === category) texts.push(...(fresh.get(section) ?? []));
	}
	for (const section of created) entries.set(section, fresh.get(section) ?? []);
	return {
		nonBlank,
		entries: Object.fromEntries(entries),
		created: created.map(section => ({ heading: `### ${section}`, size: 1 + (fresh.get(section)?.length ?? 0) })),
	};
}

// ---- spacing properties ----

function bodyLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function longestBlankRun(text: string): number {
	let longest = 0;
	let run = 0;
	for (const line of bodyLines(text)) {
		run = line.trim() === "" ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

/** Every heading after the first line has a blank line above it. */
function headingsSetOff(text: string): boolean {
	const lines = text.split("\n");
	return lines.every((line, i) => i === 0 || !line.startsWith("#") || lines[i - 1].trim() === "");
}

/** Whether the first `heading` line has a blank line above it and, below its block, a blank line or the end. */
function blockSetOff(text: string, heading: string, size: number): boolean {
	const lines = bodyLines(text);
	const at = lines.indexOf(heading);
	return at > 0 && lines[at - 1] === "" && (at + size === lines.length || lines[at + size] === "");
}

function edit(content: string, adding: Record<string, string[]>, deleting?: Record<string, string[]>): string {
	return applyChangelogEntries(parseUnreleasedLayout(content), adding, deleting);
}

describe("a changelog edit keeps every line it does not add or delete", () => {
	it("matches the oracle across generated changelogs and proposals", () => {
		const rand = mulberry32(0x5eed);
		let deletedSomething = 0;
		let emptiedSomething = 0;
		let createdSomething = 0;
		for (let run = 0; run < 3000; run += 1) {
			const doc = generate(rand);
			const adding = proposal(rand, doc, 0.6);
			const deleting = proposal(rand, doc, 0.9);
			const expected = oracle(doc, adding, deleting);
			const label = JSON.stringify({ run, content: doc.content, adding, deleting });

			const out = edit(doc.content, adding, deleting);

			expect(
				bodyLines(out).filter(line => line.trim() !== ""),
				label,
			).toEqual(expected.nonBlank);
			expect(parseUnreleasedSection(out).entries, label).toEqual(expected.entries);
			expect(out.endsWith("\n"), label).toBe(doc.content.endsWith("\n"));
			expect(longestBlankRun(out), label).toBeLessThanOrEqual(Math.max(1, longestBlankRun(doc.content)));
			if (headingsSetOff(doc.content)) expect(headingsSetOff(out), label).toBe(true);
			for (const { heading, size } of expected.created) {
				expect(blockSetOff(out, heading, size), `${label}\n${heading}`).toBe(true);
			}
			expect(edit(out, adding), label).toBe(out);

			const before = bodyLines(doc.content).filter(line => line.trim() !== "").length;
			const after = expected.nonBlank.length;
			if (after < before) deletedSomething += 1;
			if (doc.categories.some(c => !expected.nonBlank.includes(doc.lines[c.heading]))) emptiedSomething += 1;
			if (expected.nonBlank.some(line => line.startsWith("### ") && !doc.lines.includes(line)))
				createdSomething += 1;
		}
		// The sweep reaches deletions, emptied headings and new categories, not only additions.
		expect(deletedSomething).toBeGreaterThan(300);
		expect(emptiedSomething).toBeGreaterThan(50);
		expect(createdSomething).toBeGreaterThan(300);
	});

	it("keeps prose, unknown categories, wrapped and nested entries when adding a category", () => {
		const content = [
			"## [Unreleased]",
			"",
			"Highlights come first.",
			"",
			"### Added",
			"- A wrapped entry whose text runs past the line",
			"  and continues here.",
			"* A parent entry",
			"  - with a nested detail",
			"",
			"### Performance",
			"- Startup is faster.",
			"",
			"## [1.0.0] - 2024-01-01",
			"",
		].join("\n");
		expect(edit(content, { Fixed: ["A bug"] })).toBe(
			[
				"## [Unreleased]",
				"",
				"Highlights come first.",
				"",
				"### Added",
				"- A wrapped entry whose text runs past the line",
				"  and continues here.",
				"* A parent entry",
				"  - with a nested detail",
				"",
				"### Fixed",
				"- A bug",
				"",
				"### Performance",
				"- Startup is faster.",
				"",
				"## [1.0.0] - 2024-01-01",
				"",
			].join("\n"),
		);
		expect(parseUnreleasedSection(content).entries).toEqual({
			Added: [
				"A wrapped entry whose text runs past the line and continues here.",
				"A parent entry - with a nested detail",
			],
			Performance: ["Startup is faster."],
		});
	});

	it("deletes a wrapped entry together with its continuation and nested lines", () => {
		const content = ["## [Unreleased]", "", "### Added", "- one", "  two", "  - three", "- four", ""].join("\n");
		expect(edit(content, {}, { added: ["ONE TWO - three."] })).toBe(
			["## [Unreleased]", "", "### Added", "- four", ""].join("\n"),
		);
	});

	it("treats a heading or section named after any Object.prototype member as an ordinary name", () => {
		for (const name of PROTOTYPE_NAMES) {
			const content = `## [Unreleased]\n\n### ${name}\n- x\n`;
			expect(parseUnreleasedSection(content).entries, name).toEqual(record([[name, ["x"]]]));
			expect(edit(content, record([[name, ["y"]]])), name).toBe(`## [Unreleased]\n\n### ${name}\n- x\n- y\n`);
			expect(edit("## [Unreleased]\n", record([[name, ["y"]]])), name).toBe(`## [Unreleased]\n\n### ${name}\n- y\n`);
		}
	});

	it("matches an entry regardless of case, spacing and a trailing period", () => {
		const content = ["## [Unreleased]", "", "### Fixed", "- Fixed the crash.", "- Other.", ""].join("\n");
		expect(edit(content, { Fixed: ["fixed  the CRASH"] })).toBe(content);
		expect(edit(content, {}, { Fixed: ["Fixed the crash"] })).toBe(
			["## [Unreleased]", "", "### Fixed", "- Other.", ""].join("\n"),
		);
	});

	it("removes an emptied category with the blank run on one side only", () => {
		const cases: Array<[string[], string[]]> = [
			[
				["## [Unreleased]", "", "### Added", "- a", "", "### Fixed", "- f", "", "## [1.0.0]"],
				["## [Unreleased]", "", "### Fixed", "- f", "", "## [1.0.0]"],
			],
			[
				["## [Unreleased]", "", "### Fixed", "- f", "", "### Added", "- a", "", "## [1.0.0]"],
				["## [Unreleased]", "", "### Fixed", "- f", "", "## [1.0.0]"],
			],
			[
				["## [Unreleased]", "", "### Added", "- a", ""],
				["## [Unreleased]", ""],
			],
			[["## [Unreleased]", "", "### Added", "- a"], ["## [Unreleased]"]],
			[
				["## [Unreleased]", "### Added", "- a", "", "## [1.0.0]"],
				["## [Unreleased]", "", "## [1.0.0]"],
			],
		];
		for (const [input, output] of cases) {
			expect(edit(input.join("\n"), {}, { Added: ["a"] }), input.join("|")).toBe(output.join("\n"));
		}
	});

	it("deletes from a blank-separated list without leaving a doubled gap", () => {
		const content = ["## [Unreleased]", "", "### Added", "- a", "", "- b", "", "- c"].join("\n");
		expect(edit(content, {}, { Added: ["b"] })).toBe(
			["## [Unreleased]", "", "### Added", "- a", "", "- c"].join("\n"),
		);
		expect(edit(content, {}, { Added: ["c"] })).toBe(
			["## [Unreleased]", "", "### Added", "- a", "", "- b"].join("\n"),
		);
		expect(edit(content, {}, { Added: ["b", "c"] })).toBe(["## [Unreleased]", "", "### Added", "- a"].join("\n"));
	});

	it("adds a bullet below a category's indented prose instead of absorbing it", () => {
		const content = ["## [Unreleased]", "", "### Added", "  Indented note.", ""].join("\n");
		const out = edit(content, { Added: ["new"] });
		expect(out).toBe(["## [Unreleased]", "", "### Added", "  Indented note.", "- new", ""].join("\n"));
		expect(parseUnreleasedSection(out).entries).toEqual({ Added: ["new"] });
	});
});

describe("applyChangelogProposals reports only changelogs whose bytes change", () => {
	let cwd = "";
	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-edit-"));
	});
	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("reports nothing for a proposal that adds only duplicates and deletes nothing present", async () => {
		const file = path.join(cwd, "CHANGELOG.md");
		fs.writeFileSync(file, "## [Unreleased]\n\n### Fixed\n- Fixed the crash.\n");
		const updated = await applyChangelogProposals({
			cwd,
			dryRun: true,
			proposals: [{ path: file, entries: { Fixed: ["Fixed the crash."] }, deletions: { Fixed: ["Never written"] } }],
		});
		expect(updated).toEqual([]);
	});

	it("reports a changelog whose entries change", async () => {
		const file = path.join(cwd, "CHANGELOG.md");
		fs.writeFileSync(file, "## [Unreleased]\n\n### Fixed\n- Fixed the crash.\n");
		const updated = await applyChangelogProposals({
			cwd,
			dryRun: true,
			proposals: [{ path: file, entries: {}, deletions: { Fixed: ["Fixed the crash."] } }],
		});
		expect(updated).toEqual([file]);
	});
});
