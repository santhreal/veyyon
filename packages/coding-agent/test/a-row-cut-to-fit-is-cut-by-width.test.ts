/**
 * WHY THIS SUITE EXISTS.
 *
 * A row is cut so that it fits a terminal, and a terminal is measured in cells.
 * Twelve sites cut by counting UTF-16 code units instead, which is the same
 * number only for ASCII. `secrets/spend-marker.ts` was the clearest case: its
 * own doc said the cut exists so "a pathological name cannot push the credential
 * name off the operator's screen", and it kept 63 CHARACTERS — 126 columns of
 * Han, wider than the terminal the line is written for, so the sentence it
 * protects was pushed off screen by the bound meant to prevent that. A control
 * byte was worse: `escapeTerminalText` turns one into the six printable columns
 * of `\u0007`, and the old code measured before escaping, so forty of them
 * passed a 64-character bound as 240 columns.
 *
 * THE CLASS. Any string cut so that it fits a rendered row goes through
 * `truncateToWidth`, which measures cells, cuts on grapheme boundaries and
 * writes one `…`. A hand-rolled `slice(0, n)` beside an ellipsis is the defect,
 * whether the marker is `…` or three ASCII periods.
 *
 * THE BOUNDARY, and it is not "every slice". A character cap is correct wherever
 * the number of characters is the thing being bounded rather than the width:
 * how much of a matched secret is quoted, an ACP payload limit the client draws,
 * a record persisted into the session file, text assembled into a prompt, and a
 * todo preview row that is also model input, where combining marks cost tokens
 * and no cells. Those are exempt BY FILE below, each with the reason, and the
 * exemption set is pinned in both directions so a stale one fails as loudly as
 * a new offender.
 *
 * WHAT IT DOES NOT CATCH. A row that is never cut, because nothing marks it. A
 * cut that lands inside a ZWJ cluster in the todo preview's character cap, which
 * keeps its own pre-cut and is exempt here. And a row cut to a width that is
 * simply wrong for its surface: this suite proves the unit, not the number.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { findMatch } from "@veyyon/coding-agent/edit/match";
import { secretSpendMarker } from "@veyyon/coding-agent/secrets/spend-marker";
import { visibleWidth } from "@veyyon/tui/utils";

const SRC = path.resolve(import.meta.dir, "../src");

/** Cells the spend line allows a model-supplied tool name, from its own owner. */
const SPEND_LABEL_CELLS = 64;

/** Cells one occurrence-preview row allows a file line, from `edit/match.ts`. */
const PREVIEW_CELLS = 80;

/**
 * Files whose cut is bounded in characters on purpose, and why.
 *
 * Keyed by file rather than by line: a line key goes stale on an unrelated edit
 * above it, and a stale key excuses the next offender in that file silently.
 */
const EXEMPT: Record<string, string> = {
	"secrets/index.ts": "How much of a matched secret is quoted is a redaction bound in characters of the secret.",
	"secrets/audit.ts": "The same quote, in the audit record rather than on screen.",
	"modes/acp/acp-event-mapper.ts": "An ACP payload limit. The client draws the text; this process never does.",
	"modes/controllers/omfg-rule.ts": "Rule text handed to the model, bounded in what it costs to read.",
	"cli/update-cli.ts": "A revision shortened to twelve characters is an identifier, not a fit.",
	"extensibility/custom-commands/bundled/review/index.ts": "A title assembled into a prompt.",
	"task/executor.ts": "A validation message the model reads.",
	"commit/agentic/agent.ts": "Text assembled into a system reminder.",
	"tools/todo.ts":
		"A preview row that is also model input carries both caps; the character cap is what bounds tokens, since combining marks cost tokens and no cells.",
	"config/missing-credentials.ts": "Bounded for a transcript and a tool result, which is where this message lands.",
	"session/verification-evidence-ledger.ts": "A persisted record's character cap.",
	"session/exit-diagnostics.ts": "An argument summary persisted into the session file.",
	"session/streaming-output.ts":
		"A column cap on tool output text, pinned by test/truncate-line-max-1-to-100-matrix.test.ts.",
};

/**
 * A cut by hand: a `slice(0, …)` or `substring(0, …)` whose result is
 * immediately followed by an ellipsis marker, in either spelling.
 */
const HAND_CUT = /(?:slice|substring)\(\s*0\s*,[^)]*\)\s*(?:\}\s*(?:…|\.\.\.)|\+\s*["'`]\s*(?:…|\.\.\.))/;

/** Every `.ts` under `src`, vendored trees excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "vendor") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) sources(full, found);
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

/** `<path relative to src>:<line>` for every hand-rolled cut. */
function hits(): string[] {
	const found: string[] = [];
	for (const file of sources(SRC)) {
		const relative = path.relative(SRC, file).split(path.sep).join("/");
		fs.readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, index) => {
				if (HAND_CUT.test(line)) found.push(`${relative}:${index + 1}`);
			});
	}
	return found;
}

function offenders(): string[] {
	return hits().filter(hit => EXEMPT[hit.slice(0, hit.lastIndexOf(":"))] === undefined);
}

