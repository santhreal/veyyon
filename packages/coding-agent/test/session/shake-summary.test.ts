import { describe, expect, it } from "bun:test";
import { formatShakeSummary } from "@veyyon/coding-agent/session/shake-types";

/**
 * formatShakeSummary is the single one-line operator summary shared by the TUI and ACP after
 * a `shake` run, so its exact wording is a contract both surfaces render. It had no test.
 * Pinned so a regression cannot silently change the copy, drop the pluralization, or lose a
 * section:
 *   - images mode: zero -> "No images found…", otherwise "Dropped N image(s)…" (pluralized);
 *   - elide mode: nothing dropped -> "Nothing to shake."; only one of tool-results/blocks
 *     present -> just that section; both present -> "A + B"; the freed-token count is shown.
 */

describe("formatShakeSummary images mode", () => {
	it("reports no images when none were dropped", () => {
		expect(formatShakeSummary({ mode: "images", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })).toBe(
			"No images found in this session.",
		);
	});

	it("pluralizes the dropped-image count", () => {
		expect(
			formatShakeSummary({
				mode: "images",
				toolResultsDropped: 0,
				blocksDropped: 0,
				imagesDropped: 1,
				tokensFreed: 0,
			}),
		).toBe("Dropped 1 image from this session.");
		expect(
			formatShakeSummary({
				mode: "images",
				toolResultsDropped: 0,
				blocksDropped: 0,
				imagesDropped: 3,
				tokensFreed: 0,
			}),
		).toBe("Dropped 3 images from this session.");
	});
});

describe("formatShakeSummary elide mode", () => {
	it("reports nothing to shake when neither tool results nor blocks were dropped", () => {
		expect(formatShakeSummary({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })).toBe(
			"Nothing to shake.",
		);
	});

	it("shows only the sections that dropped something, with the freed-token count", () => {
		expect(formatShakeSummary({ mode: "elide", toolResultsDropped: 2, blocksDropped: 0, tokensFreed: 500 })).toBe(
			"Shook 2 tool results (~500 tokens freed).",
		);
		expect(formatShakeSummary({ mode: "elide", toolResultsDropped: 1, blocksDropped: 3, tokensFreed: 1200 })).toBe(
			"Shook 1 tool result + 3 blocks (~1200 tokens freed).",
		);
	});
});
