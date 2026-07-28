/**
 * A surface that tells you something about itself reads it, rather than writing it out.
 *
 * TWO PHRASES, ONE DISEASE, so they are gated together: the key that expands a
 * folded block, and the count of what the fold hid. Both are printed by a dozen or
 * more surfaces, both were written out as literals at every one of them, and both
 * were therefore wrong everywhere at once.
 *
 * WHY THIS SUITE EXISTS. `app.tools.expand` is remappable, and every handler in
 * the product read it properly. Six places that NAME it did not, and each was a
 * literal `ctrl+o` printed at the user:
 *
 * - the Agent Control Center's Comms footer chip,
 * - its fold line under a truncated message,
 * - the rule-injection notice, in three separate branches,
 * - the bash/eval execution block's hidden-line note,
 * - and two hints in the `ssh` tool's rendered output.
 *
 * So the one gesture with the most places telling you about it was also the one
 * most likely to tell you wrong, in the exact moment you were looking for the key.
 *
 * The chord rule below is deliberately narrow. A general "no chord literal in `src`"
 * rule cannot work: `matchesKey(data, "ctrl+c")` names a chord for a good reason,
 * and a gate that fired on it would be turned off within a week. So this one
 * watches the PHRASING a hint uses, which no matcher ever writes.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { expandHintSuffix, keyHint } from "@veyyon/coding-agent/modes/utils/key-hint";
import { getKeybindings, setKeybindings } from "@veyyon/tui";

const SRC = path.resolve(import.meta.dir, "../../../src");

/** Every `.ts` under `src`, tests and vendored trees excluded. */
function sources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "vendor" && entry.name !== "__tests__") sources(full, found);
			continue;
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
	}
	return found;
}

/**
 * A chord written into hint PHRASING, as `file:line`.
 *
 * The two shapes the product used: `(ctrl+o to expand)` in a sentence, and
 * `ctrl+o expand` as a footer chip. Both are how a hint reads and neither is how
 * a matcher is written, which is what keeps this off `matchesKey(data, "ctrl+c")`.
 */
export function handWrittenChordHints(source: string, file: string): string[] {
	const pattern = /(?:ctrl|alt|shift|super|cmd)\+[a-z+]+\s+(?:to\s+)?(?:expand|collapse)/gi;
	const found: string[] = [];
	source.split("\n").forEach((line, index) => {
		if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
		for (const match of line.matchAll(pattern)) found.push(`${file}:${index + 1}: ${match[0]}`);
	});
	return found;
}

describe("no surface writes the expand chord out by hand", () => {
	/**
	 * The scan reads a real tree. A walk that found nothing would satisfy the rule
	 * below while checking nothing, which is the failure mode of every gate built
	 * on a source scan.
	 */
	it("reads the whole source tree", () => {
		const files = sources(SRC);

		expect(files.length).toBeGreaterThan(500);
		expect(files.some(file => file.endsWith(path.join("modes", "utils", "key-hint.ts")))).toBe(true);
	});

	/**
	 * The rule. A failure names the file and line, and the fix is one call:
	 * `actionKeyHint("app.tools.expand")` for a surface with no injection point,
	 * or `keyHint(injectedKeys)` for one the host constructs.
	 */
	it("has no hint that spells the chord instead of reading it", () => {
		const offenders = sources(SRC).flatMap(file =>
			handWrittenChordHints(fs.readFileSync(file, "utf8"), path.relative(SRC, file)),
		);

		expect(
			offenders.sort(),
			"this hint writes a remappable chord out. Use actionKeyHint/keyHint from modes/utils/key-hint, or it lies to anyone who rebinds it",
		).toEqual([]);
	});
});

/**
 * The same disease, a different phrase.
 *
 * Nineteen surfaces wrote `${n} more lines` inline, so nineteen of them said "1 more
 * lines" whenever output ran one row past the preview budget, which is the commonest
 * fold there is. `formatMoreLines` owns the counted phrase now, and this rule fails
 * on a twentieth copy.
 */
