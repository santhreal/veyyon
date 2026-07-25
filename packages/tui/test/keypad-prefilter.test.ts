/**
 * The keypad fast path's cheap rejection, and the invariant it rests on.
 *
 * WHY THIS SUITE EXISTS. `parseKey` and `matchesKey` both consult `decodeKittyKeypadText` BEFORE
 * the native parser, on every keypress. It used to run a six-group regular expression against every
 * input, including a plain `a` and a raw `\x03`, neither of which can possibly match. It now rejects
 * those with three `charCodeAt` comparisons first, worth roughly 8% of the cost of parsing a
 * non-Kitty keypress (measured across three process pairs: 229ns to 209ns for `a`, 233 to 209 for
 * `ctrl+c`, 250 to 234 for a legacy arrow, with Kitty sequences unchanged since they pass straight
 * through the guard).
 *
 * Measuring it turned up something the code did not say. The reason recorded at the function was
 * bare numpad codepoints coming back as navigation keys, and the native matcher no longer does
 * that: an exhaustive sweep of the 16 keypad codepoints against every modifier value and event type
 * found the two paths agreeing everywhere EXCEPT the shift bit on the five operator codepoints, 120
 * inputs where native reports `shift+/` for a key that produces `/`. So the pre-check is live for
 * one reason, none of it was covered by a test, and a mutation of the guard passed a first version
 * of this suite clean. Those cases are pinned below.
 *
 * The guard is safe only because it tests a NECESSARY condition of the pattern it precedes:
 * `KITTY_CSI_U_PATTERN` is anchored `^\x1b\[` and terminated `u$`, so anything failing the guard
 * would have failed the regex. That coupling is invisible at the guard, which is what makes it
 * dangerous: widening the pattern to accept another terminator (`~`, or a final letter, both of
 * which appear in other Kitty forms) would leave the guard silently dropping sequences the pattern
 * now accepts, and a dropped keypad sequence does not error. It parses as a navigation key, so
 * numpad `1` starts moving the cursor to end-of-line instead of typing a digit.
 *
 * So this suite pins both halves: every optional group of the pattern still reaches the decoder
 * with the guard in place, and the pattern still has the anchors the guard assumes.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { matchesKey, parseKey, setKittyProtocolActive } from "../src/keys";

/** Every numpad codepoint the fast path decodes, with the digit it must produce. */
const NUMPAD: readonly [number, string][] = [
	[57399, "0"],
	[57400, "1"],
	[57401, "2"],
	[57402, "3"],
	[57403, "4"],
	[57404, "5"],
	[57405, "6"],
	[57406, "7"],
	[57407, "8"],
	[57408, "9"],
	[57409, "."],
];

/** Every keypad operator codepoint the fast path decodes. */
const OPERATORS: readonly [number, string][] = [
	[57410, "/"],
	[57411, "*"],
	[57412, "-"],
	[57413, "+"],
	[57415, "="],
];

describe("sequences the guard must let through", () => {
	/**
	 * The whole table, not a sample. A guard that rejected one codepoint would look correct in a
	 * spot check and turn exactly one key on the numpad into a navigation key.
	 */
	it("decodes every numpad digit", () => {
		setKittyProtocolActive(true);
		for (const [codepoint, text] of NUMPAD) {
			expect(parseKey(`\x1b[${codepoint}u`)).toBe(text);
		}
		setKittyProtocolActive(false);
	});

	it("decodes every keypad operator", () => {
		setKittyProtocolActive(true);
		for (const [codepoint, text] of OPERATORS) {
			expect(parseKey(`\x1b[${codepoint}u`)).toBe(text);
		}
		setKittyProtocolActive(false);
	});

	/**
	 * The pattern's optional groups: shifted key, base layout key, modifier, and event type. Each
	 * lengthens the sequence between the `\x1b[` the guard checks and the `u` it checks, so each is a
	 * chance for a guard written against one shape to reject another.
	 */
	it("decodes a numpad digit through each optional field of the sequence", () => {
		setKittyProtocolActive(true);

		expect(parseKey("\x1b[57400u")).toBe("1");
		expect(parseKey("\x1b[57400;129u")).toBe("1"); // NumLock modifier
		expect(parseKey("\x1b[57400;1u")).toBe("1"); // explicit no-modifier
		expect(parseKey("\x1b[57400:57400u")).toBe("1"); // shifted key present
		expect(parseKey("\x1b[57400::57400u")).toBe("1"); // base layout key present
		expect(parseKey("\x1b[57400;1:1u")).toBe("1"); // event type: press

		setKittyProtocolActive(false);
	});

	/**
	 * The ONLY behaviour this path still owns, and it had no test. Shift does not change the
	 * character a keypad key produces, so a shifted keypad `/` is a `/`. The native matcher reports
	 * `shift+/`, which on a main keyboard is where `?` lives, so without this path a shifted keypad
	 * operator inserts nothing and matches no keybinding. Everything else the path covers, native
	 * has since learned to answer identically, which is exactly why this needs pinning: the next
	 * person measuring the pre-check will find it redundant on digits and delete it.
	 */
	it("decodes a shifted keypad operator as its unshifted character", () => {
		setKittyProtocolActive(true);

		for (const [codepoint, text] of OPERATORS) {
			expect(parseKey(`\x1b[${codepoint};2u`)).toBe(text); // shift
			expect(parseKey(`\x1b[${codepoint};130u`)).toBe(text); // shift + NumLock
			expect(matchesKey(`\x1b[${codepoint};2u`, text as never)).toBe(true);
		}

		setKittyProtocolActive(false);
	});

	/** Shift with an event type appended, which is the longest form the guard has to pass through. */
	it("decodes a shifted keypad operator carrying an event type", () => {
		setKittyProtocolActive(true);

		expect(parseKey("\x1b[57410;130:1u")).toBe("/");
		expect(parseKey("\x1b[57410;130:2u")).toBe("/");
		expect(parseKey("\x1b[57411;2:1u")).toBe("*");

		setKittyProtocolActive(false);
	});

	/** `matchesKey` shares the pre-check, so it shares the guard and needs the same assurance. */
	it("matches a keypad digit by its printable text", () => {
		setKittyProtocolActive(true);

		expect(matchesKey("\x1b[57400u", "1")).toBe(true);
		expect(matchesKey("\x1b[57400u", "end")).toBe(false);
		expect(matchesKey("\x1b[57410u", "/")).toBe(true);

		setKittyProtocolActive(false);
	});
});

