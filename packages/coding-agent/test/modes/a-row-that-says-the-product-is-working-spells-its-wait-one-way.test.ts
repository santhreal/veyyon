/**
 * WHY:
 * A row that says the product is working was spelled with two different
 * characters. Half the surfaces wrote three ASCII periods — `Sharing
 * session...`, `Summarizing branch... (esc to cancel)`, `waiting for workflow
 * jobs...`, `Reading published versions...` — and half wrote the ellipsis the
 * rest of the product uses — `Running… (esc to cancel)`, `Loading themes…`.
 * `compactionActionLabel` managed both from one function: it returned
 * `Compacting context...` for a compaction a person asked for and
 * `Auto-compacting context` for one the session asked for, and the automatic
 * caller appended an `…` of its own, so one operation announced itself with
 * three periods on one turn and an ellipsis on the next.
 *
 * The class this suite closes: a row announcing an operation in progress ends
 * with one ellipsis character, never three periods, and names the chord that
 * stops it in one spelling — `waitingText` and `waitingRow` own both, and the
 * ellipsis sits on the verb phrase rather than after a note the row adds.
 *
 * The boundary: a state word in a list row (`checking`, `logged in`) names what
 * a thing IS rather than announcing a wait; a path, selector or command
 * fragment that ends in `/...` is not a sentence; and a truncation marker
 * (`${head.slice(0, 45)}...`) states that a value was cut, which is the
 * `Ellipsis` owner's job, not this one.
 *
 * What it does not catch: a wait phrased without a trailing ellipsis at all
 * (`Transcription in progress`, before this change, would have read as a
 * statement rather than a wait), and whether a spinner is animating beside the
 * row, which is a capture's job.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { compactionActionLabel } from "@veyyon/coding-agent/modes/components/compaction-summary-message";
import { ESC_CANCEL_HINT, waitingRow, waitingText } from "@veyyon/coding-agent/modes/components/waiting-row";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { useFullColor } from "../helpers/theme-assertions";

const SRC = path.resolve(import.meta.dir, "../../src");

/** Every `.ts` under `src`, vendored trees and tests excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "vendor") sources(full, found);
			continue;
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
	}
	return found;
}

/**
 * Files the sweep may not judge, with the reason each is outside the class. A
 * file rather than a line, because a line number goes stale on an unrelated
 * edit, and pinned by exact equality below so a stale entry fails as loudly as
 * a new offender.
 */
const EXEMPT: Record<string, string> = {
	"tools/sqlite-reader.ts":
		"quotes the SQL fragment `q=SELECT...` in an error written for the model, not a row on screen",
};

/** A display string ending in three ASCII periods, interpolations removed. */
const STRING_LITERAL = /(?:"[^"\n]*"|`[^`\n]*`)/g;

function endsInAsciiDots(literal: string): boolean {
	const body = literal.slice(1, -1);
	if (!/\.\.\.(?:\\n)?$/.test(body)) return false;
	const before = body.slice(0, body.lastIndexOf("..."));
	// A fragment is not a sentence. `${x.slice(0, 30)}...` marks a value that was
	// cut, which is the truncation owner's row, and its own literal text is
	// empty; `run ...` and `~/...` are a command and a path placeholder, and the
	// dots there follow a separator rather than a word.
	if (!/[A-Za-z]/.test(before.replace(/\$\{[^}]*\}/g, ""))) return false;
	return !before.endsWith(" ") && !before.endsWith("/");
}

/** Every `path:line` where a display string still ends in three ASCII periods. */
function hits(): string[] {
	return sources(SRC).flatMap(file => {
		const relative = path.relative(SRC, file);
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, index) => {
				const start = line.trimStart();
				if (start.startsWith("*") || start.startsWith("//") || start.startsWith("/*")) return [];
				const matches = line.match(STRING_LITERAL) ?? [];
				return matches.some(endsInAsciiDots) ? [`${relative}:${index + 1}`] : [];
			});
	});
}

function offenders(): string[] {
	return hits().filter(hit => EXEMPT[hit.slice(0, hit.lastIndexOf(":"))] === undefined);
}

