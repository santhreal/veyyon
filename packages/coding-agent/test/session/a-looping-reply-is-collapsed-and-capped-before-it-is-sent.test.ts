/**
 * WHY: a side-channel reply (`/btw`, `/omfg`) is whatever the model emitted, and
 * a model that loops on one line emits it without limit. `dedupeEphemeralReply`
 * is the only thing between that and the channel, so it has to hold two bounds
 * at once: a run of identical lines collapses, and the survivor fits a UTF-8
 * byte ceiling.
 *
 * The class this closes is the boundary, not the happy path. Both bounds are
 * off-by-one shaped — a run of exactly three is kept and four collapses, and the
 * cap counts UTF-8 bytes while the trim removes UTF-16 code units. That second
 * mismatch splits a glyph outside the BMP in half, and half a surrogate pair is
 * not text: it encodes as U+FFFD and the reply no longer round-trips. The whole
 * emoji parity space is swept rather than one example, because whether the trim
 * stops mid-pair depends on how many bytes precede the boundary.
 *
 * Not covered: who calls this and when. The caller's `dedupeReply === false`
 * opt-out lives in the session and is exercised where that decision is made.
 */

import { describe, expect, test } from "bun:test";
import { dedupeEphemeralReply } from "../../src/session/ephemeral-reply";

/** Mirrors the module's private ceiling; asserted against real output below. */
const MAX_BYTES = 4096;
const SUFFIX = "\n[…truncated]";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** A string round-trips only when every surrogate in it is half of a whole pair. */
const roundTrips = (value: string): boolean => Buffer.from(value, "utf8").toString("utf8") === value;

describe("collapsing a repeated run", () => {
	test("an empty reply is returned unchanged", () => {
		expect(dedupeEphemeralReply("")).toBe("");
	});

	test("a reply with no repetition is returned verbatim", () => {
		const text = "first\nsecond\nthird";
		expect(dedupeEphemeralReply(text)).toBe(text);
	});

	test("a run of three is kept in full", () => {
		expect(dedupeEphemeralReply("a\na\na")).toBe("a\na\na");
	});

	test("a run of four collapses to one line plus its count", () => {
		expect(dedupeEphemeralReply("a\na\na\na")).toBe("a\n[…4×]");
	});

	test("the count states the original run length, not the lines removed", () => {
		expect(dedupeEphemeralReply(`${"a\n".repeat(9)}a`)).toBe("a\n[…10×]");
	});

	test("each run collapses independently and surrounding lines survive", () => {
		const text = ["head", "a", "a", "a", "a", "mid", "b", "b", "b", "b", "b", "tail"].join("\n");
		expect(dedupeEphemeralReply(text)).toBe("head\na\n[…4×]\nmid\nb\n[…5×]\ntail");
	});

	test("duplicates that are not adjacent are not a run", () => {
		const text = "a\nb\na\nb\na\nb\na\nb";
		expect(dedupeEphemeralReply(text)).toBe(text);
	});

	test("a run of blank lines collapses like any other", () => {
		expect(dedupeEphemeralReply("x\n\n\n\n\ny")).toBe("x\n\n[…4×]\ny");
	});

	test("a run that reaches the end of the reply collapses", () => {
		expect(dedupeEphemeralReply("head\na\na\na\na")).toBe("head\na\n[…4×]");
	});
});

describe("capping the reply", () => {
	test("a reply under the ceiling keeps every byte and gains no marker", () => {
		const text = `${"x".repeat(MAX_BYTES - 1)}`;
		const out = dedupeEphemeralReply(text);
		expect(out).toBe(text);
		expect(out.endsWith(SUFFIX)).toBe(false);
	});

	test("a reply over the ceiling is truncated to within it and says so", () => {
		const out = dedupeEphemeralReply("x".repeat(MAX_BYTES * 3));
		expect(bytes(out)).toBeLessThanOrEqual(MAX_BYTES);
		expect(out.endsWith(SUFFIX)).toBe(true);
	});

	test("collapsing runs first can bring a huge reply under the ceiling untruncated", () => {
		// 50k bytes of one repeated line: the run collapses to two short lines,
		// so the cap never engages and no content is lost to truncation.
		const out = dedupeEphemeralReply("loop\n".repeat(10_000).trimEnd());
		expect(out).toBe("loop\n[…10000×]");
		expect(out.endsWith(SUFFIX)).toBe(false);
	});

	test("every multi-byte alignment truncates to a whole glyph within the ceiling", () => {
		// Which byte the trim stops on depends on how much precedes the boundary,
		// so sweep every offset modulo the 4-byte glyph rather than one sample.
		for (let pad = 0; pad < 8; pad++) {
			const out = dedupeEphemeralReply("x".repeat(pad) + "😀".repeat(2000));
			expect(bytes(out)).toBeLessThanOrEqual(MAX_BYTES);
			expect(out.endsWith(SUFFIX)).toBe(true);
			expect({ pad, roundTrips: roundTrips(out) }).toEqual({ pad, roundTrips: true });
		}
	});

	test("a truncated reply of astral glyphs ends on the marker, never a half pair", () => {
		const out = dedupeEphemeralReply(`xx${"😀".repeat(2000)}`);
		const body = out.slice(0, -SUFFIX.length);
		const last = body.charCodeAt(body.length - 1);
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		expect(out).not.toContain("\uFFFD");
	});

	test("a reply that is one glyph over the ceiling still fits after truncation", () => {
		const out = dedupeEphemeralReply("é".repeat(MAX_BYTES / 2 + 1));
		expect(bytes(out)).toBeLessThanOrEqual(MAX_BYTES);
		expect(roundTrips(out)).toBe(true);
	});
});