describe("sequences the guard rejects, and must still parse", () => {
	/**
	 * The point of the guard is that these skip the regex entirely. They must come back with the
	 * same keys they always did, since the native parser owns them and always did.
	 */
	it("parses printable characters and control codes", () => {
		setKittyProtocolActive(true);

		expect(parseKey("a")).toBe("a");
		expect(parseKey("/")).toBe("/");
		expect(parseKey("\x03")).toBe("ctrl+c");
		expect(parseKey("\x1b")).toBe("escape");
		expect(parseKey("\t")).toBe("tab");

		setKittyProtocolActive(false);
	});

	/** CSI sequences with a different terminator: an `\x1b[` prefix alone must not be enough. */
	it("parses CSI sequences that do not end in u", () => {
		setKittyProtocolActive(true);

		expect(parseKey("\x1b[A")).toBe("up");
		expect(parseKey("\x1b[3~")).toBe("delete");
		expect(parseKey("\x1b[1;5C")).toBe("ctrl+right");
		expect(parseKey("\x1b[Z")).toBe("shift+tab");

		setKittyProtocolActive(false);
	});

	/** A `u` at the end with no CSI introducer: the last character alone must not be enough either. */
	it("parses a bare u as the letter", () => {
		setKittyProtocolActive(true);

		expect(parseKey("u")).toBe("u");

		setKittyProtocolActive(false);
	});

	/**
	 * A CSI-u sequence whose codepoint is NOT a keypad key. It passes the guard and the regex, and
	 * the decoder then declines it so native normalization keeps ownership of named keys. This is the
	 * case the guard must not accidentally start answering.
	 */
	it("leaves non-keypad CSI-u sequences to the native parser", () => {
		setKittyProtocolActive(true);

		expect(parseKey("\x1b[32u")).toBe("space");
		expect(parseKey("\x1b[97;5u")).toBe("ctrl+a");
		expect(parseKey("\x1b[127u")).toBe("backspace");

		setKittyProtocolActive(false);
	});

	/** Degenerate inputs must not throw out of the `charCodeAt` reads, which return NaN past the end. */
	it("survives an empty and a one-character input", () => {
		setKittyProtocolActive(true);

		expect(parseKey("")).toBeUndefined();
		expect(() => parseKey("\x1b")).not.toThrow();

		setKittyProtocolActive(false);
	});
});

describe("the invariant the guard assumes", () => {
	/**
	 * The coupling, asserted on the source because it cannot be expressed at the guard. If the
	 * pattern stops requiring `^\x1b\[` or stops ending in `u$`, the guard becomes a filter that
	 * drops valid input, and the symptom is a numpad key silently acting as a navigation key rather
	 * than anything that throws. Widening the pattern must widen the guard in the same change.
	 */
	it("keeps KITTY_CSI_U_PATTERN anchored on the two characters the guard checks", async () => {
		const source = await Bun.file(path.join(import.meta.dir, "../src/keys.ts")).text();
		const line = source.split("\n").find(text => text.includes("const KITTY_CSI_U_PATTERN"));

		expect(line).toBeDefined();
		expect(line).toContain("/^\\x1b\\[");
		expect(line?.trimEnd().endsWith("u$/;")).toBe(true);
	});
});
