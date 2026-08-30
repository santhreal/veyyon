/**
 * A count and its noun agree, and the agreement has one owner.
 *
 * WHY THIS FILE EXISTS. A hundred and fifty surfaces spelled English plurals by
 * hand, in four incompatible dialects: `n === 1 ? "" : "s"`, `n !== 1 ? "s" : ""`,
 * `n > 1 ? "s" : ""` and the parenthetical hedge `${n} file(s)` that refuses to
 * spell either. The third disagrees with the other two at zero, so the same
 * product said `0 files` on one card and `0 file` on the next, and `Aborted after
 * 0 retry attempt` where the count is a subtraction that can reach zero. Two more
 * shapes hid the ternary in a variable (`const previewFilePlural = n !== 1 ? "s"
 * : ""`, interpolated as `file${previewFilePlural}`), which is the same defect
 * with a name. `pluralize` and `formatCount` in `@veyyon/utils/format` already
 * existed and already got `entry → entries` and `memory → memories` right, and a
 * hand-rolled `${noun}s` gets those wrong the moment the noun is a variable.
 *
 * WHAT THIS CLOSES. Every counted noun in `packages/coding-agent/src` reaches
 * `formatCount`, `formatMore` or `pluralize`. The sweeps below decide what a
 * plural spelling IS by asking `pluralize` at run time rather than by matching a
 * list of nouns, so a new hand-rolled site is red on the day it lands, whatever
 * noun it counts, and an exempt pair must be recorded by exact equality.
 *
 * WHAT IT DOES NOT CATCH.
 * - VERB agreement (`is`/`are`, `was`/`were`, `it`/`them`, `needs`/`need`) is a
 *   different class and stays hand-rolled at ~25 sites. `need`/`needs` is the one
 *   pair that reads as a plural noun to the sweep, so it is recorded below.
 * - Irregular plurals. `pluralize` is suffix-driven English, so `person` would
 *   come out `persons`; no counted noun in the product needs one today.
 * - A hedged noun with NO count beside it (`Re-read the file(s) with conflicts`,
 *   `your body row(s) are byte-identical`). Nothing in the sentence says how many,
 *   so there is no count for the owner to agree with, and the ones that also
 *   carry a verb belong to the agreement class above.
 * - `packages/evals` and the repo scripts, which carry ~200 parenthetical
 *   plurals (`file(s)`) and are not user-facing product surfaces.
 * - The HTML export template, which composes its own `(N more lines)` in
 *   `export/html/template.js` and is out of the TypeScript sweep's reach.
 * - `@veyyon/hashline`, which ships standalone and cannot import the owner.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderResultOptions } from "@veyyon/agent-core";
import { renderResult } from "@veyyon/coding-agent/lsp/render";
import { searchBand } from "@veyyon/coding-agent/modes/components/search-band";
import { formatRetrySummary } from "@veyyon/coding-agent/modes/retry-display";
import { getThemeByName, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { resolveAbortLabel } from "@veyyon/coding-agent/session/messages";
import { countedNounPattern, formatCount, formatMore, pluralize } from "@veyyon/utils/format";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

const PACKAGES = path.resolve(import.meta.dir, "../../..");

/**
 * Every product tree that draws a counted noun: the CLI, the React tool views
 * behind the HTML export and the collab guest, and the guest client itself. The
 * views are a second renderer of the same tool results, so a plural spelled by
 * hand there ships the same defect to a different screen.
 */
const ROOTS = [
	path.resolve(PACKAGES, "coding-agent/src"),
	path.resolve(PACKAGES, "tool-render/src"),
	path.resolve(PACKAGES, "collab-web/src"),
];

/**
 * A ternary on a count of one whose arms are both quoted strings — the shape
 * every hand-rolled plural took, including the ones that hid in a `const`.
 */
