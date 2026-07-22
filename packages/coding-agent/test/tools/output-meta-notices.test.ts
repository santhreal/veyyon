import { describe, expect, it } from "bun:test";
import type { TruncationMeta } from "@veyyon/coding-agent/tools/output-meta";
import {
	formatFullOutputReference,
	formatTruncationMetaNotice,
	stripGeneratedOutputNotice,
	stripRawOutputArtifactNotice,
} from "@veyyon/coding-agent/tools/output-meta";

/**
 * The output-notice formatters/strippers decide what the model sees when a tool result is
 * truncated or spilled to an artifact. The composed formatOutputNotice/stripOutputNotice had
 * tests, but these building blocks did not. A regression here would mangle the "Showing lines
 * … of …" line the model reads, or fail to strip a notice the TUI re-renders (showing it
 * twice). Pinned:
 *   - formatFullOutputReference builds the exact "Read artifact://<id> for full output" line;
 *   - stripRawOutputArtifactNotice peels the "[raw output: artifact://<digits>]" footer,
 *     returning the id, and leaves text untouched when the id is non-numeric or absent;
 *   - stripGeneratedOutputNotice removes a recognized "[Showing …]"/"[N matches limit …]"
 *     trailing line and nothing else;
 *   - formatTruncationMetaNotice renders tail (range, byte-limit suffix, next-offset,
 *     artifact) and middle-elision variants with exact byte/line formatting.
 */

describe("formatFullOutputReference", () => {
	it("builds the exact full-output artifact reference line", () => {
		expect(formatFullOutputReference("42")).toBe("Read artifact://42 for full output");
	});
});

describe("stripRawOutputArtifactNotice", () => {
	it("peels a numeric raw-output footer and returns the artifact id", () => {
		expect(stripRawOutputArtifactNotice("body line1\nbody line2\n[raw output: artifact://123]")).toEqual({
			text: "body line1\nbody line2",
			artifactId: "123",
		});
		expect(stripRawOutputArtifactNotice("[raw output: artifact://7]")).toEqual({ text: "", artifactId: "7" });
	});

	it("leaves the text unchanged when the footer id is non-numeric or absent", () => {
		expect(stripRawOutputArtifactNotice("body\n[raw output: artifact://abc]")).toEqual({
			text: "body\n[raw output: artifact://abc]",
		});
		expect(stripRawOutputArtifactNotice("just body\nno footer")).toEqual({ text: "just body\nno footer" });
	});
});

describe("stripGeneratedOutputNotice", () => {
	it("removes a recognized trailing generated-output notice", () => {
		expect(stripGeneratedOutputNotice("data\n[Showing lines 1-5 of 10]")).toBe("data");
		expect(stripGeneratedOutputNotice("x\n[3 matches limit reached. Use limit=10 for more]")).toBe("x");
	});

	it("leaves an unrecognized trailing bracket line or plain text unchanged", () => {
		expect(stripGeneratedOutputNotice("x\n[not a notice]")).toBe("x\n[not a notice]");
		expect(stripGeneratedOutputNotice("just text")).toBe("just text");
	});
});

describe("formatTruncationMetaNotice", () => {
	it("renders a tail range, a byte-limit suffix with next-offset, and an artifact reference", () => {
		const range: TruncationMeta = {
			direction: "tail",
			truncatedBy: "lines",
			totalLines: 100,
			totalBytes: 9999,
			outputLines: 20,
			outputBytes: 2000,
			shownRange: { start: 1, end: 20 },
		};
		expect(formatTruncationMetaNotice(range)).toBe("Showing lines 1-20 of 100");

		const bytes: TruncationMeta = {
			direction: "tail",
			truncatedBy: "bytes",
			totalLines: 100,
			totalBytes: 9999,
			outputLines: 20,
			outputBytes: 2000,
			maxBytes: 2048,
			nextOffset: 21,
		};
		expect(formatTruncationMetaNotice(bytes)).toBe("Showing 20 of 100 lines (2.0KB limit). Use :21 to continue");

		const withArtifact: TruncationMeta = {
			direction: "tail",
			truncatedBy: "lines",
			totalLines: 50,
			totalBytes: 900,
			outputLines: 10,
			outputBytes: 100,
			shownRange: { start: 1, end: 10 },
			artifactId: "77",
		};
		expect(formatTruncationMetaNotice(withArtifact)).toBe(
			"Showing lines 1-10 of 50. Read artifact://77 for full output",
		);
	});

	it("renders a middle-elision notice with head/tail ranges and elided line/byte counts", () => {
		const middle: TruncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: 1000,
			totalBytes: 50000,
			outputLines: 200,
			outputBytes: 10000,
			headRange: { start: 1, end: 100 },
			tailRange: { start: 901, end: 1000 },
			elidedLines: 800,
			elidedBytes: 40000,
		};
		expect(formatTruncationMetaNotice(middle)).toBe(
			"Showing lines 1-100 and 901-1000 of 1000; 800 middle lines (39.1KB) elided",
		);
	});

	it("falls back to a summary line when a middle elision has no head/tail ranges", () => {
		const middle: TruncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: 1000,
			totalBytes: 50000,
			outputLines: 200,
			outputBytes: 10000,
		};
		expect(formatTruncationMetaNotice(middle)).toBe("Showing 200 of 1000 lines; middle elided");
	});
});