describe("a row that says the product is working", () => {
	useFullColor();

	/**
	 * The defect exactly: one function, one operation, two spellings, decided by
	 * who asked for the compaction. Both branches carry the ellipsis now, and it
	 * sits on the verb phrase so the provider note still reads last.
	 */
	it("spells a compaction the same way whoever asked for it", () => {
		expect(compactionActionLabel(false, false)).toBe("Compacting context…");
		expect(compactionActionLabel(true, false)).toBe("Auto-compacting context…");
		expect(compactionActionLabel(false, true)).toBe("Compacting context… (openai remote compaction)");
		expect(compactionActionLabel(true, true)).toBe("Auto-compacting context… (openai remote compaction)");
	});

	it("puts one ellipsis on the subject and no ASCII dots", () => {
		const text = waitingText("Sharing session");

		expect(text).toBe("Sharing session…");
		expect(text).not.toContain("...");
	});

	/**
	 * The hint has one spelling and the owner is the only place it is written, so
	 * a row cannot invent `(Press esc to cancel)` beside a row that says `(esc to
	 * cancel)`.
	 */
	it("names the chord that stops it in one spelling", () => {
		expect(waitingText("Summarizing branch", { escCancels: true })).toBe("Summarizing branch… (esc to cancel)");
		expect(ESC_CANCEL_HINT).toBe(" (esc to cancel)");
		expect(waitingText("Running")).not.toContain("esc");
	});

	/**
	 * A standalone waiting row is quiet: it is not an offer to press anything and
	 * not a loss, so it takes the same weight the fold row takes rather than the
	 * `muted` and default weights three of these rows used to pick for themselves.
	 */
	it("paints a standalone row in the quiet weight", () => {
		initTheme();

		expect(waitingRow("Loading themes")).toBe(theme.fg("dim", "Loading themes…"));
		expect(stripAnsi(waitingRow("Loading themes"))).toBe("Loading themes…");
	});

	/**
	 * The two arms that name a weight compare against `theme.fg(...)`, which
	 * returns its input unchanged unless the policy is `full`. Without the pin
	 * above and this arm, a repaint from `dim` to any other weight passes both of
	 * them: each side collapses to the bare text and neither comparison is about
	 * colour any more. That is not hypothetical — the mutation gate repainted
	 * this row and stayed green until the pin landed.
	 */
	it("can tell one weight from another at all", () => {
		initTheme();

		expect(theme.fg("dim", "x")).not.toBe("x");
		expect(theme.fg("dim", "x")).not.toBe(theme.fg("muted", "x"));
	});

	/** A renderer handed a theme paints through it rather than the active singleton. */
	it("paints through a theme it is handed", () => {
		initTheme();

		expect(waitingRow("Waiting for workflow jobs", { theme })).toBe(theme.fg("dim", "Waiting for workflow jobs…"));
	});
});

describe("no second spelling of a wait", () => {
	/**
	 * The sweep, so a thirty-second site cannot arrive quietly. It reads the
	 * source tree at run time rather than a list written here, which is the only
	 * version that stays true as the tree grows.
	 */
	it("ends no display string in three ASCII periods", () => {
		expect(offenders()).toEqual([]);
	});

	/**
	 * An exemption earns itself or it goes: a file whose fragment was reworded
	 * leaves an entry here that would quietly excuse the next hand-spelled wait
	 * written into it.
	 */
	it("holds no exemption that has stopped applying", () => {
		const matching = [...new Set(hits().map(hit => hit.slice(0, hit.lastIndexOf(":"))))].sort();

		expect(matching).toEqual(Object.keys(EXEMPT).sort());
	});

	/**
	 * The sweep has to be able to fail, and a predicate that matches nothing
	 * anywhere passes the arm above for the wrong reason. Fed the shapes the
	 * defect had, it fires; fed the fragments the class excludes, it does not.
	 */
	it("recognises the spellings it is looking for", () => {
		expect(endsInAsciiDots('"Sharing session..."')).toBe(true);
		// A one-word wait: no space anywhere in it, and still the class's row.
		expect(endsInAsciiDots('"Working...\\n"')).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture quotes an interpolated wait row
		expect(endsInAsciiDots('`Reauthorizing "${name}"...`')).toBe(true);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture quotes a truncation marker, which is another owner's row
		expect(endsInAsciiDots("`${head.slice(0, 45)}...`")).toBe(false);
		expect(endsInAsciiDots('"never ~ or ~/..."')).toBe(false);
		expect(endsInAsciiDots('"bunx @smithery/cli run ..."')).toBe(false);
		expect(endsInAsciiDots('"Loading themes…"')).toBe(false);
	});
});
