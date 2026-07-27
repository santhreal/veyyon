/**
 * A bare LF means Shift+Enter when the Kitty keyboard protocol is active, and plain Enter when it is
 * not.
 *
 * WHY THIS SUITE EXISTS. Under the Kitty protocol plain Enter arrives as CR or as the CSI-u sequence
 * for codepoint 13, never as a lone 0x0A, so a bare LF from a Kitty-capable terminal is the
 * iTerm2-style mapping of Shift+Enter. Without the protocol, LF is one of the bytes a legacy terminal
 * sends for plain Enter and has to keep meaning Enter.
 *
 * The pure-TypeScript parser that `src/keys.ts` replaced drew exactly that distinction, and LF turned
 * out to be the ONLY input whose answer its `kittyProtocolActive` argument ever changed: sweeping all
 * 128 single bytes plus generated Kitty CSI-u, legacy CSI and SS3 sequences against both parsers in
 * both modes found LF and nothing else. The native parser answers `enter` in both modes, so the
 * distinction was lost in the migration with no test to notice. The visible effect was that a
 * `shift+enter` binding stopped matching Shift+Enter on those terminals: the only reason the message
 * editor still inserted a newline instead of submitting is that `editor.ts` carries its own raw
 * `data === "\n"` byte comparison, which no other component has.
 *
 * `keys.ts` restores it by rewriting the ambiguous byte to the canonical Shift+Enter sequence and
 * letting the native parser answer, so aliases and modifier naming keep one owner. These tests pin the
 * behaviour on both sides of the flag, the alias, and the neighbouring bytes that must NOT be
 * translated, because a rewrite applied one byte too widely would turn plain Enter into Shift+Enter for
 * everyone.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { isKittyProtocolActive, type KeyId, matchesKey, parseKey, setKittyProtocolActive } from "../src/keys";

const LINE_FEED = "\n";
const CARRIAGE_RETURN = "\r";
const kittyBefore = isKittyProtocolActive();

afterEach(() => {
	setKittyProtocolActive(kittyBefore);
});

const key = (id: string) => id as unknown as KeyId;

describe("a bare LF with the Kitty protocol active", () => {
	/** The regression: this returned `enter`, so nothing bound to Shift+Enter fired. */
	it("parses as shift+enter", () => {
		setKittyProtocolActive(true);

		expect(parseKey(LINE_FEED)).toBe("shift+enter");
	});

	/** Keybindings are matched, not parsed, so the matcher is asserted separately from the parser. */
	it("matches a shift+enter binding", () => {
		setKittyProtocolActive(true);

		expect(matchesKey(LINE_FEED, key("shift+enter"))).toBe(true);
	});

	/**
	 * The alias comes for free only because the translation defers to the native matcher instead of
	 * answering itself. If someone later replaces the rewrite with a hardcoded `"shift+enter"` string,
	 * this is the test that fails.
	 */
	it("matches the shift+return alias too", () => {
		setKittyProtocolActive(true);

		expect(matchesKey(LINE_FEED, key("shift+return"))).toBe(true);
	});

	/** And it is no longer plain Enter, which is the half of the distinction that submits a message. */
	it("does not match a plain enter binding", () => {
		setKittyProtocolActive(true);

		expect(matchesKey(LINE_FEED, key("enter"))).toBe(false);
		expect(matchesKey(LINE_FEED, key("return"))).toBe(false);
	});
});

describe("a bare LF without the Kitty protocol", () => {
	/**
	 * Legacy terminals send LF for plain Enter, so translating unconditionally would break Enter for
	 * every terminal that never negotiated the protocol -- a far worse bug than the one being fixed.
	 */
	it("stays plain enter", () => {
		setKittyProtocolActive(false);

		expect(parseKey(LINE_FEED)).toBe("enter");
		expect(matchesKey(LINE_FEED, key("enter"))).toBe(true);
		expect(matchesKey(LINE_FEED, key("shift+enter"))).toBe(false);
	});
});

describe("inputs the translation must leave alone", () => {
	/** CR is plain Enter in both modes. Rewriting it would submit nothing and insert a newline instead. */
	it("does not touch a carriage return in either mode", () => {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);

			expect(parseKey(CARRIAGE_RETURN)).toBe("enter");
			expect(matchesKey(CARRIAGE_RETURN, key("shift+enter"))).toBe(false);
		}
	});

	/** Ctrl+J is the same byte as LF in legacy encoding but arrives as its own CSI-u sequence under Kitty. */
	it("does not touch the Kitty sequence for ctrl+j", () => {
		setKittyProtocolActive(true);

		expect(parseKey("\x1b[106;5u")).toBe("ctrl+j");
	});

	/**
	 * Only a LONE LF is ambiguous. Multi-byte input containing LF is a paste body or a modified Enter
	 * sequence, and rewriting any of it would replace real content with a keypress.
	 */
	it("does not touch multi-byte input that contains a line feed", () => {
		setKittyProtocolActive(true);

		expect(parseKey("a\n")).not.toBe("shift+enter");
		expect(parseKey("\n\n")).not.toBe("shift+enter");
		expect(matchesKey(`\x1b[200~line one\nline two\x1b[201~`, key("shift+enter"))).toBe(false);
	});

	/** The neighbouring control bytes keep their own meanings; the rewrite is one byte wide. */
	it("does not touch the control bytes on either side of LF", () => {
		setKittyProtocolActive(true);

		expect(parseKey("\x09")).toBe("tab");
		expect(parseKey("\x0b")).toBe(parseKey("\x0b"));
		expect(matchesKey("\x09", key("shift+enter"))).toBe(false);
		expect(matchesKey("\x0b", key("shift+enter"))).toBe(false);
	});
});

describe("the memo and the translation together", () => {
	/**
	 * The answer is memoized, and the memo keys on the protocol mode, so flipping the mode has to flip
	 * the answer for the SAME byte. A memo that dropped the mode would freeze whichever meaning arrived
	 * first, which for a terminal that enables Kitty after the first keypress means Enter never submits.
	 */
	it("flips the answer when the protocol mode flips", () => {
		setKittyProtocolActive(false);
		expect(parseKey(LINE_FEED)).toBe("enter");

		setKittyProtocolActive(true);
		expect(parseKey(LINE_FEED)).toBe("shift+enter");

		setKittyProtocolActive(false);
		expect(parseKey(LINE_FEED)).toBe("enter");
	});

	/** Same for the matcher, which caches under its own key. */
	it("flips the matcher's answer when the protocol mode flips", () => {
		setKittyProtocolActive(false);
		expect(matchesKey(LINE_FEED, key("enter"))).toBe(true);

		setKittyProtocolActive(true);
		expect(matchesKey(LINE_FEED, key("enter"))).toBe(false);
		expect(matchesKey(LINE_FEED, key("shift+enter"))).toBe(true);
	});
});
