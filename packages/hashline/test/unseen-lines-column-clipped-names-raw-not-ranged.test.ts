/**
 * unseenLinesMessage: truncated reveals are not one remedy.
 *
 * WHY THIS SUITE EXISTS. A truncated inline reveal used to always name a
 * ranged re-read (`path:1-N`). That is the right command when the preview hit
 * the LINE-COUNT cap (`overCap`): the unread remainder is still showable by
 * range. It is the WRONG command when a line was clipped at the COLUMN cap
 * (`columnClipped`). The reader applies the same per-line column cap, so the
 * ranged re-read clips the same line again and nothing in the loop mentions
 * `:raw`.
 *
 * The two flags are independent of `truncated` in the type, but the message
 * only consults them inside the `truncated` branch. A caller that sets
 * `columnClipped: true` without `truncated: true` currently falls through to
 * "straight retry" — pin that so a future collapse of the flags is visible.
 *
 * Empty/header/range-compression wording already lives in
 * messages-unseen-empty-reveal, messages-exact-contract, and
 * messages-unseen-range-format-matrix. Truncated-without-flags remainder
 * lives in messages-unseen-truncated-reveal.
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
});
