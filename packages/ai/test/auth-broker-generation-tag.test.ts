/**
 * The snapshot generation as it travels in an entity tag, written and read by both ends.
 *
 * WHY THIS SUITE EXISTS. `/v1/snapshot` is a conditional resource: the server answers
 * `ETag: "<generation>"`, the client re-asks with `If-None-Match: "<generation>"`, and a
 * match is a 304 with no body. Both sides write the header and both sides parse it, and
 * each had its OWN copy of the parser next to its own inline copy of the quoting, so one
 * format had four independent statements.
 *
 * Every way that can break is quiet. A client tag the server cannot parse reads as no
 * condition at all, so a long poll that should have returned 304 returns the whole
 * snapshot the client already holds. A server tag the client cannot parse leaves the
 * client's generation where it was, so it asks for the same snapshot again on every
 * refresh. Nothing throws, nothing logs, and the only symptom is traffic that grows with
 * the number of machines.
 *
 * So the format is pinned in both directions here: the exact header bytes the server
 * emits, the round trip between the two functions, the tolerances a real intermediary
 * forces (a `W/` prefix), and the inputs that must read as "no generation" rather than as
 * a wrong one.
 */

import { describe, expect, it } from "bun:test";
import { formatGenerationTag, parseGenerationTag } from "../src/auth-broker/generation-tag";

describe("writing the tag", () => {
	/**
	 * The literal header bytes, asserted rather than round-tripped. A round trip passes
	 * even if both sides drop the quotes, which would make the header invalid to any
	 * intermediary that parses it while still working between our two ends.
	 */
	it("is the generation in double quotes, with no weak prefix", () => {
		expect(formatGenerationTag(0)).toBe('"0"');
		expect(formatGenerationTag(41)).toBe('"41"');
		expect(formatGenerationTag(9_007_199_254_740_991)).toBe('"9007199254740991"');
	});

	/**
	 * A strong tag is the honest one: the generation identifies an exact snapshot, so two
	 * responses carrying the same one are byte-identical. Marking it weak would invite a
	 * cache to serve a semantically-equivalent-but-different body.
	 */
	it("is a strong tag", () => {
		expect(formatGenerationTag(7).startsWith("W/")).toBe(false);
	});
});

describe("reading the tag", () => {
	it("reads back what the writer wrote, for every generation", () => {
		for (const generation of [0, 1, 42, 1_000_000, 9_007_199_254_740_991]) {
			expect(parseGenerationTag(formatGenerationTag(generation))).toBe(generation);
		}
	});

	it("accepts an unquoted value, which a hand-written client or a test double will send", () => {
		expect(parseGenerationTag("42")).toBe(42);
	});

	/**
	 * A proxy may downgrade a strong tag to a weak one. Refusing that would turn a
	 * still-fresh snapshot into a full re-download on every poll through that proxy, which
	 * is the exact cost this header exists to avoid.
	 */
	it("tolerates a weak prefix an intermediary added, with or without a space", () => {
		expect(parseGenerationTag('W/"42"')).toBe(42);
		expect(parseGenerationTag('W/ "42"')).toBe(42);
	});

	it("ignores surrounding whitespace, which header joining introduces", () => {
		expect(parseGenerationTag('  "42"  ')).toBe(42);
	});

	/** Generation 0 is the first snapshot, not a missing one: it must not be confused with undefined. */
	it("reads generation zero as zero", () => {
		expect(parseGenerationTag('"0"')).toBe(0);
		expect(parseGenerationTag('"0"')).not.toBeUndefined();
	});
});

describe("headers that carry no usable generation", () => {
	/**
	 * Undefined means "no condition", and the caller's fallback is to send the snapshot in
	 * full, which is always correct. The alternative, guessing a number out of a header we
	 * do not understand, would answer 304 to a client that is missing data.
	 */
	it("answers undefined for an absent or empty header", () => {
		expect(parseGenerationTag(null)).toBeUndefined();
		expect(parseGenerationTag("")).toBeUndefined();
		expect(parseGenerationTag("   ")).toBeUndefined();
	});

	/**
	 * `*` is legal in `If-None-Match` and means "any current representation". It is not a
	 * generation, and reading it as one is how it would become `NaN` and then, without the
	 * integer check, an accidental match.
	 */
	it("answers undefined for the wildcard", () => {
		expect(parseGenerationTag("*")).toBeUndefined();
	});

	/**
	 * A multi-tag list is legal too. Taking the first entry would be a guess about which
	 * one the client meant, so the whole header reads as no condition.
	 */
	it("answers undefined for a list of tags", () => {
		expect(parseGenerationTag('"41", "42"')).toBeUndefined();
	});

	it("answers undefined for a non-numeric tag from another server", () => {
		expect(parseGenerationTag('"abc123"')).toBeUndefined();
		expect(parseGenerationTag('"686897696a7c876b7e"')).toBeUndefined();
	});

	/**
	 * Generations are whole and counted upward. A float or a negative cannot have been
	 * emitted by the server, so it comes from a confused client, and treating `1.5` as 1
	 * would answer 304 for a snapshot the client never saw.
	 */
	it("answers undefined for a float or a negative generation", () => {
		expect(parseGenerationTag('"1.5"')).toBeUndefined();
		expect(parseGenerationTag('"-1"')).toBeUndefined();
	});

	/**
	 * `Number("")` is 0, and `Number(" ")` is 0 as well: an empty quoted tag would parse as
	 * generation 0 and match the very first snapshot. This is the case the emptiness guard
	 * has to catch, and it looks like a redundant check next to the integer test.
	 */
	it("answers undefined for an empty quoted tag rather than reading it as generation zero", () => {
		expect(parseGenerationTag('""')).toBeUndefined();
		expect(parseGenerationTag('"   "')).toBeUndefined();
	});

	it("answers undefined for a value that is not finite", () => {
		expect(parseGenerationTag('"Infinity"')).toBeUndefined();
		expect(parseGenerationTag('"NaN"')).toBeUndefined();
	});
});

describe("the two ends of the exchange", () => {
	/**
	 * The lock. The client and the server each had a private parser and their own inline
	 * quoting, and both sides both write and read this header, so a copy is a chance for
	 * the two to disagree about the same string.
	 */
	it("share one module rather than restating the format", async () => {
		const owner = await Bun.file(new URL("../src/auth-broker/generation-tag.ts", import.meta.url)).text();
		expect(owner.match(/export function parseGenerationTag/g)).toHaveLength(1);
		expect(owner.match(/export function formatGenerationTag/g)).toHaveLength(1);

		for (const name of ["client.ts", "server.ts"]) {
			const source = await Bun.file(new URL(`../src/auth-broker/${name}`, import.meta.url)).text();

			expect(source).not.toContain("function parseGenerationTag(");
			expect(source).toContain('from "./generation-tag"');
			// And neither side spells the quoting inline any more. The searched text contains a
			// template interpolation, so it is built with an escaped brace: a PLAIN string holding
			// `${...}` is what `noTemplateCurlyInString` exists to catch, since a string that looks
			// interpolated and is not is almost always a bug, and this is the rare case where the
			// un-interpolated form is the point.
			expect(source).not.toContain(`= \`"$\{opts.ifGenerationGt}"\``);
			expect(source).not.toContain(`ETag: \`"$\{generation}"\``);
		}
	});
});
