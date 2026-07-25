/**
 * `transformToolCallArguments` runs once, before anything observes the arguments.
 *
 * WHY THIS SUITE EXISTS. The transform is where a harness rewrites arguments for
 * real: deobfuscating secret placeholders back into their values, expanding codec
 * handles (`§db` back into `src/db.ts`) so a person reading the screen sees text
 * rather than a token, and clamping timeouts. It used to run at the very last
 * moment, immediately before `tool.execute`, which meant its output reached the
 * tool and nothing else.
 *
 * That position broke the display contract. `tool_execution_start` is the event
 * an interactive renderer treats as authoritative ("the arguments are final now,
 * reconcile them"), and it carried the pre-transform values, so it overwrote a
 * correctly decoded live preview with the raw form and left it there for the rest
 * of the session. Every other observer had the same problem: the telemetry span
 * recorded pre-transform arguments, and `beforeToolCall` was handed a different
 * object from the one that ran, silently dropping in-place mutations its own
 * documentation promises will stick.
 *
 * These tests pin the position itself rather than any one symptom, because the
 * position is the invariant: one transform, applied once, and every consumer sees
 * the same values the tool does.
 */

import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const schema = type({ path: "string" });

/** A tool that records the arguments it was actually executed with. */
function recordingTool(seen: Record<string, unknown>[]): AgentTool<typeof schema, { path: string }> {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: schema,
		async execute(_id, params) {
			seen.push({ ...params });
			return { content: [{ type: "text", text: "ok" }], details: { path: params.path } };
		},
	};
}

/** Run one tool call through the loop and hand back every event it emitted. */
async function runCall(
	config: Partial<AgentLoopConfig>,
	tool: AgentTool<typeof schema, { path: string }>,
	args: Record<string, unknown> = { path: "§db" },
): Promise<AgentEvent[]> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: args }] },
			{ content: ["done"] },
		],
	});
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[createUserMessage("read it")],
		context,
		{ model: mock.model, convertToLlm: identityConverter, ...config },
		undefined,
		mock.stream,
	);
	for await (const event of stream) events.push(event);
	return events;
}

/** The `args` of the first `tool_execution_start` event, which is the display-authoritative one. */
function startArgs(events: AgentEvent[]): Record<string, unknown> | undefined {
	const start = events.find(e => e.type === "tool_execution_start");
	return start === undefined ? undefined : (start as { args: Record<string, unknown> }).args;
}

describe("transformToolCallArguments position", () => {
	/**
	 * The core regression. An expanding transform stands in for argot handle
	 * expansion and secret deobfuscation: whatever it produces is what a person
	 * must see, so the event the renderer reconciles from has to carry it.
	 */
	it("gives tool_execution_start the transformed arguments, not the raw ones", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall(
			{ transformToolCallArguments: args => ({ ...args, path: "src/db.ts" }) },
			recordingTool(seen),
		);
		expect(startArgs(events)).toEqual({ path: "src/db.ts" });
		expect(startArgs(events)).not.toEqual({ path: "§db" });
	});

	/**
	 * The event and the execution must agree. Two different views of one call is
	 * how the old ordering produced a screen that disagreed with what ran.
	 */
	it("executes the tool with exactly the arguments the start event announced", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall(
			{ transformToolCallArguments: args => ({ ...args, path: "src/db.ts" }) },
			recordingTool(seen),
		);
		expect(seen).toEqual([{ path: "src/db.ts" }]);
		expect(startArgs(events)).toEqual(seen[0]);
	});

	/**
	 * Applied once, not once per observer. A transform is allowed to be
	 * non-idempotent (appending, counting, unwrapping one layer), so running it a
	 * second time on its own output would corrupt the arguments.
	 */
	it("applies the transform exactly once per call", async () => {
		const seen: Record<string, unknown>[] = [];
		let calls = 0;
		const events = await runCall(
			{
				transformToolCallArguments: args => {
					calls++;
					return { ...args, path: `${args.path as string}!` };
				},
			},
			recordingTool(seen),
		);
		expect(calls).toBe(1);
		expect(seen).toEqual([{ path: "§db!" }]);
		expect(startArgs(events)).toEqual({ path: "§db!" });
	});

	/**
	 * `beforeToolCall` receives the same object the tool runs on, which is what
	 * `BeforeToolCallContext.args` documents. Under the old ordering the hook saw
	 * the pre-transform object and the tool ran on a transformed copy, so a hook
	 * that mutated in place had its mutation silently discarded.
	 */
	it("hands beforeToolCall the transformed object, so its in-place mutations reach the tool", async () => {
		const seen: Record<string, unknown>[] = [];
		let hookSaw: unknown;
		await runCall(
			{
				transformToolCallArguments: args => ({ ...args, path: "src/db.ts" }),
				beforeToolCall: async ctx => {
					hookSaw = (ctx.args as { path: string }).path;
					(ctx.args as { path: string }).path = "src/db.ts#pinned";
					return undefined;
				},
			},
			recordingTool(seen),
		);
		expect(hookSaw).toBe("src/db.ts");
		expect(seen).toEqual([{ path: "src/db.ts#pinned" }]);
	});

	/**
	 * A throwing transform fails the call as a tool error rather than escaping into
	 * the loop. Moving the transform out of the execution try/catch would otherwise
	 * turn a bad rewrite into an unhandled rejection that takes down the turn.
	 */
	it("fails the call as a tool error when the transform throws, without running the tool", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall(
			{
				transformToolCallArguments: () => {
					throw new Error("codec dictionary is corrupt");
				},
			},
			recordingTool(seen),
		);
		expect(seen).toEqual([]);
		const end = events.find(e => e.type === "message_end" && (e.message as AgentMessage).role === "toolResult");
		const message = (end as { message: ToolResultMessage } | undefined)?.message;
		expect(message?.isError).toBe(true);
		expect(JSON.stringify(message?.content)).toContain("codec dictionary is corrupt");
	});

	/** With no transform configured the arguments pass through byte for byte. */
	it("leaves arguments untouched when no transform is configured", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall({}, recordingTool(seen), { path: "src/main.ts" });
		expect(startArgs(events)).toEqual({ path: "src/main.ts" });
		expect(seen).toEqual([{ path: "src/main.ts" }]);
	});
});
