/**
 * Escape sequences pasted into a message are not the user's prose, and must not survive the strip.
 *
 * `computeUserMessageMetrics` reads a message for behavioral signals, and computes them
 * over a prose body with the structured content removed first: code fences, XML wrappers,
 * URLs, file mentions, quoted lines. Pasted terminal output belongs in that category and it
 * arrives carrying escape sequences.
 *
 * The strip used to be a local pattern, `/\x1b\[[0-9;]*[A-Za-z]/g`, which accepts only a
 * CSI whose parameters are digits and semicolons and whose final byte is a letter. It knew
 * nothing about private-mode sequences (`?` is a parameter byte), colon subparameters,
 * intermediate bytes, non-alphabetic finals, or OSC at all. The grammar now comes from
 * `@veyyon/utils/strip-ansi`, which owns it and is pinned against its Rust twin.
 *
 * ASSERTED ON THE STRIPPED TEXT, not on the metrics. The signals cannot observe most of
 * what leaks: the leftover from a missed `ESC [ ?25l` is `?25l`, which matches no signal
 * pattern and shifts no count, so a test through the metrics would pass whether or not the
 * sequence was stripped. What the leftover DOES do is join the prose and move where
 * sentences begin and end, so the contract has to be stated over the prose body itself.
 */

import { describe, expect, it } from "bun:test";
import { computeUserMessageMetrics, stripStructuredContent } from "@veyyon/stats/user-metrics";

/** The sentence every case wraps, so any extra character in the result is a leak. */
const SENTENCE = "please fix the build";

describe("stripStructuredContent removes pasted escape sequences", () => {
	/**
	 * The baseline: prose with no escapes in it comes back unchanged.
	 *
	 * Without this, every assertion below would also pass against a function that
	 * returned the empty string.
	 */
	it("returns plain prose unchanged", () => {
		expect(stripStructuredContent(SENTENCE)).toBe(SENTENCE);
	});

	/**
	 * A colour code, which the old pattern did handle. Kept so a regression in the
	 * ordinary case is not masked by the harder cases passing.
	 */
	it("removes an SGR colour sequence", () => {
		expect(stripStructuredContent(`\x1b[31m${SENTENCE}\x1b[0m`)).toBe(SENTENCE);
	});

	/**
	 * A private-mode sequence, where `?` is a parameter byte the old class excluded.
	 *
	 * `ESC [ ?25l` and `ESC [ ?25h` hide and show the cursor and bracket almost every
	 * interactive program's output, which makes them the likeliest sequences in a paste.
	 * They used to leave `?25l` and `?25h` behind, and `?` is a sentence terminator to
	 * the splitter, so the leftover did not just add characters, it cut the sentence.
	 */
	it("removes a private-mode sequence", () => {
		expect(stripStructuredContent(`\x1b[?25l${SENTENCE}\x1b[?25h`)).toBe(SENTENCE);
	});

	/**
	 * Colon subparameters, as libvte and several test runners emit for truecolor.
	 *
	 * The old class allowed `;` and not `:`, so nothing matched at all and the whole
	 * `[38:2:255:0:0m` stayed in the prose.
	 */
	it("removes a colon-subparameter truecolor sequence", () => {
		expect(stripStructuredContent(`\x1b[38:2:255:0:0m${SENTENCE}\x1b[39m`)).toBe(SENTENCE);
	});

	/**
	 * A non-alphabetic final byte, which the old pattern required to be `[A-Za-z]`.
	 *
	 * `ESC [ ?1;2$y` is a DECRPM mode report, `$` is an intermediate byte and `y` the
	 * final. Terminal replies pasted out of a session carry these.
	 */
	it("removes a sequence with an intermediate byte", () => {
		expect(stripStructuredContent(`\x1b[?1;2$y${SENTENCE}`)).toBe(SENTENCE);
	});

	/**
	 * An OSC hyperlink, which the old pattern did not know about at all.
	 *
	 * The worst of the set, because the sequence carries a payload: the entire target
	 * stayed in the prose. A long one alone can push a message past the three-line
	 * threshold that zeroes every signal, which silently disables the metrics for that
	 * message rather than merely skewing them.
	 */
	it("removes an OSC hyperlink, target included", () => {
		const open = "\x1b]8;;https://example.com/a/very/long/path/that/is/not/prose\x07";
		expect(stripStructuredContent(`${open}${SENTENCE}\x1b]8;;\x07`)).toBe(SENTENCE);
	});

	/**
	 * An OSC title set terminated by ST rather than BEL. Both spellings are in use.
	 */
	it("removes an ST-terminated OSC", () => {
		expect(stripStructuredContent(`\x1b]0;window title\x1b\\${SENTENCE}`)).toBe(SENTENCE);
	});

	/**
	 * A capture cut mid-sequence, which is what a paste from a scrolled buffer looks like.
	 *
	 * The stray escape byte goes and the text after it stays, which is `stripAnsi`'s
	 * documented contract and the reason stripping is a fixed point: a leftover escape
	 * could be pushed against a following `[` by a later removal and MAKE a sequence that
	 * was not there before.
	 */
	it("drops a stray escape byte and keeps the words after it", () => {
		expect(stripStructuredContent(`\x1b${SENTENCE}`)).toBe(SENTENCE);
	});

	/**
	 * Several sequences at once, which is what real pasted output looks like.
	 */
	it("removes a realistic pasted prompt line", () => {
		const pasted = `\x1b[?25l\x1b[1;32muser@host\x1b[0m:\x1b[1;34m~/src\x1b[0m$ \x1b[?25h`;
		expect(stripStructuredContent(`${pasted}${SENTENCE}`)).toBe(`user@host:~/src$ ${SENTENCE}`);
	});
});

describe("the strip does not eat prose", () => {
	/**
	 * The guard on the guard: text that merely LOOKS like an escape has no escape byte.
	 *
	 * Brackets, semicolons and letters are ordinary writing, and a pattern loose enough
	 * to catch the cases above must not reach them.
	 */
	it("keeps bracketed text that carries no escape byte", () => {
		const text = "the array [0;31m] is wrong and ]8;; is not a link";
		expect(stripStructuredContent(text)).toBe(text);
	});

	/**
	 * And the signals still read the prose that survives.
	 *
	 * The strip is only worth having if what it leaves behind is still scored, so this
	 * carries a shouted sentence through a pasted colour code and asserts the metric,
	 * not just the text.
	 */
	it("still scores the prose left behind by the strip", () => {
		const metrics = computeUserMessageMetrics("\x1b[?25lWHY IS THIS STILL BROKEN\x1b[0m");
		expect(metrics.yelling).toBe(1);
		expect(metrics.blame).toBe(0);
	});
});
