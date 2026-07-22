import { describe, expect, it } from "bun:test";
import {
	overlayTitleSlotContent,
	overlayTitleSlotPrefix,
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	serializeTitleSlot,
	titleUpdateFromSlot,
} from "@veyyon/coding-agent/session/session-title-slot";

/**
 * The session title lives in a fixed-width 256-byte first-line "slot" so a title can be
 * rewritten in place without rewriting the whole session file. serializeTitleSlot is
 * exercised indirectly by the storage backends, but the parse/round-trip/overlay side had
 * no direct test. This suite locks the contract the storage layer depends on:
 *   - serializeTitleSlot always emits exactly 256 UTF-8 bytes including the trailing
 *     newline, and parseTitleSlotLine reads the title/source/updatedAt back;
 *   - an over-long title is truncated (by code point, via binary search) to still fit the
 *     slot rather than overflowing it;
 *   - parseTitleSlotLine is strict: a legacy/other entry type, a wrong version, an invalid
 *     source, a missing field, or non-JSON all yield undefined (so a legacy header is
 *     never mistaken for a title);
 *   - parseTitleSlotFromContent reads only the first physical line;
 *   - overlayTitleSlotContent replaces the slot while preserving the body after it.
 */

const UPDATED_AT = "2026-07-22T00:00:00Z";

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

describe("serializeTitleSlot / parseTitleSlotLine round-trip", () => {
	it("emits exactly 256 bytes with a trailing newline and reads the fields back", () => {
		const line = serializeTitleSlot({ title: "My Session", source: "user", updatedAt: UPDATED_AT });
		expect(byteLength(line)).toBe(256);
		expect(line.endsWith("\n")).toBe(true);

		const slot = parseTitleSlotLine(line);
		expect(slot?.title).toBe("My Session");
		expect(slot?.source).toBe("user");
		expect(slot?.updatedAt).toBe(UPDATED_AT);
	});

	it("omits the source key entirely when no source is given", () => {
		const slot = parseTitleSlotLine(serializeTitleSlot({ title: "T2", updatedAt: UPDATED_AT }));
		expect(slot?.source).toBeUndefined();
		expect(slot && "source" in slot).toBe(false);
	});

	it("truncates an over-long title to keep the slot at 256 bytes", () => {
		const line = serializeTitleSlot({ title: "x".repeat(1000), source: "auto", updatedAt: UPDATED_AT });
		expect(byteLength(line)).toBe(256);
		// The 1000-char title is trimmed to the 162 code points that fit the slot
		// alongside the JSON envelope, source, and timestamp.
		expect(parseTitleSlotLine(line)?.title.length).toBe(162);
	});

	it("maps a parsed slot to the semantic title update shape", () => {
		const slot = parseTitleSlotLine(
			serializeTitleSlot({ title: "My Session", source: "user", updatedAt: UPDATED_AT }),
		);
		expect(titleUpdateFromSlot(slot)).toEqual({ title: "My Session", source: "user", updatedAt: UPDATED_AT });
		expect(titleUpdateFromSlot(undefined)).toBeUndefined();
	});
});

describe("parseTitleSlotLine rejects non-title lines", () => {
	it("returns undefined for a legacy header, wrong version, bad source, missing field, or non-JSON", () => {
		expect(parseTitleSlotLine('{"type":"session","v":1}')).toBeUndefined();
		expect(parseTitleSlotLine('{"type":"title","v":2,"title":"x","updatedAt":"a","pad":""}')).toBeUndefined();
		expect(
			parseTitleSlotLine('{"type":"title","v":1,"title":"x","updatedAt":"a","pad":"","source":"robot"}'),
		).toBeUndefined();
		expect(parseTitleSlotLine('{"type":"title","v":1,"title":"x","updatedAt":"a"}')).toBeUndefined();
		expect(parseTitleSlotLine("nonsense")).toBeUndefined();
	});
});

describe("parseTitleSlotFromContent / overlayTitleSlotContent", () => {
	it("reads only the first physical line, and returns undefined without a newline", () => {
		const line = serializeTitleSlot({ title: "My Session", source: "user", updatedAt: UPDATED_AT });
		expect(parseTitleSlotFromContent(`${line}some body\nmore`)?.title).toBe("My Session");
		expect(parseTitleSlotFromContent("nonewline")).toBeUndefined();
	});

	it("replaces the slot while preserving the body after it", () => {
		const overlaid = overlayTitleSlotContent(`${"OLD".repeat(200)}\nTAIL`, {
			title: "New",
			source: "user",
			updatedAt: UPDATED_AT,
		});
		expect(parseTitleSlotFromContent(overlaid)?.title).toBe("New");
		expect(overlaid.includes("TAIL")).toBe(true);
	});
});

/**
 * overlayTitleSlotPrefix rewrites the title slot inside a fixed prefix byte window (used when a
 * storage backend holds only the head bytes of a session file, not the whole thing). It had no
 * direct test. The byte accounting is easy to get wrong: a non-positive window must yield "", a
 * window shorter than the 256-byte slot must return exactly that many bytes OF the slot (never the
 * old body), and a larger window must return the fresh slot followed by the old body tail, capped to
 * the window. These pin each of those three regimes.
 */
describe("overlayTitleSlotPrefix", () => {
	function slotBytes(update: { title?: string; source?: "auto" | "user"; updatedAt: string }): Buffer {
		return Buffer.from(serializeTitleSlot(update), "utf-8");
	}

	it("returns an empty string for a non-positive prefix window", () => {
		expect(overlayTitleSlotPrefix("anything at all", 0, { title: "X", updatedAt: UPDATED_AT })).toBe("");
		expect(overlayTitleSlotPrefix("anything at all", -5, { title: "X", updatedAt: UPDATED_AT })).toBe("");
	});

	it("returns exactly the first N bytes of the fresh slot when the window is within the slot", () => {
		const update = { title: "Hello", source: "user" as const, updatedAt: UPDATED_AT };
		const out = overlayTitleSlotPrefix("original body that is ignored", 50, update);
		expect(byteLength(out)).toBe(50);
		expect(out).toBe(slotBytes(update).subarray(0, 50).toString("utf-8"));
	});

	it("returns the fresh slot then the old body tail, capped to the window, when the window exceeds the slot", () => {
		const oldSlot = serializeTitleSlot({ title: "Old", source: "auto", updatedAt: UPDATED_AT });
		const body = `${oldSlot}BODYTAILCONTENT-MORE-STUFF`;
		const update = { title: "New", source: "auto" as const, updatedAt: UPDATED_AT };
		const out = overlayTitleSlotPrefix(body, 256 + 10, update);

		expect(byteLength(out)).toBe(266);
		expect(out.startsWith(serializeTitleSlot(update))).toBe(true);
		// The 10 trailing bytes come from the original body immediately after the slot.
		expect(out.slice(256)).toBe("BODYTAILCO");
		// And the rewritten slot still parses back to the new title.
		expect(parseTitleSlotFromContent(out)?.title).toBe("New");
	});
});
