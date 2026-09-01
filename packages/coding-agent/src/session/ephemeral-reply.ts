/**
 * Bounding a side-channel reply (`/btw`, `/omfg`) before it reaches the channel.
 */

/** Byte ceiling for one reply, counted in UTF-8 and inclusive of the truncation marker. */
const EPHEMERAL_REPLY_MAX_BYTES = 4096;

/** Marker replacing the tail of a reply that exceeds the byte ceiling. */
const TRUNCATION_SUFFIX = "\n[…truncated]";

/**
 * Collapse a degenerate reply to a bounded one.
 *
 * A model that loops on a line emits it without limit. A run longer than three
 * identical lines collapses to one instance plus `[…N×]`, and whatever remains
 * is capped at {@link EPHEMERAL_REPLY_MAX_BYTES}.
 */
export function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		// Trim one UTF-16 code unit at a time until the budget holds.
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		// A code unit is half a glyph outside the BMP, so the loop can stop on a
		// lone high surrogate. Left in place it encodes as U+FFFD, so drop it and
		// end on a whole glyph.
		const tail = result.charCodeAt(result.length - 1);
		if (tail >= 0xd800 && tail <= 0xdbff) result = result.slice(0, -1);
		result += TRUNCATION_SUFFIX;
	}
	return result;
}
