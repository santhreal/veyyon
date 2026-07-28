/**
 * Number of Unicode code points in `value`.
 *
 * This is the ONE owner of code-point counting. `value.length` counts UTF-16
 * code units, so an astral character (an emoji, a rare CJK ideograph) counts as
 * two even though it is a single code point. Anything that measures "characters"
 * the way a person or a spec does (JSON Schema `minLength`/`maxLength`, for
 * instance, which are defined in code points) must count this way, not with
 * `.length`, or it double-counts astral characters and rejects strings it
 * should accept. `for...of` over a string iterates code points, so this counts
 * them without allocating an array.
 */
export function codePointLength(value: string): number {
	let count = 0;
	for (const _ of value) count += 1;
	return count;
}

/**
 * Number of UTF-8 bytes `value` encodes to, optionally over a code-unit slice.
 *
 * This is the size a string takes on the wire, which is what a byte budget is
 * about: a limit on what a request may send, or on what one transformation may
 * accept. It is not `value.length` (code units) and not `codePointLength`
 * (characters), and the three disagree by up to a factor of four on the same
 * text, so a budget written against the wrong one is off by that factor.
 *
 * `start` and `end` are CODE-UNIT indices, matching `slice`, so a caller that
 * has already located a span can measure it without allocating the substring.
 * That is the reason for the range rather than a convenience: the callers that
 * need it are counting the bytes a replacement adds or removes inside a string
 * they are rewriting, once per match, on text that can be megabytes.
 *
 * A LONE SURROGATE COUNTS AS THREE BYTES, which is what `TextEncoder` does with
 * it: it encodes the replacement character. Measuring it as anything else would
 * make the count disagree with the encoder for exactly the ill-formed input a
 * byte limit is guarding against. Pair it with {@link isWellFormedUtf16} when
 * the string must be rejected rather than measured.
 */
export function utf8ByteLength(value: string, start = 0, end = value.length): number {
	let bytes = 0;
	for (let index = start; index < end; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			bytes++;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < end) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * Whether every surrogate in `value` is part of a well-formed pair.
 *
 * A JavaScript string is a sequence of UTF-16 code units and NOTHING enforces
 * that they form valid text: `"\ud800"` is a perfectly ordinary string holding
 * half of a surrogate pair, and it survives every operation until something
 * tries to encode it. Then it becomes U+FFFD, silently, so a value that goes
 * out and comes back is not the value that left. Anything that has to hold a
 * round trip (a secret and its placeholder, a JSON payload rewritten on its way
 * to a provider) has to refuse the input instead of encoding a different string
 * than it was given.
 *
 * `String.prototype.isWellFormed` says the same thing and is not used here,
 * because this runs per string on payloads of arbitrary size and this loop
 * short-circuits on the first bad code unit without allocating.
 */
export function isWellFormedUtf16(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}
