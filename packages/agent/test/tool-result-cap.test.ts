import { beforeEach, describe, expect, it } from "bun:test";
import {
	__resetToolResultCapReportsForTests,
	capToolResultContent,
	DEFAULT_TOOL_RESULT_MAX_BYTES,
} from "../src/tool-result-cap";
import type { ImageContent, TextContent } from "../src/types";

/**
 * A tool result too large for the request must be cut here, not by the API.
 *
 * The agent loop used to copy `result.content` into the tool result message
 * verbatim. Every built-in tool caps its own output, so on the happy path that
 * was fine. Nothing enforced it, though, and a tool registered from outside the
 * codebase (an MCP server, a host application's own tool) has no such budget.
 *
 * The failure mode is worse than a large turn. An oversized body is rejected by
 * the provider, so the TURN fails rather than the tool, and because the result
 * is already in the transcript every retry resends the same oversized body. The
 * session cannot get out of it on its own. Capping at the loop boundary turns
 * that into a marked elision the model can read and work around.
 *
 * The cap is a pure function of the input, which is what makes it testable and
 * what the acceptance for this work asks for: the same input always loses the
 * same bytes at the same boundary, and the marker states exactly how many.
 */
describe("the agent loop's cap on tool result size", () => {
	beforeEach(() => {
		__resetToolResultCapReportsForTests();
	});

	const text = (value: string): TextContent => ({ type: "text", text: value });
	const image = (): ImageContent => ({ type: "image", data: "AAAA", mimeType: "image/png" });

	/** Lines are what the head/tail windows cut on, so build inputs out of them. */
	function lines(count: number, char: string): string {
		return `${Array.from({ length: count }, (_, i) => `${char}${i}`).join("\n")}\n`;
	}

	/**
	 * The common path, and the one that must stay allocation-free: a normal
	 * result is returned as the very same array, untouched.
	 */
	it("returns a result that fits without copying it", () => {
		const content = [text("small output"), image()];

		const result = capToolResultContent(content, "read");

		expect(result.elidedBytes).toBe(0);
		expect(result.content).toBe(content);
	});

	/**
	 * The core case. An unbounded tool's output is cut down and the result says
	 * how much was lost.
	 */
	it("caps a result that exceeds the budget", () => {
		const big = lines(2000, "line");
		const originalBytes = Buffer.byteLength(big, "utf-8");

		const result = capToolResultContent([text(big)], "mcp__scraper__fetch", 1000);

		expect(result.originalBytes).toBe(originalBytes);
		expect(result.elidedBytes).toBeGreaterThan(0);
		const capped = (result.content[0] as TextContent).text;
		expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(1000);
	});

	/**
	 * The elision must be visible in the text itself, and must state the exact
	 * byte count. A silent cut would leave the model reading output that is
	 * missing its middle with nothing saying so, which is how a truncated file
	 * listing gets treated as the complete one.
	 */
	it("marks the elision with the exact number of bytes removed", () => {
		const big = lines(2000, "line");

		const result = capToolResultContent([text(big)], "mcp__scraper__fetch", 1000);
		const capped = (result.content[0] as TextContent).text;

		expect(capped).toContain(`[…${result.elidedBytes}B elided…]`);
	});

	/**
	 * Head and tail are both kept, because each answers a different question:
	 * the head says what the tool was doing and the tail says how it ended.
	 * Keeping only one would make the cap useless for diagnosis.
	 */
	it("keeps the start and the end of the output", () => {
		const big = lines(2000, "line");

		const result = capToolResultContent([text(big)], "mcp__scraper__fetch", 2000);
		const capped = (result.content[0] as TextContent).text;

		expect(capped.startsWith("line0\n")).toBe(true);
		expect(capped.endsWith("line1999\n") || capped.endsWith("line1999")).toBe(true);
	});

	/**
	 * Determinism is the acceptance criterion: the same input must lose the same
	 * bytes at the same boundary every time, or a repeated tool call would
	 * produce a different transcript each run and nothing downstream could cache
	 * or compare it.
	 */
	it("cuts at the same boundary every time", () => {
		const big = lines(2000, "line");

		const first = capToolResultContent([text(big)], "mcp__scraper__fetch", 1000);
		const second = capToolResultContent([text(big)], "mcp__scraper__fetch", 1000);

		expect((first.content[0] as TextContent).text).toBe((second.content[0] as TextContent).text);
		expect(first.elidedBytes).toBe(second.elidedBytes);
	});

	/**
	 * The split across blocks is proportional, so it does not depend on the order
	 * the tool happened to emit them in. An order-dependent cap would silently
	 * delete a small trailing block that carried the tool's error message.
	 */
	it("splits the budget across blocks by size, not by order", () => {
		const large = lines(2000, "big");
		const small = lines(400, "small");

		const forward = capToolResultContent([text(large), text(small)], "mcp__multi", 4000);
		const reversed = capToolResultContent([text(small), text(large)], "mcp__multi", 4000);

		expect(forward.elidedBytes).toBe(reversed.elidedBytes);
		expect((forward.content[0] as TextContent).text).toBe((reversed.content[1] as TextContent).text);
		expect((forward.content[1] as TextContent).text).toBe((reversed.content[0] as TextContent).text);
	});

	/**
	 * Images are passed through untouched. They are bounded by the provider's own
	 * image limits, and removing bytes from the middle of one would produce a
	 * corrupt image rather than a smaller one.
	 */
	it("never cuts into an image block", () => {
		const img = image();

		const result = capToolResultContent([text(lines(2000, "line")), img], "mcp__screenshot", 1000);

		expect(result.content[1]).toEqual(img);
	});

	/**
	 * Multi-byte text must survive the cut as valid UTF-8. Cutting on a raw byte
	 * offset would leave a half-encoded character, which is exactly the "sent
	 * malformed" outcome the cap exists to prevent.
	 */
	it("does not split a multi-byte character", () => {
		const multibyte = `${"日本語のテキスト\n".repeat(500)}`;

		const result = capToolResultContent([text(multibyte)], "mcp__translate", 1000);
		const capped = (result.content[0] as TextContent).text;

		// A lone replacement character is what a mid-sequence cut decodes to.
		expect(capped).not.toContain("�");
		expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(1000);
	});

	/**
	 * A budget of zero means unbounded rather than "elide everything". Callers
	 * express "no cap" that way, and reading it as a cap of zero bytes would
	 * delete every tool result in the session.
	 */
	it("treats a budget of zero as unbounded", () => {
		const content = [text(lines(2000, "line"))];

		const result = capToolResultContent(content, "read", 0);

		expect(result.elidedBytes).toBe(0);
		expect(result.content).toBe(content);
	});

	/**
	 * A result exactly at the budget is not capped. Off-by-one here would trim
	 * results that fit perfectly, which is both wasteful and hard to notice.
	 */
	it("leaves a result that is exactly at the budget alone", () => {
		const exact = "x".repeat(500);

		const result = capToolResultContent([text(exact)], "read", 500);

		expect(result.elidedBytes).toBe(0);
		expect((result.content[0] as TextContent).text).toBe(exact);
	});

	/**
	 * The default budget is far above what any built-in tool produces, so this
	 * backstop never fires on the happy path. If it did, it would be silently
	 * trimming correct output.
	 */
	it("leaves a typical tool result alone under the default budget", () => {
		const typical = lines(3000, "line");
		expect(Buffer.byteLength(typical, "utf-8")).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_BYTES);

		const result = capToolResultContent([text(typical)], "grep");

		expect(result.elidedBytes).toBe(0);
	});

	/**
	 * Total bytes are measured across all text blocks together, not per block. A
	 * tool returning a thousand small blocks would otherwise pass every
	 * per-block check and still blow the request budget.
	 */
	it("measures the budget across every text block together", () => {
		const blocks = Array.from({ length: 20 }, () => text(lines(100, "chunk")));
		const total = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text, "utf-8"), 0);

		const result = capToolResultContent(blocks, "mcp__many", Math.floor(total / 2));

		expect(result.originalBytes).toBe(total);
		expect(result.elidedBytes).toBeGreaterThan(0);
		const cappedTotal = result.content.reduce(
			(sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text, "utf-8") : 0),
			0,
		);
		expect(cappedTotal).toBeLessThanOrEqual(total / 2);
	});

	/**
	 * A cap must never make the result bigger. When a block's share of the budget
	 * is small enough, the elision marker costs more bytes than the text it
	 * replaces, and a naive cap would grow the very request it exists to shrink.
	 */
	it("never grows a block that is smaller than its own elision marker", () => {
		// One huge block takes nearly the whole budget, leaving the tiny ones a
		// share of a handful of bytes each.
		const tiny = Array.from({ length: 5 }, (_, i) => text(`e${i}\n`));
		const blocks = [text(lines(5000, "line")), ...tiny];

		const result = capToolResultContent(blocks, "mcp__many_small", 2000);

		for (let i = 0; i < tiny.length; i++) {
			const before = Buffer.byteLength(tiny[i].text, "utf-8");
			const after = Buffer.byteLength((result.content[i + 1] as TextContent).text, "utf-8");
			expect(after).toBeLessThanOrEqual(before);
		}
	});

	/**
	 * The input array is never mutated. The uncapped result is still shown in the
	 * UI and written to the session, and rewriting it in place would make what
	 * the operator sees disagree with what the tool actually returned.
	 */
	it("does not mutate the caller's content", () => {
		const original = lines(2000, "line");
		const block = text(original);

		capToolResultContent([block], "mcp__scraper__fetch", 1000);

		expect(block.text).toBe(original);
	});
});
