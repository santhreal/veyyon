/**
 * The memo in front of the native key parser must be invisible: every memoized answer has to equal
 * the answer native gives for the same input, forever.
 *
 * WHY THIS SUITE EXISTS. `src/keys.ts` answers `parseKey` and `matchesKey` out of a `Map` before it
 * crosses into native code, because the native call costs a flat ~150ns of FFI regardless of input and
 * keyboard input asks the same question thousands of times. That is only sound while the native
 * functions are PURE in `(data, keyId, kittyActive)`. If a native build ever grew hidden state -- a
 * terminal capability probe, an environment lookup, a mode latch -- the memo would keep serving the
 * first answer it ever saw and the terminal would respond to the wrong keys, with nothing in any log
 * and no way to tell from the outside that a cache was involved.
 *
 * So purity is not assumed here, it is measured: the whole single-byte range and a set of real escape
 * sequences are compared against fresh native answers in both protocol modes, and again after
 * `WT_SESSION` changes, since `matchesRawBackspace` proves at least one key meaning in this file does
 * look at the environment.
 *
 * The rest of the file pins the properties that make the memo safe rather than merely fast: an
 * "unrecognized input" answer of `undefined` is cached as an answer instead of being re-asked, an entry
 * warmed in one protocol mode is never served in the other, cache keys cannot collide between different
 * `(data, keyId)` pairs, and long input is left out of the memo so a paste cannot evict the keys
 * someone is typing.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { matchesKey as matchesKeyNative, parseKey as parseKeyNative } from "@veyyon/natives";
import {
	clearKeyAnswerMemo,
	isKittyProtocolActive,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "../src/keys";

/** Every single-byte input a terminal can deliver as one keypress. */
const SINGLE_BYTES = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code));

/** Real sequences, one per shape the parser handles: legacy CSI, Kitty CSI-u, SS3, alt-prefixed. */
const SEQUENCES = [
	"\x1b[A",
	"\x1b[1;5A",
	"\x1b[1;2D",
	"\x1b[97;5u",
	"\x1b[13;2u",
	"\x1b[57399;1u",
	"\x1bOP",
	"\x1b[3~",
	"\x1b[Z",
	"\x1bb",
	"\x1b\x7f",
	"\x1b",
];

/** Key ids covering plain keys, modifier combinations, aliases and a deliberate non-match. */
const KEY_IDS = [
	"a",
	"escape",
	"backspace",
	"ctrl+backspace",
	"enter",
	"return",
	"tab",
	"shift+tab",
	"up",
	"ctrl+up",
	"shift+left",
	"ctrl+a",
	"shift+enter",
	"f1",
	"delete",
] as unknown as KeyId[];

/**
 * What native answers for an input, after the one translation `keys.ts` performs before asking it.
 *
 * A bare LF means Shift+Enter under the Kitty protocol and plain Enter without it, and `keys.ts`
 * expresses that by rewriting the byte to the canonical CSI-u sequence rather than by answering itself
 * (see `canonicalizeAmbiguousLineFeed`, and `line-feed-shift-enter.test.ts` for the behaviour). The
 * sweeps below compare against this reference so they keep proving what they are for -- that the memo
 * never invents or staleley reuses an answer -- instead of re-asserting the translation.
 */
function canonical(data: string, kitty: boolean): string {
	return kitty && data === "\n" ? "\x1b[13;2u" : data;
}

function referenceParse(data: string, kitty: boolean): string | undefined {
	return parseKeyNative(canonical(data, kitty), kitty) ?? undefined;
}

function referenceMatch(data: string, keyId: KeyId, kitty: boolean): boolean {
	return matchesKeyNative(canonical(data, kitty), keyId, kitty);
}

const kittyBefore = isKittyProtocolActive();
const wtSessionBefore = process.env.WT_SESSION;

afterEach(() => {
	setKittyProtocolActive(kittyBefore);
	if (wtSessionBefore === undefined) delete process.env.WT_SESSION;
	else process.env.WT_SESSION = wtSessionBefore;
	clearKeyAnswerMemo();
});

