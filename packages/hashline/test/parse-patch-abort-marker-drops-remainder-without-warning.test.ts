/**
 * `*** Abort` ends parsing like `*** End Patch`, without a warning.
 *
 * WHY THIS SUITE EXISTS. The abort marker is the truncation sentinel an
 * agent loop emits mid-call. Everything after it is untrusted remainder
 * (a half-emitted hunk, a second file the model did not mean to send).
 * Treating it as `END_PATCH` without a warning is load-bearing: a warning
 * would look like an authored-input problem and the model would retry the
 * truncated patch. `*** Abort extra` (trailing non-space) is NOT the
 * marker — `markerLineEquals` requires the trimmed line to be exactly the
 * marker — so it must not silently drop the rest of a real patch.
 */
import { describe, expect, it } from "bun:test";
import { ABORT_MARKER, END_PATCH_MARKER } from "../src/messages";
import { parsePatch } from "../src/parser";

describe("*** Abort terminates the patch and keeps already-parsed edits", () => {
	it("keeps the SWAP above the abort and drops the DEL below it", () => {
		const parsed = parsePatch("SWAP 1.=1:\n+A\n*** Abort\nDEL 2\n");
		// SWAP lowers to a replacement insert + a delete of line 1. The DEL 2
		// below the abort must not appear as a second delete.
		expect(parsed.edits.filter(e => e.kind === "delete").map(e => (e.kind === "delete" ? e.anchor.line : 0))).toEqual([1]);
		expect(parsed.edits.filter(e => e.kind === "insert")).toHaveLength(1);
		expect(parsed.warnings).toEqual([]);
	});

	it("does not emit a warning, unlike a malformed hunk", () => {
		const parsed = parsePatch("INS.HEAD:\n+x\n*** Abort\nthis is garbage SWAP 1.=1:\n+nope");
		expect(parsed.warnings).toEqual([]);
		expect(parsed.edits).toHaveLength(1);
	});

	it("trailing spaces on the abort line still match (trimEnd)", () => {
		const parsed = parsePatch(`INS.HEAD:\n+x\n${ABORT_MARKER}   \nDEL 1\n`);
		expect(parsed.edits).toHaveLength(1);
		expect(parsed.edits.some(e => e.kind === "delete")).toBe(false);
	});

	it("*** Abort extra is not the marker, so a later DEL still parses", () => {
		const parsed = parsePatch("INS.HEAD:\n+x\n*** Abort extra\nDEL 1\n");
		expect(parsed.edits.some(e => e.kind === "delete")).toBe(true);
	});
});

describe("*** End Patch also terminates, and is a different marker", () => {
	it("drops remainder after End Patch", () => {
		const parsed = parsePatch(`INS.HEAD:\n+x\n${END_PATCH_MARKER}\nDEL 1\n`);
		expect(parsed.edits.some(e => e.kind === "delete")).toBe(false);
		expect(parsed.edits).toHaveLength(1);
	});

	it("Abort and End Patch are not equal strings", () => {
		expect(ABORT_MARKER).toBe("*** Abort");
		expect(END_PATCH_MARKER).toBe("*** End Patch");
		expect(ABORT_MARKER).not.toBe(END_PATCH_MARKER);
	});
});
