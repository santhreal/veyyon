/**
 * "1 more line", not "1 more lines", and the phrase has one owner.
 *
 * WHY THIS SUITE EXISTS. Nineteen surfaces across the coding agent fold long output
 * and then say how much they hid: every collapsed tool block, the read tool's
 * continuation notice, the edit preview, the LSP hover, the MCP and eval renderers,
 * the `ssh` output, the Agent Control Center's comms fold. Every one of them wrote
 * `${n} more lines` inline.
 *
 * So all nineteen were wrong on the commonest case there is. A block that hides
 * exactly one line is what you get whenever output is one row over the preview
 * budget, and every one of them said "1 more lines". It was found by rendering the
 * comms stream off-screen and reading the picture, which is the only way a defect
 * that no assertion mentions gets noticed: the inspect-image suite had a fixture
 * hiding exactly one line and asserted `toContain("more lines")`, which passed on
 * the broken text.
 *
 * WHAT THE OWNER RETURNS, and why it is not the whole notice. Just the counted
 * phrase: no leading ellipsis, no trailing expand hint. The surfaces frame it
 * differently on purpose, some in parentheses, some in brackets with a continuation
 * offset, some followed by the expand key, and folding the decoration in would force
 * nineteen callers to share a shape they do not share, which is how a helper gets
 * copied instead of called.
 */

import { describe, expect, it } from "bun:test";
import { formatMoreLines, pluralize } from "@veyyon/utils/format";

describe("the more-lines phrase", () => {
	/**
	 * The bug, by name. This is the case every one of the nineteen call sites got
	 * wrong, and the reason the helper exists at all.
	 */
	it("says one more line in the singular", () => {
		expect(formatMoreLines(1)).toBe("1 more line");
	});

	/**
	 * The plural twin, so a fix that dropped the `s` unconditionally would fail
	 * here rather than pass the rule above and ship the opposite mistake.
	 */
	it("says more lines for anything else", () => {
		expect(formatMoreLines(2)).toBe("2 more lines");
		expect(formatMoreLines(80)).toBe("80 more lines");
	});

	/**
	 * Zero is plural, which is right in English and is also what the callers need:
	 * a surface that reaches this with zero is reporting a fold that hid nothing,
	 * and "0 more line" would read as a rounding error rather than as the count it
	 * is. The callers guard on `> 0` before printing it; this pins the answer
	 * anyway so the guard is not the only thing standing between a user and it.
	 */
	it("says zero more lines rather than zero more line", () => {
		expect(formatMoreLines(0)).toBe("0 more lines");
	});

	/**
	 * It delegates to the package's own pluralizer rather than testing `n === 1`
	 * itself. Two rules for one question is how the two drift, and `pluralize`
	 * already owns the `ch`/`sh`/`y` cases this word does not happen to need.
	 */
	it("agrees with the package pluralizer", () => {
		for (const count of [0, 1, 2, 11, 100]) {
			expect(formatMoreLines(count)).toBe(`${count} more ${pluralize("line", count)}`);
		}
	});

	/**
	 * A negative count is passed through rather than clamped. No caller produces
	 * one, and swallowing it would turn an arithmetic bug upstream into a plausible
	 * sentence; "-1 more lines" is visibly wrong, which is what you want it to be.
	 */
	it("passes a negative count through instead of hiding it", () => {
		expect(formatMoreLines(-1)).toBe("-1 more lines");
	});
});