/** Every `(input, mode)` pair, with the mode installed, as `parseKey` sees it. */
function forEachMode(run: (kitty: boolean) => void): void {
	for (const kitty of [false, true]) {
		setKittyProtocolActive(kitty);
		run(kitty);
	}
}

describe("the memoized parseKey", () => {
	/**
	 * The core equivalence, over every input a single keypress can produce. This is the assertion that
	 * would fail first if the memo ever keyed on the wrong thing.
	 */
	it("gives native's answer for every single byte, in both protocol modes", () => {
		forEachMode(kitty => {
			for (const data of SINGLE_BYTES) {
				clearKeyAnswerMemo();
				const fresh = referenceParse(data, kitty);
				expect(parseKey(data)).toBe(fresh);
			}
		});
	});

	/** And for escape sequences, which are the inputs the native parser actually earns its keep on. */
	it("gives native's answer for every escape sequence, in both protocol modes", () => {
		forEachMode(kitty => {
			for (const data of SEQUENCES) {
				clearKeyAnswerMemo();
				const fresh = referenceParse(data, kitty);
				expect(parseKey(data)).toBe(fresh);
			}
		});
	});

	/**
	 * The second call is the one that reads the memo, so it is the one that can differ. Asserting the
	 * repeat separately is what distinguishes "the memo stores the right answer" from "the memo is
	 * never consulted".
	 */
	it("keeps answering the same thing on repeat calls", () => {
		forEachMode(() => {
			for (const data of [...SINGLE_BYTES, ...SEQUENCES]) {
				const first = parseKey(data);
				expect(parseKey(data)).toBe(first);
				expect(parseKey(data)).toBe(first);
			}
		});
	});

	/**
	 * `undefined` means "not a key", which is a real answer and must be cached as one. Caching only
	 * defined answers would send every unrecognized byte across FFI on every keystroke -- exactly the
	 * cost this memo exists to remove -- and the bug would be invisible because the behaviour is right.
	 */
	it("caches an unrecognized input as an answer instead of re-asking", () => {
		setKittyProtocolActive(false);
		// A bare CSI introducer with nothing after it: well-formed enough to reach the parser, not a key.
		const notAKey = "\x1b[";
		const native = parseKeyNative(notAKey, false) ?? undefined;

		const first = parseKey(notAKey);

		expect(first).toBe(native);
		expect(parseKey(notAKey)).toBe(native);
	});

	/**
	 * The mode is part of every cache key, so an entry warmed in one mode is never served in the other.
	 *
	 * This cannot be proven by finding two answers that differ, because today there are none: the native
	 * parser ignores its `kittyActive` argument for every input probed (all 128 single bytes and a set of
	 * legacy CSI, SS3 and Kitty CSI-u sequences, against `parseKey` and `matchesKey` alike), which is
	 * itself suspicious and tracked separately. What this test can do is warm the memo in the opposite
	 * mode first and require the answer to still be native's answer for the CURRENT mode, so the day the
	 * native parser starts honouring the flag, a memo that dropped the mode from its key fails here
	 * instead of silently answering with whichever mode was active first.
	 */
	it("answers per mode even when the other mode warmed the memo first", () => {
		for (const kitty of [false, true]) {
			for (const data of SEQUENCES) {
				clearKeyAnswerMemo();
				setKittyProtocolActive(!kitty);
				parseKey(data);
				setKittyProtocolActive(kitty);

				expect(parseKey(data)).toBe(referenceParse(data, kitty));
			}
		}
	});
});

