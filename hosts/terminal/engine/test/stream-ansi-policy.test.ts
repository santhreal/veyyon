import { describe, expect, it } from "bun:test";
import { detectAnsiPolicy, detectStreamAnsiPolicy } from "@veyyon/tui";

/**
 * A pipe is not a terminal, and one function must be the one that knows it.
 *
 * WHY THIS SUITE EXISTS (TUI-4). "Should this output carry escape sequences" is
 * one question, and it had three answers living in three places:
 *
 *   - `detectAnsiPolicy` read the environment (`FORCE_COLOR`, `TERM=dumb`,
 *     `NO_COLOR`) and nothing else, so an ordinary piped run answered `full`.
 *   - The theme's `fg`/`bg` consulted only that policy, and therefore emitted
 *     truecolor escapes into a pipe.
 *   - `isHyperlinkEnabled` consulted the policy AND `process.stdout.isTTY`,
 *     spelled out locally, and therefore correctly stayed off.
 *
 * Two detectors that can disagree about the same question is the shape a silent
 * fallback takes: nothing errors, the two surfaces simply behave differently,
 * and which one you notice depends on which feature you used. The visible cost
 * is real, because escape sequences in a redirected file are not decoration,
 * they are bytes the reader has to look past.
 *
 * `detectStreamAnsiPolicy` is the fold. The environment question and the
 * destination question are answered in one place, and `detectAnsiPolicy` stays
 * env-only on purpose: a renderer that owns its own PTY is writing to a terminal
 * whatever this process's stdout happens to be, and folding the TTY check into
 * the base function would have turned every such renderer plain.
 *
 * `FORCE_COLOR` overriding the pipe is the case that keeps CI working: a runner
 * pipes its output and still wants colour in the captured log, which is the
 * entire reason that variable exists.
 */

describe("a non-TTY destination is plain", () => {
	/**
	 * THE REGRESSION. A capable environment plus a pipe used to answer `full`, and
	 * the theme took it at its word.
	 */
	it("returns plain for a pipe even in a colour-capable environment", () => {
		expect(detectStreamAnsiPolicy({ TERM: "xterm-256color" }, false)).toBe("plain");
	});

	/** A bare environment plus a pipe is plain for the same reason. */
	it("returns plain for a pipe with no styling variables set", () => {
		expect(detectStreamAnsiPolicy({}, false)).toBe("plain");
	});

	/**
	 * The env-only function is deliberately unchanged. A renderer driving a PTY it
	 * owns must still get `full`, and folding the TTY check in here would have
	 * turned the whole TUI plain whenever the process was launched from a script.
	 */
	it("leaves the environment-only reading at full for the same input", () => {
		expect(detectAnsiPolicy({ TERM: "xterm-256color" })).toBe("full");
	});
});

describe("a TTY destination keeps the environment's answer", () => {
	/** The ordinary interactive case is untouched. */
	it("returns full for a TTY in a colour-capable environment", () => {
		expect(detectStreamAnsiPolicy({ TERM: "xterm-256color" }, true)).toBe("full");
	});

	/**
	 * NO_COLOR still means noColor, not plain. The convention asks for colour to
	 * be dropped, not for all styling to go, so bold and italic still carry
	 * emphasis to a reader who turned colour off because it was unreadable.
	 */
	it("returns noColor for a TTY with NO_COLOR set", () => {
		expect(detectStreamAnsiPolicy({ NO_COLOR: "1", TERM: "xterm-256color" }, true)).toBe("noColor");
	});

	/** `TERM=dumb` is plain on a TTY too: that terminal cannot interpret escapes. */
	it("returns plain for a TTY with TERM=dumb", () => {
		expect(detectStreamAnsiPolicy({ TERM: "dumb" }, true)).toBe("plain");
	});

	/**
	 * An empty `NO_COLOR=` disables nothing, which is what the convention
	 * specifies. Treating the variable as a mere presence check is the classic
	 * misreading and would strip colour for anyone whose shell exports it empty.
	 */
	it("ignores an empty NO_COLOR", () => {
		expect(detectStreamAnsiPolicy({ NO_COLOR: "", TERM: "xterm-256color" }, true)).toBe("full");
	});
});

describe("FORCE_COLOR overrides the pipe", () => {
	/**
	 * THE CASE THAT KEEPS CI COLOURED. A runner pipes its output and still wants
	 * colour in the captured log, which is the entire reason the variable exists.
	 * If this ever stops working, every CI log goes monochrome at once.
	 */
	it("returns full for a pipe when FORCE_COLOR is set", () => {
		expect(detectStreamAnsiPolicy({ FORCE_COLOR: "1" }, false)).toBe("full");
	});

	/** It outranks NO_COLOR, matching every other tool that implements both. */
	it("beats NO_COLOR on a pipe", () => {
		expect(detectStreamAnsiPolicy({ FORCE_COLOR: "1", NO_COLOR: "1" }, false)).toBe("full");
	});

	/** It outranks TERM=dumb as well, since it is an explicit operator override. */
	it("beats TERM=dumb on a pipe", () => {
		expect(detectStreamAnsiPolicy({ FORCE_COLOR: "1", TERM: "dumb" }, false)).toBe("full");
	});

	/**
	 * `FORCE_COLOR=0` is the documented "off" spelling and must not be read as
	 * merely present. A presence check here would force colour on for anyone who
	 * had explicitly turned it off.
	 */
	it("does not treat FORCE_COLOR=0 as a request for colour", () => {
		expect(detectStreamAnsiPolicy({ FORCE_COLOR: "0", TERM: "xterm-256color" }, false)).toBe("plain");
	});

	/** An empty FORCE_COLOR is the same non-request. */
	it("does not treat an empty FORCE_COLOR as a request for colour", () => {
		expect(detectStreamAnsiPolicy({ FORCE_COLOR: "", TERM: "xterm-256color" }, false)).toBe("plain");
	});
});
