/**
 * unseenLinesMessage: truncated reveals are not one remedy.
 *
 * WHY THIS SUITE EXISTS. A truncated inline reveal used to always name a
 * ranged re-read (`path:1-N`). That is the right command when the preview hit
 * the LINE-COUNT cap (`overCap`): the unread remainder is still showable by
 * range. It is the WRONG command when a line was clipped at the COLUMN cap
 * (`columnClipped`). The reader applies the same per-line column cap, so the
 * ranged re-read clips the same line again, the next edit is rejected the
 * same way, and nothing in the loop ever mentions `:raw`.
 *
 * The two flags are independent of `truncated` in the type, but the message
 * only consults them inside the `truncated` branch. A caller that sets
 * `columnClipped: true` without `truncated: true` is a wiring mistake that
 * currently falls through to the "straight retry" wording — pin that so a
 * future collapse of the flags is visible.
 *
 * Selector commas: `formatLineRanges` emits `", "` between runs; the message
 * then strips those spaces so the suggested read is `f.ts:1-2,9` not
 * `f.ts:1-2, 9`.
 */
import { describe, expect, it } from "bun:test";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";
import { unseenLinesMessage } from "../src/messages";

const TAG = "AB12";
const PATH = "wide.ts";

function headerFragment(path: string, tag: string): string {
	return `${HL_FILE_PREFIX}${path}${HL_FILE_HASH_SEP}${tag}${HL_FILE_SUFFIX}`;
}

describe("column-clipped truncated reveal names :raw, never a ranged remainder re-read", () => {
	it("a single clipped line points at path:N:raw", () => {
		const m = unseenLinesMessage(PATH, [4], TAG, {
			lines: [{ line: 4, text: "AAAA".repeat(200) }],
			truncated: true,
			columnClipped: true,
		});
		expect(m).toContain(`${PATH}:4:raw`);
		expect(m).not.toContain("remainder");
		expect(m).toContain("too wide");
		expect(m).toContain("column cap");
		expect(m).toContain(headerFragment(PATH, TAG));
	});

	it("a multi-line clipped set joins the selector without spaces after commas", () => {
		const m = unseenLinesMessage(PATH, [1, 2, 9], TAG, {
			lines: [
				{ line: 1, text: "one" },
				{ line: 2, text: "two" },
			],
			truncated: true,
			columnClipped: true,
		});
		expect(m).toContain(`${PATH}:1-2,9:raw`);
		expect(m).not.toContain(`${PATH}:1-2, 9`);
		expect(m).not.toContain("remainder");
	});

	it("columnClipped wins when overCap is also set — :raw is the only command that can succeed", () => {
		const m = unseenLinesMessage(PATH, [1, 2, 3, 4, 5, 6], TAG, {
			lines: [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			],
			truncated: true,
			overCap: true,
			columnClipped: true,
		});
		expect(m).toContain(":raw");
		expect(m).not.toContain("remainder");
		expect(m).toContain("too wide");
	});

	it("still inlines the first N preview rows before naming :raw", () => {
		const m = unseenLinesMessage(PATH, [10, 11], TAG, {
			lines: [{ line: 10, text: "keep-this-preview" }],
			truncated: true,
			columnClipped: true,
		});
		expect(m).toContain("  10:keep-this-preview");
		expect(m).toContain("first 1 unseen");
		expect(m).toContain(`${PATH}:10-11:raw`);
	});
});

describe("overCap truncated reveal names a ranged remainder re-read, never :raw", () => {
	it("overCap without columnClipped uses the remainder wording", () => {
		const m = unseenLinesMessage(PATH, [1, 2, 3, 4, 5], TAG, {
			lines: [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			],
			truncated: true,
			overCap: true,
		});
		expect(m).toContain("remainder");
		expect(m).toContain(`${PATH}:1-5`);
		expect(m).not.toContain(":raw");
		expect(m).not.toContain("too wide");
	});

	it("truncated with neither flag still takes the remainder path (legacy callers)", () => {
		const m = unseenLinesMessage("f.ts", [1, 2, 3, 4, 5], "DEAD", {
			lines: [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			],
			truncated: true,
		});
		expect(m).toContain("remainder");
		expect(m).not.toContain(":raw");
	});
});

describe("non-truncated reveals ignore the clip/cap flags", () => {
	it("columnClipped without truncated still offers a straight same-tag retry", () => {
		const m = unseenLinesMessage(PATH, [2], TAG, {
			lines: [{ line: 2, text: "secret" }],
			truncated: false,
			columnClipped: true,
		});
		expect(m).toContain("straight retry");
		expect(m).not.toContain(":raw");
		expect(m).not.toContain("remainder");
		expect(m).toContain(`${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}`);
	});

	it("overCap without truncated is also a straight retry — flags are truncated-only", () => {
		const m = unseenLinesMessage(PATH, [2], TAG, {
			lines: [{ line: 2, text: "secret" }],
			truncated: false,
			overCap: true,
		});
		expect(m).toContain("straight retry");
		expect(m).not.toContain("remainder");
	});
});

describe("empty reveal always names a ranged re-read, even if clip flags are set", () => {
	it("empty lines + truncated + columnClipped still uses the no-preview ranged command", () => {
		const m = unseenLinesMessage("g.ts", [8, 9], "CAFE", {
			lines: [],
			truncated: true,
			columnClipped: true,
		});
		expect(m).toContain("`g.ts:8-9`");
		expect(m).not.toContain(":raw");
		expect(m).toContain("skips summarization");
		expect(m).not.toContain("Preview of the actual file content");
	});

	it("empty lines with default reveal (no object) uses the same ranged command", () => {
		const m = unseenLinesMessage("g.ts", [3], "CAFE");
		expect(m).toContain("`g.ts:3`");
		expect(m).toContain("skips summarization");
	});

	it("disjoint unseen lines collapse to a comma-joined selector without spaces", () => {
		const m = unseenLinesMessage("g.ts", [1, 2, 10, 12], "CAFE", { lines: [], truncated: false });
		expect(m).toContain("`g.ts:1-2,10,12`");
		expect(m).not.toContain("`g.ts:1-2, 10");
	});
});

describe("header always names the cited tag, never a fresh one", () => {
	it("the unread-lines sentence includes the [path#tag] the edit cited", () => {
		const m = unseenLinesMessage("src/app.ts", [15], "9F00", { lines: [], truncated: false });
		expect(m).toContain(headerFragment("src/app.ts", "9F00"));
		expect(m).toContain("never displayed");
	});

	it("a path with a colon is still interpolated raw into both the header and the command", () => {
		const m = unseenLinesMessage("C:/src/a.ts", [1], "1111", { lines: [], truncated: false });
		expect(m).toContain("C:/src/a.ts");
		expect(m).toContain("`C:/src/a.ts:1`");
	});
});