describe("no surface counts folded lines by hand", () => {
	/**
	 * The rule, watching for a count interpolated straight into the phrase. The fix
	 * is `formatMoreLines(n)` from `@veyyon/utils/format`, keeping whatever framing
	 * the surface already puts around it.
	 */
	it("has no inline more-lines phrase", () => {
		const pattern = /\$\{[^}]+\}\s+more\s+lines/;
		const offenders = sources(SRC)
			.map(file => ({ file: path.relative(SRC, file), source: fs.readFileSync(file, "utf8") }))
			.flatMap(({ file, source }) =>
				source
					.split("\n")
					.map((line, index) => ({ line, index }))
					.filter(({ line }) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
					.filter(({ line }) => pattern.test(line))
					.map(({ index }) => `${file}:${index + 1}`),
			);

		expect(
			offenders.sort(),
			"this writes the more-lines phrase inline and will say '1 more lines'. Use formatMoreLines from @veyyon/utils/format",
		).toEqual([]);
	});

	/**
	 * And the pattern really matches the shape it is looking for, so the rule above
	 * is not green because it sees nothing. Without this a typo in the pattern
	 * makes the gate permanently useless.
	 */
	it("recognizes the inline phrase it forbids", () => {
		const pattern = /\$\{[^}]+\}\s+more\s+lines/;

		expect(pattern.test("push(`… ${remaining} more lines`)")).toBe(true);
		expect(pattern.test("push(`… ${formatMoreLines(remaining)}`)")).toBe(false);
	});
});

describe("the hint reader", () => {
	/**
	 * The two shapes really are caught, so the rule above is not passing because
	 * the pattern matches nothing. This is the non-vacuity twin, and without it a
	 * typo in the pattern would make the gate permanently green.
	 */
	it("finds a chord in both shapes a hint is written in", () => {
		const sentence = handWrittenChordHints('push(`… ${n} more lines (ctrl+o to expand)`);', "a.ts");
		const chip = handWrittenChordHints('{ label: "ctrl+o expand" },', "b.ts");

		expect(sentence).toEqual(["a.ts:1: ctrl+o to expand"]);
		expect(chip).toEqual(["b.ts:1: ctrl+o expand"]);
	});

	/**
	 * And a matcher is not a hint. `matchesKey(data, "ctrl+o")` names the same
	 * chord for the right reason, and a rule that fired on it would be switched off
	 * rather than obeyed.
	 */
	it("ignores a matcher and a comment that mention the same chord", () => {
		const matcher = handWrittenChordHints('if (matchesKey(data, "ctrl+o")) toggle();', "c.ts");
		const comment = handWrittenChordHints("\t// Ctrl+O to expand the folded tail.", "d.ts");
		const docComment = handWrittenChordHints("\t * `ctrl+o to expand` was the old hint.", "e.ts");

		expect([...matcher, ...comment, ...docComment]).toEqual([]);
	});

	/**
	 * The hint helper's own contract: no keys means no hint, so a caller can drop
	 * the whole phrase rather than print an empty pair of parentheses.
	 */
	it("returns nothing for an action bound to nothing", () => {
		expect(keyHint([])).toBe("");
		expect(keyHint(["ctrl+o"])).toBe("ctrl+o");
		expect(keyHint(["ctrl+o", "alt+o"])).toBe("ctrl+o/alt+o");
	});

	/**
	 * The suffix five truncation notices share, with its leading space, so a caller
	 * can append it to a count and get `… 80 more lines (ctrl+o to expand)` rather
	 * than gluing two words together.
	 *
	 * The manager is installed explicitly rather than relied on. `getKeybindings()`
	 * hands back a bare TUI manager until the app installs its own, and that one
	 * has no `app.*` ids at all, so a test that read the ambient global would pass
	 * or fail on whichever suite happened to run first.
	 */
	it("builds the truncation suffix the five notices append", () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		try {
			expect(expandHintSuffix()).toBe(" (ctrl+o to expand)");
		} finally {
			setKeybindings(previous);
		}
	});

	/**
	 * And with the action unbound the whole phrase goes, rather than leaving `()`
	 * or a dangling "to expand" with no key in it.
	 */
	it("drops the whole phrase when the action is unbound", () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		try {
			expect(expandHintSuffix()).toBe("");
		} finally {
			setKeybindings(previous);
		}
	});
});