/** The tool name as the spend line carries it: `This <label> call spent …`. */
function spendLabel(marker: string): string {
	const match = /^This (.*) call (?:spent|may have spent)/.exec(marker);
	if (!match?.[1]) throw new Error(`no label in ${JSON.stringify(marker.slice(0, 120))}`);
	return match[1];
}

describe("a spend line bounds a model-supplied tool name in cells", () => {
	/**
	 * The defect exactly. Sixty-four characters of Han is 128 columns, so the old
	 * bound let a model-chosen tool name push the credential name — the reason
	 * the line exists — past the edge of any terminal it is drawn in.
	 */
	it("keeps a wide-glyph name inside the cells it allows", () => {
		const marker = secretSpendMarker({ token: "#GITHUB_TOKEN#" }, "漢".repeat(80), () => true);

		expect(marker).toBeDefined();
		const label = spendLabel(marker ?? "");
		expect(visibleWidth(label)).toBeLessThanOrEqual(SPEND_LABEL_CELLS);
		expect(label.endsWith("…")).toBe(true);
		expect(marker).toContain("stored secret GITHUB_TOKEN");
	});

	/**
	 * Escaping is what decides the size, so it runs first. One BEL leaves as the
	 * six printable columns of `\u0007`; measuring before that let forty of them
	 * through a 64-cell bound as 240 columns.
	 */
	it("measures the escaped name, not the bytes the model sent", () => {
		const marker = secretSpendMarker({ token: "#GITHUB_TOKEN#" }, "\u0007".repeat(40), () => true);

		const label = spendLabel(marker ?? "");
		expect(visibleWidth(label)).toBeLessThanOrEqual(SPEND_LABEL_CELLS);
		expect(label).not.toContain("\u0007");
	});

	/** An ASCII name shorter than the bound is untouched: the cut is a cut, not a filter. */
	it("leaves a name that already fits alone", () => {
		const marker = secretSpendMarker({ token: "#GITHUB_TOKEN#" }, "bash", () => true);

		expect(spendLabel(marker ?? "")).toBe("bash");
	});
});

describe("an occurrence preview bounds a file line in cells", () => {
	/**
	 * The preview rows carry a `  <n> | ` gutter, so a row wider than its bound
	 * wraps and the numbers stop lining up. A CJK line cut to 79 characters is
	 * 158 columns — twice the bound — which is what wrapped it.
	 */
	it("keeps every row inside the gutter plus its bound", () => {
		const target = "行".repeat(60);
		const content = `${target}\nfiller\n${target}\n`;

		const outcome = findMatch(content, target, { allowFuzzy: false });

		expect(outcome.occurrences).toBe(2);
		const previews = outcome.occurrencePreviews ?? [];
		expect(previews.length).toBeGreaterThan(0);
		for (const preview of previews) {
			for (const row of preview.split("\n")) {
				const gutter = /^\s*\d+ \| /.exec(row)?.[0] ?? "";
				expect(visibleWidth(row)).toBeLessThanOrEqual(visibleWidth(gutter) + PREVIEW_CELLS);
			}
		}
	});

	/** A line that fits keeps its own bytes, marker and all. */
	it("leaves a narrow line alone", () => {
		const outcome = findMatch("alpha\nbeta\nalpha\n", "alpha", { allowFuzzy: false });

		expect(outcome.occurrencePreviews?.join("\n")).toContain("alpha");
		expect(outcome.occurrencePreviews?.join("\n")).not.toContain("…");
	});
});

describe("no second way to cut a row", () => {
	/**
	 * The sweep, so a thirteenth hand-rolled cut cannot arrive quietly. It reads
	 * `src` at run time rather than a list written here, which would go stale in
	 * silence the moment a file moved.
	 */
	it("cuts every display row through the owner", () => {
		expect(offenders()).toEqual([]);
	});

	/**
	 * The other direction. A file that stops cutting by hand — because it was
	 * routed through the owner, or deleted — leaves an entry here that would
	 * excuse the next hand-rolled cut in it, so the set is pinned both ways.
	 */
	it("holds no exemption that has stopped applying", () => {
		const files = new Set(hits().map(hit => hit.slice(0, hit.lastIndexOf(":"))));
		const stale = Object.keys(EXEMPT).filter(file => !files.has(file));

		expect(stale).toEqual([]);
		expect(Object.keys(EXEMPT).every(file => EXEMPT[file]?.length > 20)).toBe(true);
	});

	/** The predicate, in both spellings, and what it must not claim. */
	it("recognises the spellings it is looking for", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text the sweep reads, not an interpolation here
		expect(HAND_CUT.test("const preview = `${text.slice(0, 30)}...`;")).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the ${…} is source text the sweep reads, not an interpolation here
		expect(HAND_CUT.test("const preview = `${text.slice(0, 30)}…`;")).toBe(true);
		expect(HAND_CUT.test('const preview = text.substring(0, 30) + "…";')).toBe(true);
		expect(HAND_CUT.test("const preview = truncateToWidth(text, 30);")).toBe(false);
		expect(HAND_CUT.test("const head = lines.slice(0, 30);")).toBe(false);
	});
});
