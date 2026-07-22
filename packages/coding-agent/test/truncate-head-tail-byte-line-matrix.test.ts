/**
 * truncateHead / truncateTail: under budget identity; over lines/bytes exact
 * truncation flags; first line over byte limit yields empty head.
 */
import { describe, expect, it } from "bun:test";
import {
	truncateHead,
	truncateTail,
} from "@veyyon/coding-agent/session/streaming-output";

describe("truncateHead / truncateTail matrix", () => {
	const content = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");

	it("identity under large budget", () => {
		const h = truncateHead(content, { maxLines: 1000, maxBytes: 1_000_000 });
		expect(h.truncated).toBeFalsy();
		expect(h.content).toBe(content);
		const t = truncateTail(content, { maxLines: 1000, maxBytes: 1_000_000 });
		expect(t.truncated).toBeFalsy();
		expect(t.content).toBe(content);
	});

	it("head keeps first N lines", () => {
		const r = truncateHead(content, { maxLines: 3, maxBytes: 1_000_000 });
		expect(r.truncated).toBe(true);
		expect(r.content).toBe("line-1\nline-2\nline-3");
		expect(r.truncatedBy).toBe("lines");
	});

	it("tail keeps last N lines", () => {
		const r = truncateTail(content, { maxLines: 3, maxBytes: 1_000_000 });
		expect(r.truncated).toBe(true);
		expect(r.content).toBe("line-18\nline-19\nline-20");
	});

	it("head empty when first line exceeds maxBytes", () => {
		const big = "x".repeat(100);
		const r = truncateHead(big, { maxLines: 10, maxBytes: 10 });
		expect(r.truncated).toBe(true);
		expect(r.content).toBe("");
		expect(r.firstLineExceedsLimit).toBe(true);
	});

	it("totalLines/totalBytes reported", () => {
		const r = truncateHead("a\nb", { maxLines: 1, maxBytes: 1000 });
		expect(r.totalLines).toBe(2);
		expect(r.totalBytes).toBe(Buffer.byteLength("a\nb", "utf-8"));
	});
});
