import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { HookRunner } from "@veyyon/coding-agent/extensibility/hooks/runner";
import { HookToolWrapper } from "@veyyon/coding-agent/extensibility/hooks/tool-wrapper";

/**
 * HookToolWrapper wraps a tool so extension hooks can intercept it. Its contract was
 * untested and every branch is behavioral: a tool_call hook can BLOCK execution (the
 * wrapped tool must never run), a blocking hook without a reason falls back to a default
 * message, and crucially a hook that ERRORS blocks by default (fail-safe) rather than
 * letting the tool run unguarded. On the result side a tool_result hook may replace
 * content and/or details (each independently, falling back to the original when the hook
 * omits one), or leave the result untouched by returning undefined. When the wrapped
 * tool throws, the wrapper still emits a tool_result event marked isError so hooks can
 * observe failures, then re-throws the ORIGINAL error. A regression in any branch would
 * either run a tool a hook meant to block, or swallow/replace a real error.
 */

interface FakeToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
}

const makeTool = (execute: (...args: unknown[]) => Promise<FakeToolResult>, name = "faketool"): AgentTool =>
	({ name, description: "d", label: "L", strict: false, parameters: {}, execute }) as unknown as AgentTool;

const makeRunner = (over: Partial<Record<string, unknown>> = {}): HookRunner =>
	({
		hasHandlers: () => false,
		emitToolCall: async () => undefined,
		emit: async () => undefined,
		...over,
	}) as unknown as HookRunner;

const ok: FakeToolResult = { content: [{ type: "text", text: "orig" }], details: { d: 1 } };

describe("HookToolWrapper tool_call blocking", () => {
	it("returns the tool result unchanged when there are no handlers", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner(),
		);
		expect(await w.execute("id", {})).toEqual(ok);
	});

	it("blocks with the hook's reason and never runs the tool", async () => {
		let ran = false;
		const tool = makeTool(async () => {
			ran = true;
			return ok;
		});
		const w = new HookToolWrapper(
			tool,
			makeRunner({
				hasHandlers: (t: string) => t === "tool_call",
				emitToolCall: async () => ({ block: true, reason: "nope" }),
			}),
		);
		await expect(w.execute("id", {})).rejects.toThrow("nope");
		expect(ran).toBe(false);
	});

	it("blocks with a default message when the hook gives no reason", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner({
				hasHandlers: (t: string) => t === "tool_call",
				emitToolCall: async () => ({ block: true }),
			}),
		);
		await expect(w.execute("id", {})).rejects.toThrow("Tool execution was blocked by a hook");
	});

	it("fails safe: a hook that throws blocks execution", async () => {
		let ran = false;
		const tool = makeTool(async () => {
			ran = true;
			return ok;
		});
		const w = new HookToolWrapper(
			tool,
			makeRunner({
				hasHandlers: (t: string) => t === "tool_call",
				emitToolCall: async () => {
					throw new Error("hook boom");
				},
			}),
		);
		await expect(w.execute("id", {})).rejects.toThrow("hook boom");
		expect(ran).toBe(false);
	});

	it("proceeds when the hook does not block", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner({
				hasHandlers: (t: string) => t === "tool_call",
				emitToolCall: async () => ({ block: false }),
			}),
		);
		expect(await w.execute("id", {})).toEqual(ok);
	});
});

describe("HookToolWrapper tool_result modification", () => {
	it("replaces both content and details", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner({
				hasHandlers: (t: string) => t === "tool_result",
				emit: async () => ({ content: [{ type: "text", text: "modified" }], details: { d: 2 } }),
			}),
		);
		expect(await w.execute("id", {})).toEqual({ content: [{ type: "text", text: "modified" }], details: { d: 2 } });
	});

	it("replaces only content, keeping the original details", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner({
				hasHandlers: (t: string) => t === "tool_result",
				emit: async () => ({ content: [{ type: "text", text: "only-content" }] }),
			}),
		);
		expect(await w.execute("id", {})).toEqual({
			content: [{ type: "text", text: "only-content" }],
			details: { d: 1 },
		});
	});

	it("replaces only details, keeping the original content", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner({
				hasHandlers: (t: string) => t === "tool_result",
				emit: async () => ({ details: { d: 99 } }),
			}),
		);
		expect(await w.execute("id", {})).toEqual({ content: [{ type: "text", text: "orig" }], details: { d: 99 } });
	});

	it("keeps the original result when the hook returns undefined", async () => {
		const w = new HookToolWrapper(
			makeTool(async () => ok),
			makeRunner({ hasHandlers: (t: string) => t === "tool_result", emit: async () => undefined }),
		);
		expect(await w.execute("id", {})).toEqual(ok);
	});
});

describe("HookToolWrapper error handling", () => {
	it("emits an isError tool_result and re-throws the original error", async () => {
		let emitted: { isError?: boolean; content?: unknown } | undefined;
		const w = new HookToolWrapper(
			makeTool(async () => {
				throw new Error("exec fail");
			}),
			makeRunner({
				hasHandlers: (t: string) => t === "tool_result",
				emit: async (event: { isError?: boolean; content?: unknown }) => {
					emitted = event;
					return undefined;
				},
			}),
		);
		await expect(w.execute("id", {})).rejects.toThrow("exec fail");
		expect(emitted?.isError).toBe(true);
		expect(emitted?.content).toEqual([{ type: "text", text: "exec fail" }]);
	});
});
