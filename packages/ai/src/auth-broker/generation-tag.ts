/**
 * The snapshot generation as it travels in an HTTP entity tag.
 *
 * The broker's snapshot endpoint is a conditional resource: the server answers
 * with `ETag: "<generation>"`, the client asks again with
 * `If-None-Match: "<generation>"`, and a matching generation is a 304 with no
 * body. Both sides therefore both WRITE and READ the format, and both had a
 * private copy of the parser plus their own inline copy of the quoting.
 *
 * A disagreement there costs quietly rather than loudly. A client tag the server
 * cannot parse reads as no condition at all, so every long poll returns a full
 * snapshot the client already had; a server tag the client cannot parse leaves
 * the client's generation where it was, so it re-asks for the same snapshot
 * forever. Neither path errors, and the only symptom is traffic. Keeping both
 * directions in one module is what makes the format a contract instead of a
 * coincidence.
 */

/**
 * Render a generation as the entity tag the snapshot endpoint sends.
 *
 * A strong tag (no `W/`), because it identifies an exact snapshot: two responses
 * with the same generation are byte-identical.
 */
export function formatGenerationTag(generation: number): string {
	return `"${generation}"`;
}

/**
 * Read a generation out of an `ETag` or `If-None-Match` header, or undefined when
 * the header carries no usable one.
 *
 * The quotes are part of the header syntax and are stripped, and a `W/` weak
 * prefix is tolerated because an intermediary may add one: refusing it would turn
 * a still-fresh snapshot into a full re-download. Anything that is not a
 * non-negative integer, including a `*`, a multi-tag list, or a float, is
 * undefined rather than an error: the header is a hint about a cache, and the
 * caller's fallback is to send the snapshot in full, which is always correct.
 */
export function parseGenerationTag(header: string | null): number | undefined {
	if (!header) return undefined;
	let value = header.trim();
	if (value.startsWith("W/")) value = value.slice(2).trim();
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		value = value.slice(1, -1);
	}
	// `Number("")` and `Number(" ")` are both 0, so an empty tag (`If-None-Match: ""`,
	// or a header that arrived as whitespace) would otherwise read as generation 0 and
	// answer 304 to a client that holds no snapshot at all. Both private copies of this
	// parser had that hole.
	if (value.trim().length === 0) return undefined;
	const generation = Number(value);
	if (!Number.isInteger(generation) || generation < 0) return undefined;
	return generation;
}