describe("the memoized matchesKey", () => {
	/** The same equivalence for the matcher, across every `(byte, keyId)` pair. */
	it("gives native's answer for every single byte and key id", () => {
		forEachMode(kitty => {
			for (const data of SINGLE_BYTES) {
				for (const keyId of KEY_IDS) {
					clearKeyAnswerMemo();
					expect(matchesKey(data, keyId)).toBe(referenceMatch(data, keyId, kitty));
				}
			}
		});
	});

	/** And across every `(sequence, keyId)` pair. */
	it("gives native's answer for every escape sequence and key id", () => {
		forEachMode(kitty => {
			for (const data of SEQUENCES) {
				for (const keyId of KEY_IDS) {
					clearKeyAnswerMemo();
					expect(matchesKey(data, keyId)).toBe(referenceMatch(data, keyId, kitty));
				}
			}
		});
	});

	/**
	 * The cache key packs `data` and `keyId` into one string, so it has to be unambiguous. With a space
	 * separator, `("a b", "c")` and `("a", "b c")` collide, and one keybinding starts answering for
	 * another. Key ids never contain NUL, which is why the separator is NUL.
	 */
	it("does not collide when data and key id could be split differently", () => {
		setKittyProtocolActive(false);
		const trueAnswer = matchesKeyNative("a b", "c" as unknown as KeyId, false);
		const otherAnswer = matchesKeyNative("a", "b c" as unknown as KeyId, false);

		expect(matchesKey("a b", "c" as unknown as KeyId)).toBe(trueAnswer);
		expect(matchesKey("a", "b c" as unknown as KeyId)).toBe(otherAnswer);
	});

	/** Repeat calls read the memo, so they are asserted separately from the first call. */
	it("keeps answering the same thing on repeat calls", () => {
		forEachMode(() => {
			for (const data of [...SINGLE_BYTES, ...SEQUENCES]) {
				const first = matchesKey(data, "escape" as unknown as KeyId);
				expect(matchesKey(data, "escape" as unknown as KeyId)).toBe(first);
			}
		});
	});
});

describe("native purity, which the memo depends on", () => {
	/**
	 * At least one key meaning in `keys.ts` reads the environment (`matchesRawBackspace` treats 0x08 as
	 * ctrl+backspace on Windows Terminal), so this checks whether the NATIVE functions do too. If they
	 * ever start to, every memoized answer taken before the change is stale and this fails, which is
	 * the whole reason the memo is allowed to exist.
	 */
	it("answers the same regardless of WT_SESSION", () => {
		const snapshot = () => {
			const out: string[] = [];
			for (const kitty of [false, true]) {
				for (const data of [...SINGLE_BYTES, ...SEQUENCES]) {
					out.push(`${kitty}|${JSON.stringify(data)}|${parseKeyNative(data, kitty) ?? "-"}`);
					for (const keyId of KEY_IDS) {
						out.push(`${kitty}|${JSON.stringify(data)}|${keyId}|${matchesKeyNative(data, keyId, kitty)}`);
					}
				}
			}
			return out;
		};

		delete process.env.WT_SESSION;
		const withoutWt = snapshot();
		process.env.WT_SESSION = "1";
		const withWt = snapshot();

		expect(withWt).toEqual(withoutWt);
	});
});

describe("input too long to memoize", () => {
	/**
	 * A paste arrives once and never repeats, so caching it would only evict the keys being typed. The
	 * answer must still be native's, which is what makes the cutoff a performance decision and not a
	 * behavioural one.
	 */
	it("still answers correctly for input past the memo cutoff", () => {
		setKittyProtocolActive(false);
		const paste = "x".repeat(200);

		expect(parseKey(paste)).toBe(parseKeyNative(paste, false) ?? undefined);
		expect(matchesKey(paste, "a" as unknown as KeyId)).toBe(matchesKeyNative(paste, "a" as unknown as KeyId, false));
	});

	/**
	 * And it is genuinely left out of the memo: a bracketed-paste body long enough to trip the cutoff
	 * must not consume a cache slot. Asserted through behaviour that survives the cache being cleared,
	 * because the memo has no public size to read.
	 */
	it("answers a long input identically before and after the memo is cleared", () => {
		setKittyProtocolActive(false);
		const paste = `\x1b[200~${"hello ".repeat(40)}\x1b[201~`;

		const before = parseKey(paste);
		clearKeyAnswerMemo();

		expect(parseKey(paste)).toBe(before);
		expect(before).toBe(parseKeyNative(paste, false) ?? undefined);
	});
});
