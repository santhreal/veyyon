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
