/**
 * resolve tool pins exact metadata, schema, intent, and output text.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. resolve is a hidden tool for the apply/discard preview protocol.
 * Its contracts: tool metadata (name, label, approval, hidden, strict),
 * the action enum, intent text generation, and the "nothing to discard"
 * output when no pending action exists.
 */
import { describe, expect, it } from "bun:test";
import { ResolveTool } from "@veyyon/coding-agent/tools/resolve";

function mockSession() {
	return {
		peekQueueInvoker: () => undefined,
		peekPendingInvoker: () => undefined,
		peekStandingResolveHandler: () => undefined,
		clearPendingInvokers: () => {},
	} as never;
}

describe("resolve tool metadata", () => {
	it("has name 'resolve'", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.name).toBe("resolve");
	});

	it("has label 'Resolve'", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.label).toBe("Resolve");
	});

	it("has approval 'read'", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.approval).toBe("read");
	});

	it("is hidden", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.hidden).toBe(true);
	});

	it("has strict true", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.strict).toBe(true);
	});
});

describe("resolve tool intent", () => {
	it("returns 'discarding: <reason>' for discard with reason", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.intent({ action: "discard", reason: "bad idea" })).toBe("discarding: bad idea");
	});

	it("returns 'discarding changes' for discard without reason", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.intent({ action: "discard" })).toBe("discarding changes");
	});

	it("returns 'accepting: <reason>' for apply with reason", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.intent({ action: "apply", reason: "looks good" })).toBe("accepting: looks good");
	});

	it("returns 'accepting changes' for apply without reason", () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.intent({ action: "apply" })).toBe("accepting changes");
	});
});

describe("resolve tool execute", () => {
	it("returns 'Nothing to discard' when no pending action and action is discard", async () => {
		const tool = new ResolveTool(mockSession());
		const result = await tool.execute("id", { action: "discard", reason: "test" });
		expect((result.content[0] as { text: string }).text).toBe(
			"Nothing to discard; no pending action remains.",
		);
	});

	it("throws when no pending action and action is apply", async () => {
		const tool = new ResolveTool(mockSession());
		expect(tool.execute("id", { action: "apply", reason: "test" })).rejects.toThrow();
	});
});