const QUOTED_ARMS = /(?:===|!==|==|!=|>=|<=|>|<)\s*"?1"?\s*\?\s*(["'])([^"']*)\1\s*:\s*(["'])([^"']*)\3/g;

/**
 * A ternary on a count of one that interpolates a noun and appends a bare `s`
 * (`${count} ${noun}s`). The suffix rule below cannot see this one, because both
 * arms differ by more than a letter.
 */
const INTERPOLATED_PLURAL = /(?:===|!==|==|!=|>=|<=|>|<)\s*1\s*\?[^;\n]*\}s\b/;

/**
 * A count — interpolated or a literal digit — followed by its noun and a
 * parenthetical suffix: `${files.length} file(s)`, `2 peer(s)`, `3 entr(ies)`.
 * The hedge is the dialect that never decides, and it reaches the model and the
 * operator in the same breath as a number that already knows the answer.
 */
const HEDGED_COUNT = /(?:\$\{[^{}]*\}|\b\d+)(?:\s+[A-Za-z][\w-]*){1,4}\((?:s|es|ies)\)/;

/**
 * Verb agreement the sweep cannot tell from a noun, recorded pair by pair.
 *
 * `needs`/`need` is a verb agreeing with its subject (`3 need attention`), and
 * `pluralize("need")` is `needs`, so the sweep reads it as a counted noun. A new
 * pair lands in the offender list instead of here, which is the point.
 */
const VERB_AGREEMENT = ["need|needs"];

/** Every `.ts` and `.tsx` under a product root, vendored trees and tests excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "vendor" && entry.name !== "__tests__") sources(full, found);
			continue;
		}
		const code = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
		const test = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
		if (code && !test) found.push(full);
	}
	return found;
}

/** Every product source the sweeps read, across all three roots. */
function productSources(): string[] {
	return ROOTS.flatMap(root => sources(root));
}

/** A source position a reader can open, relative to `packages/`. */
function at(file: string, line: number): string {
	return `${path.relative(PACKAGES, file)}:${line}`;
}

/** Source lines, comments dropped, as `[line number, text]`. */
function codeLines(source: string): Array<[number, string]> {
	return source
		.split("\n")
		.map((line, index): [number, string] => [index + 1, line])
		.filter(([, line]) => {
			const start = line.trimStart();
			return !start.startsWith("*") && !start.startsWith("//") && !start.startsWith("/*");
		});
}

/**
 * Whether two ternary arms are the singular and plural of one noun, decided by
 * the owner rather than by a table: `pluralize` is the product's definition of
 * what a plural IS, so a noun it handles is a noun this sweep knows about.
 */
function pluralPair(first: string, second: string): string | undefined {
	if (first === second) return undefined;
	const [short, long] = first.length <= second.length ? [first, second] : [second, first];
	const suffixOnly = short === "" && (long === "s" || long === "es" || long === "ies");
	const bareSuffix = short === "y" && long === "ies";
	if (suffixOnly || bareSuffix) return "suffix";
	if (short.length === 0 || long.length === 0) return undefined;
	return pluralize(short, 2) === long ? `${short}|${long}` : undefined;
}

interface Offender {
	at: string;
	pair: string;
}

/** Every quoted-arm plural ternary left in the tree, with the pair it spells. */
function quotedArmOffenders(): Offender[] {
	return productSources().flatMap(file => {
		const found: Offender[] = [];
		for (const [number, line] of codeLines(fs.readFileSync(file, "utf8"))) {
			for (const match of line.matchAll(QUOTED_ARMS)) {
				const pair = pluralPair(match[2] ?? "", match[4] ?? "");
				if (pair) found.push({ at: at(file, number), pair });
			}
		}
		return found;
	});
}

describe("the owner spells a counted noun", () => {
	/** The two spellings a hand-rolled `${noun}s` gets wrong. */
	it("gets the -es and -ies nouns right, which is why callers stopped passing their own plural", () => {
		expect(formatCount("match", 0)).toBe("0 matches");
		expect(formatCount("match", 1)).toBe("1 match");
		expect(formatCount("entry", 2)).toBe("2 entries");
		expect(formatCount("memory", 3)).toBe("3 memories");
		expect(formatCount("process", 2)).toBe("2 processes");
	});

	/**
	 * Zero is where the three hand-rolled dialects disagreed: a `> 1` spelling
	 * renders `0 file`. There is one answer now.
	 */
	it("keeps zero plural", () => {
		expect(formatCount("file", 0)).toBe("0 files");
		expect(formatMore("file", 0)).toBe("0 more files");
	});

	/**
	 * Every count in the product is arithmetic on two lengths, and a renderer
	 * handed a count from a tool payload may be handed nothing at all.
	 */
	it("floors a non-finite count instead of printing it", () => {
		expect(formatCount("entry", Number.NaN)).toBe("0 entries");
		expect(formatCount("entry", Number(undefined))).toBe("0 entries");
		expect(formatMore("line", Number.POSITIVE_INFINITY)).toBe("0 more lines");
	});

	/**
	 * The other direction. A renderer that reads a count back out of a tool's own
	 * text has to accept whatever the writer spelled, so the pattern and the
	 * phrase come from one owner and are tested as a round trip.
	 */
	it("reads back every count it writes", () => {
		for (const noun of ["error", "warning", "reference", "entry", "match", "process"]) {
			const pattern = countedNounPattern(noun);
			for (const count of [0, 1, 2, 17]) {
				const written = formatCount(noun, count);
				expect(pattern.exec(written)?.[1], written).toBe(String(count));
			}
			// The hedge the renderers used to look for still reads, so an old
			// transcript replayed into the HTML export keeps its badges.
			expect(pattern.test(`3 ${noun}(s)`)).toBe(true);
		}
	});
});

describe("a real surface counts through the owner", () => {
	beforeAll(async () => {
		// The band paints through the live binding, which a bound theme fills; the
		// palette is pinned so the assertion reads the same bytes on every terminal.
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	/**
	 * The band used to carry a `plural` override per caller (`match` → `matches`,
	 * `entry` → `entries`) because the caller could not trust `${noun}s`. The
	 * override is gone; this is what it was for.
	 */
	it("draws the search band's match readout at zero, one and many", () => {
		const band = (matches: number, noun: string): string => searchBand(48, { matches, noun }, () => "query");

		expect(band(0, "match")).toContain("0 matches");
		expect(band(1, "match")).toContain("1 match");
		expect(band(2, "match")).toContain("2 matches");
		expect(band(1, "entry")).toContain("1 entry");
		expect(band(2, "entry")).toContain("2 entries");
	});

	/** The retry summary, whose noun is a variable (`retry` or `continuation`). */
	it("summarises retries with the noun it chose", () => {
		expect(formatRetrySummary({ attempts: 1, totalDelayMs: 0 })).toBe("Recovered after 1 retry");
		expect(formatRetrySummary({ attempts: 3, totalDelayMs: 0 })).toBe("Recovered after 3 retries");
		expect(formatRetrySummary({ attempts: 2, totalDelayMs: 0, mode: "continue" })).toBe(
			"Recovered after 2 continuations",
		);
	});

	/**
	 * The abort label, which was a `> 1` site: a turn aborted on its first retry
	 * reported `1 retry attempt`, and the same sentence at zero was reachable
	 * through a retry count that had not been incremented yet.
	 */
	it("labels an abort with the attempts it took", () => {
		const aborted = { errorId: undefined, errorMessage: undefined };

		expect(resolveAbortLabel(aborted, 1)).toBe("Aborted after 1 retry attempt");
		expect(resolveAbortLabel(aborted, 4)).toBe("Aborted after 4 retry attempts");
	});

	/**
	 * The LSP result renderer decides what a result IS by reading the counts the
	 * tool wrote into its own text: a match makes it Diagnostics, with the header
	 * naming the action and the error state colouring the block, and no match
	 * makes it a plain Response. It looked for `(\d+) error\(s\)` while the tool
	 * now writes `3 errors`, so the whole diagnostics rendering went quiet at the
	 * moment the producer stopped hedging.
	 */
	it("still reads a diagnostics result once the tool spells the plural", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const render = (text: string): string =>
			stripAnsi(
				renderResult({ content: [{ type: "text", text }] }, options, uiTheme)
					.render(120)
					.join("\n"),
			);

		const plural = render(`${formatCount("error", 3)}\nsrc/a.ts:1:1 [error] boom`);
		const singular = render(`${formatCount("error", 1)}\nsrc/a.ts:1:1 [error] boom`);

		expect(plural).toContain("LSP diagnostics");
		expect(singular).toContain("LSP diagnostics");
		expect(render("plain prose with no count in it")).toContain("LSP response");
	});

	/** The same reading decides that a location list is a location list. */
	it("still reads a reference list once the tool spells the plural", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		const text = `Found ${formatCount("reference", 2)}:\nsrc/a.ts:1:1\nsrc/b.ts:2:3`;

		const rendered = stripAnsi(
			renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, uiTheme)
				.render(120)
				.join("\n"),
		);

		expect(rendered).toContain("LSP references");
	});
});

