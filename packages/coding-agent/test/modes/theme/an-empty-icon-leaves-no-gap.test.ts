/**
 * An icon that is not there must not leave its space behind.
 *
 * A symbol preset is allowed to leave an icon EMPTY, and the unicode preset
 * leaves thirty-one of them empty: `icon.model`, `icon.git`, `icon.context`,
 * `icon.cost`, `icon.time`, `icon.job`, `icon.agents`, `icon.cache`,
 * `icon.throughput` and more. Writing the label as `` `${theme.icon.job} 5` ``
 * then renders ` 5`: a leading space, and a number with nothing saying what it
 * counts. The status line is where this reads worst, because several metrics sit
 * side by side and an unlabelled number cannot be told from the one before it.
 *
 * The status line's segment builders had the fix as a PRIVATE helper while a
 * dozen other surfaces wrote the template by hand, which is why the gap appeared
 * in some parts of the same line and not others. `withIcon` is a leaf module now
 * and every icon-then-label site goes through it.
 *
 * The last test is a repo-wide ratchet. This is the class of bug where fixing the
 * sites that were noticed leaves the ones that were not, so the check is on the
 * SHAPE (a template literal that opens with an icon and a space) rather than on
 * any list of files.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { withIcon } from "@veyyon/coding-agent/modes/theme/icon-label";
import { UNICODE_SYMBOLS } from "@veyyon/coding-agent/modes/theme/symbols";

describe("withIcon", () => {
	/**
	 * The ordinary case: an icon that exists is followed by exactly one space.
	 *
	 * Asserted as exact bytes, because the whole bug is one character of
	 * whitespace and a `toContain` would not see it.
	 */
	it("joins an icon to its label with a single space", () => {
		expect(withIcon("⚙", "5")).toBe("⚙ 5");
		expect(withIcon("", "5")).toBe("5");
	});

	/**
	 * The defect itself, stated as the case it must produce.
	 *
	 * The separator belongs to the join, so it exists only when there is
	 * something to separate. A helper that returned `` ` ${text}` `` for an empty
	 * icon would look almost identical in the source and reproduce the bug.
	 */
	it("leaves no leading space when the icon is empty", () => {
		expect(withIcon("", "42%")).toBe("42%");
		expect(withIcon("", "42%").startsWith(" ")).toBe(false);
		expect(withIcon("", "")).toBe("");
	});

	/**
	 * The label is passed through byte for byte, including its own spaces.
	 *
	 * Trimming here would be a second, invisible rule: a caller that formats
	 * `"5 agents"` gets exactly that, and a caller that wants it trimmed trims it.
	 */
	it("does not touch the label", () => {
		expect(withIcon("⚙", " 5 ")).toBe("⚙  5 ");
		expect(withIcon("", " 5 ")).toBe(" 5 ");
		expect(withIcon("⚙", "a\nb")).toBe("⚙ a\nb");
	});

	/**
	 * The preset that made this matter, read from the real symbol table.
	 *
	 * If the unicode preset ever fills these in, the join is still correct and
	 * this case simply stops being about an empty string. It is here so the suite
	 * states WHY the empty branch exists rather than asserting an invented case.
	 */
	it("is the branch the unicode preset actually takes", () => {
		const symbols = UNICODE_SYMBOLS as Record<string, string>;
		const emptyIcons = Object.keys(symbols).filter(key => key.startsWith("icon.") && symbols[key] === "");

		expect(emptyIcons.length).toBeGreaterThan(0);
		for (const key of emptyIcons) {
			expect(withIcon(symbols[key] ?? "", "5")).toBe("5");
		}
	});
});

/**
 * Files whose source is scanned for the hand-written shape.
 *
 * `modes/` is the whole rendering surface. Tests are excluded because a test may
 * legitimately construct the old shape to assert against it.
 */
function renderingSources(): Array<{ file: string; source: string }> {
	const root = path.resolve(import.meta.dir, "../../../src/modes");
	const found: Array<{ file: string; source: string }> = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__") continue;
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			found.push({ file: path.relative(root, full), source: fs.readFileSync(full, "utf8") });
		}
	};
	walk(root);
	return found;
}

/** A template literal that OPENS with an icon and a space, which is the defect. */
const ICON_PREFIX_TEMPLATE = /`\$\{[a-zA-Z.#]*\bicon\.[a-zA-Z]+\}\s/;

/**
 * True for a line of prose rather than code.
 *
 * The owner's own doc comment QUOTES the banned shape, because explaining a rule
 * means writing down what it forbids. A ratchet that read comments would be
 * satisfiable only by a rule nobody may describe.
 */
function isComment(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

describe("nobody writes the icon separator by hand again", () => {
	/**
	 * The scan reads real files, so a walk that stopped finding them cannot pass
	 * the ratchet by scanning nothing.
	 */
	it("reads the rendering sources", () => {
		const sources = renderingSources();

		expect(sources.length).toBeGreaterThan(50);
		expect(sources.some(entry => entry.file.endsWith("status-line/segments.ts"))).toBe(true);
	});

	/**
	 * The ratchet. A template that starts with an icon followed by a space is the
	 * exact shape that renders a leading blank when the preset leaves that icon
	 * empty, and there were twenty-nine of them across thirteen files.
	 */
	it("no source builds a label as an icon followed by a space", () => {
		const offenders = renderingSources()
			.flatMap(({ file, source }) =>
				source
					.split("\n")
					.map((line, index) => ({ file, line: index + 1, text: line }))
					.filter(entry => !isComment(entry.text) && ICON_PREFIX_TEMPLATE.test(entry.text)),
			)
			.map(entry => `${entry.file}:${entry.line} ${entry.text.trim()}`);

		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin: the ratchet recognises what it bans.
	 *
	 * A pattern that matched nothing would keep the test above green forever while
	 * the bug walked back in, which is precisely how the private helper coexisted
	 * with a dozen hand-written copies.
	 */
	it("the ratchet matches the shape it is written against", () => {
		expect(ICON_PREFIX_TEMPLATE.test("`${theme.icon.job} ${count}`")).toBe(true);
		expect(ICON_PREFIX_TEMPLATE.test("`${this.#theme.icon.agents} 5`")).toBe(true);
		// And not the correct spellings: the join itself, and a prefix builder that
		// already guards on the icon being present.
		expect(ICON_PREFIX_TEMPLATE.test("withIcon(theme.icon.job, `${count}`)")).toBe(false);
		expect(ICON_PREFIX_TEMPLATE.test('theme.icon.ghost ? `${theme.icon.ghost} ` : ""')).toBe(true);
	});

	/**
	 * And the comment filter skips prose without skipping code.
	 *
	 * A filter that answered true too often would silence the ratchet quietly,
	 * which is the same failure the ratchet exists to prevent.
	 */
	it("skips comment lines and only comment lines", () => {
		expect(isComment(" * a doc line mentioning `${theme.icon.job} ${count}`")).toBe(true);
		expect(isComment("// a note")).toBe(true);
		expect(isComment("\tconst x = `${theme.icon.job} ${count}`;")).toBe(false);
	});
});
