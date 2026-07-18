/**
 * Exact-value coverage for inlineMathSpanEnd (latex-to-unicode.ts), the pure
 * scanner that decides where an inline `$…$` math span closes inside arbitrary
 * user text. It gates whether prose like "it costs $5 and $10" is mangled into
 * math, so its open/close/escape/currency rules must be pinned exactly. It was
 * only exercised indirectly through renderMathInText.
 */
import { describe, expect, it } from "bun:test";
import { inlineMathSpanEnd } from "@veyyon/tui/latex-to-unicode";

describe("inlineMathSpanEnd", () => {
	it("returns the closing-$ index for a simple span", () => {
		// "$x$" -> close at index 2.
		expect(inlineMathSpanEnd("$x$", 0)).toBe(2);
		// "a $xy$ b" -> open at 2, close at 5.
		expect(inlineMathSpanEnd("a $xy$ b", 2)).toBe(5);
	});

	it("rejects an opener immediately followed by whitespace or another $", () => {
		expect(inlineMathSpanEnd("$ x$", 0)).toBe(-1); // space after $
		expect(inlineMathSpanEnd("$\tx$", 0)).toBe(-1); // tab after $
		expect(inlineMathSpanEnd("$$", 0)).toBe(-1); // empty $$
		expect(inlineMathSpanEnd("$", 0)).toBe(-1); // nothing after $
	});

	it("rejects a close preceded by whitespace (not real inline math)", () => {
		expect(inlineMathSpanEnd("$x $", 0)).toBe(-1);
	});

	it("does not close on a newline-crossing span", () => {
		expect(inlineMathSpanEnd("$x\ny$", 0)).toBe(-1);
	});

	it("skips an escaped dollar and closes at the next real one", () => {
		// chars: $ a \ $ b $  -> the \$ is escaped, real close at index 5.
		expect(inlineMathSpanEnd("$a\\$b$", 0)).toBe(5);
	});

	it("treats $<digit> as currency and keeps scanning to the true close", () => {
		// chars: $ x $ 5 $ -> inner "$5" is currency, real close at index 4.
		expect(inlineMathSpanEnd("$x$5$", 0)).toBe(4);
	});

	it("returns -1 when the span never closes", () => {
		expect(inlineMathSpanEnd("$xyz", 0)).toBe(-1);
		expect(inlineMathSpanEnd("$a\\", 0)).toBe(-1); // trailing lone backslash
	});

	it("honors the open index into a longer string", () => {
		const text = "price $x+y$ done";
		// "$" is at index 6, close "$" at index 10.
		expect(text[6]).toBe("$");
		expect(inlineMathSpanEnd(text, 6)).toBe(10);
	});
});