describe("no surface spells a plural by hand", () => {
	/**
	 * The sweep asks `pluralize` what a plural is, so it covers a noun nobody has
	 * counted yet. An exempt pair is recorded above by exact equality rather than
	 * by a count, so a second verb pair is red until someone decides it is one.
	 */
	it("leaves no quoted-arm plural ternary outside the recorded verb pairs", () => {
		const offenders = quotedArmOffenders();

		expect(offenders.filter(offender => !VERB_AGREEMENT.includes(offender.pair))).toEqual([]);
		expect([...new Set(offenders.map(offender => offender.pair))].sort()).toEqual(VERB_AGREEMENT);
	});

	/** The shape the suffix rule is blind to: `${count} ${noun}s` in one arm. */
	it("leaves no count that interpolates a noun and appends an s", () => {
		const offenders = productSources().flatMap(file =>
			codeLines(fs.readFileSync(file, "utf8"))
				.filter(([, line]) => INTERPOLATED_PLURAL.test(line))
				.map(([number]) => at(file, number)),
		);

		expect(offenders).toEqual([]);
	});

	/**
	 * The hedge. A number is already in the sentence, so `(s)` is the one dialect
	 * that had the answer and printed the question instead. Both spellings are
	 * swept: `${n} file(s)` from live code and `2 peer(s)` from the gallery
	 * fixtures, which mirror shipped output and drift silently otherwise.
	 */
	it("leaves no counted noun hedged with a parenthetical suffix", () => {
		const offenders = productSources().flatMap(file =>
			codeLines(fs.readFileSync(file, "utf8"))
				.filter(([, line]) => HEDGED_COUNT.test(line))
				.map(([number]) => at(file, number)),
		);

		expect(offenders).toEqual([]);
	});
});
