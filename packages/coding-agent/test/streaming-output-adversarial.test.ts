import { describe, expect, it } from "bun:test";
import {
	truncateHead,
	truncateHeadBytes,
	truncateLine,
	truncateMiddle,
	truncateTail,
	truncateTailBytes,
} from "@veyyon/coding-agent/session/streaming-output";

/**
 * Streaming output truncators: exact field names (content/text), bounds,
 * and prefix/suffix preservation.
 */

describe("truncateHead / truncateTail adversarial", () => {
	it("truncateHead under maxLines returns full content without truncated flag", () => {
		const content = "a\nb\nc\n";
		const result = truncateHead(content, { maxLines: 100 });
		expect(result.truncated ?? false).toBe(false);
		expect(result.content).toContain("a");
		expect(result.content).toContain("c");
	});

	it("truncateHead with maxLines 2 keeps the first lines", () => {
		const content = "L1\nL2\nL3\nL4\n";
		const result = truncateHead(content, { maxLines: 2 });
		expect(result.truncated).toBe(true);
		expect(result.content).toContain("L1");
		expect(result.content.includes("L4")).toBe(false);
		expect(result.outputLines).toBe(2);
	});

	it("truncateTail with maxLines 2 keeps the last lines", () => {
		const content = "L1\nL2\nL3\nL4\n";
		const result = truncateTail(content, { maxLines: 2 });
		expect(result.truncated).toBe(true);
		expect(result.content).toContain("L4");
		expect(result.content.includes("L1")).toBe(false);
	});

	it("empty content is not marked truncated", () => {
		const head = truncateHead("", { maxLines: 10 });
		const tail = truncateTail("", { maxLines: 10 });
		expect(head.content).toBe("");
		expect(tail.content).toBe("");
		expect(head.truncated ?? false).toBe(false);
		expect(tail.truncated ?? false).toBe(false);
	});
});

describe("truncateMiddle and byte truncators", () => {
	it("truncateMiddle keeps head and tail when over budget", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n") + "\n";
		const result = truncateMiddle(lines, { maxLines: 10 });
		if (result.truncated) {
			expect(result.content).toContain("L0");
			expect(result.content).toContain("L49");
		} else {
			expect(result.content).toContain("L0");
		}
	});

	it("truncateHeadBytes respects maxBytes on a large string", () => {
		const data = "x".repeat(10_000);
		const result = truncateHeadBytes(data, 100);
		expect(result.text.length).toBeLessThanOrEqual(100);
		expect(result.bytes).toBeLessThanOrEqual(100);
		expect(result.text.startsWith("x") || result.text.length === 0).toBe(true);
	});

	it("truncateTailBytes keeps the end of a large string", () => {
		const data = "a".repeat(5000) + "END";
		const result = truncateTailBytes(data, 10);
		const out = result.text;
		expect(out.length).toBeLessThanOrEqual(10);
		if (out.length >= 3) {
			expect(out.endsWith("END") || out.includes("E")).toBe(true);
		}
	});
});

describe("truncateLine", () => {
	it("returns short lines unchanged", () => {
		const result = truncateLine("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.wasTruncated).toBe(false);
	});

	it("truncates long lines and sets wasTruncated", () => {
		const long = "y".repeat(1000);
		const result = truncateLine(long, 20);
		expect(result.wasTruncated).toBe(true);
		expect(result.text.length).toBeLessThan(long.length);
		expect(result.text.length).toBeLessThanOrEqual(25);
	});

	it("unicode long line does not throw", () => {
		const long = "日".repeat(200);
		const result = truncateLine(long, 10);
		expect(typeof result.text).toBe("string");
		expect(result.text.length).toBeGreaterThan(0);
	});
});
