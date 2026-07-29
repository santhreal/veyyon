/**
 * `transformToolCallArguments` runs once and its result is routed by AUDIENCE:
 * `execution` to the tool, `display` to everything that shows or records.
 *
 * WHY THIS SUITE EXISTS. The transform is where a harness rewrites arguments for
 * real, and two of those rewrites want opposite things from a display:
 *
 * - A codec handle (`§db` → `src/db.ts`) MUST be expanded before a person sees
 *   it. Nobody should decode a token by eye, so hiding the expansion from the
 *   screen is the bug.
 * - A secret placeholder (`#TOKEN#` → the credential) MUST NOT be expanded for a
 *   person, an event stream, a telemetry span or a session file. The expanded
 *   form is a live credential and those are precisely the places it must never
 *   reach.
 *
 * THIS SUITE GUARDS BOTH CONTRACTS AT ONCE, WHICH IS WHY IT CANNOT BE ONE HOOK.
 * It used to assert only the first, because only the first was understood: the
 * transform ran once and the loop forwarded the same reference to `tool.execute`
 * and to `tool_execution_start`. That satisfied handles and leaked credentials —
 * a `bash` tool card rendered the real token, and `--mode json` wrote it to
 * stdout. Reversing the position to fix secrets would have put `§db` back on the
 * screen, which is the regression the original suite existed to prevent. Neither
 * direction is wrong; sharing one form is. So the transform returns both forms
 * and the loop routes them, and these tests pin BOTH directions so that fixing
 * one can never silently reintroduce the other.
 *
 * The earlier position bug is still pinned below: `tool_execution_start` is the
 * event an interactive renderer treats as authoritative ("arguments are final,
 * reconcile them"), so it must carry the display form rather than the raw one,
 * and `beforeToolCall` must receive the very object the tool runs on so its
 * documented in-place mutations stick.
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

/**
 * Stands in for the two real rewrites. `§db` is a codec handle: safe to reveal,
 * so it expands for both audiences. `#TOKEN#` is a secret placeholder: expanded
 * for the tool only, never for the display form.
 */
const HANDLE = "§db";
const HANDLE_EXPANDED = "src/db.ts";
const PLACEHOLDER = "#TOKEN#";
const CREDENTIAL = "tok-live-4a91";

function expandHandle(value: string): string {
	return value.replaceAll(HANDLE, HANDLE_EXPANDED);
}

/** The production shape: handles expand for everyone, credentials for the tool alone. */
function splitTransform(args: Record<string, unknown>): {
	execution: Record<string, unknown>;
	display: Record<string, unknown>;
} {
	const path = typeof args.path === "string" ? args.path : "";
	const display = { ...args, path: expandHandle(path) };
	return {
		display,
		execution: {
			...display,
			path: display.path.replaceAll(PLACEHOLDER, CREDENTIAL),
		},
	};
}

/** A tool that records the arguments it was actually executed with. */
function recordingTool(
	seen: Record<string, unknown>[],
	streamUpdate = false,
): AgentTool<typeof schema, { path: string }> {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: schema,
		async execute(_id, params, _signal, onUpdate) {
			seen.push({ ...params });
			if (streamUpdate)
				onUpdate?.({
					content: [{ type: "text", text: "partial" }],
					details: { path: params.path },
				});
			return {
				content: [{ type: "text", text: "ok" }],
				details: { path: params.path },
			};
		},
	};
}

/** Run one tool call through the loop and hand back every event it emitted. */
async function runCall(
	config: Partial<AgentLoopConfig>,
	tool: AgentTool<typeof schema, { path: string }>,
	args: Record<string, unknown> = { path: HANDLE },
): Promise<AgentEvent[]> {
	const context: AgentContext = {
		systemPrompt: [""],
		messages: [],
		tools: [tool],
	};
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: args }],
			},
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

/**
 * The `args` of the first `tool_execution_start`, which is the display-authoritative
 * event. The event contract types `args` as `unknown`, so this returns it as-is and
 * the assertions compare whole objects rather than asserting a shape.
 */
function startArgs(events: AgentEvent[]): unknown {
	for (const event of events) if (event.type === "tool_execution_start") return event.args;
	return undefined;
}

/** The `args` of the first `tool_execution_update`, the streaming half of the same display. */
function updateArgs(events: AgentEvent[]): unknown {
	for (const event of events) if (event.type === "tool_execution_update") return event.args;
	return undefined;
}

/** The emitted tool result message, used to assert a failed call. */
function toolResult(events: AgentEvent[]): ToolResultMessage | undefined {
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (message.role === "toolResult") return message;
	}
	return undefined;
}

describe("transformToolCallArguments audience split", () => {
	/**
	 * Direction one, the display contract. A handle must arrive expanded, because
	 * `tool_execution_start` is what the renderer reconciles from and an operator
	 * cannot read `§db`. Regression: reversing the transform position to keep
	 * secrets out of the display would put the raw handle back on the screen.
	 */
	it("gives tool_execution_start the display form with codec handles expanded", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall({ transformToolCallArguments: splitTransform }, recordingTool(seen));
		expect(startArgs(events)).toEqual({ path: HANDLE_EXPANDED });
	});

	/**
	 * Direction two, the credential contract. The same event must NOT carry the
	 * expanded secret. Regression: the loop used to forward one shared reference,
	 * so the rendered tool card and the `--mode json` event stream both printed the
	 * live credential.
	 */
	it("keeps the secret placeholder unexpanded in tool_execution_start", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall({ transformToolCallArguments: splitTransform }, recordingTool(seen), {
			path: `${HANDLE}/${PLACEHOLDER}`,
		});
		expect(startArgs(events)).toEqual({
			path: `${HANDLE_EXPANDED}/${PLACEHOLDER}`,
		});
	});

	/**
	 * Both directions on the execution side: the tool is the one audience that gets
	 * everything expanded, or it would authenticate with the literal text
	 * `#TOKEN#`. Pinned opposite the previous test so collapsing the two forms back
	 * into one fails whichever form survives.
	 */
	it("executes the tool with both the handle and the credential expanded", async () => {
		const seen: Record<string, unknown>[] = [];
		await runCall({ transformToolCallArguments: splitTransform }, recordingTool(seen), {
			path: `${HANDLE}/${PLACEHOLDER}`,
		});
		expect(seen).toEqual([{ path: `${HANDLE_EXPANDED}/${CREDENTIAL}` }]);
	});

	/**
	 * The streaming display shares the display form. Regression: `tool_execution_update`
	 * fires from inside the tool's own execution, which is the natural place to
	 * reach for the arguments the tool was handed and leak the credential per chunk.
	 */
	it("streams tool_execution_update with the display form, not the executed one", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall({ transformToolCallArguments: splitTransform }, recordingTool(seen, true), {
			path: `${HANDLE}/${PLACEHOLDER}`,
		});
		expect(updateArgs(events)).toEqual({
			path: `${HANDLE_EXPANDED}/${PLACEHOLDER}`,
		});
	});

	/**
	 * `afterToolCall` reads the recorded arguments, which are the display form: it
	 * runs after execution and cannot change what ran, so handing it the expanded
	 * credential would only widen the blast radius to every extension that logs its
	 * arguments.
	 */
	it("hands afterToolCall the recorded display form", async () => {
		const seen: Record<string, unknown>[] = [];
		let hookSaw: unknown;
		await runCall(
			{
				transformToolCallArguments: splitTransform,
				afterToolCall: async ctx => {
					hookSaw = ctx.args.path;
					return undefined;
				},
			},
			recordingTool(seen),
			{ path: `${HANDLE}/${PLACEHOLDER}` },
		);
		expect(hookSaw).toBe(`${HANDLE_EXPANDED}/${PLACEHOLDER}`);
	});

	/**
	 * Applied once, not once per observer. A transform is allowed to be
	 * non-idempotent (appending, counting, unwrapping one layer), and a secret
	 * transform additionally logs a spend per call, so a second invocation would
	 * both corrupt the arguments and record a spend that never happened.
	 */
	it("applies the transform exactly once per call", async () => {
		const seen: Record<string, unknown>[] = [];
		let calls = 0;
		const events = await runCall(
			{
				transformToolCallArguments: args => {
					calls++;
					const path = typeof args.path === "string" ? args.path : "";
					const marked = { ...args, path: `${path}!` };
					return { display: marked, execution: marked };
				},
			},
			recordingTool(seen),
		);
		expect(calls).toBe(1);
		expect(seen).toEqual([{ path: `${HANDLE}!` }]);
		expect(startArgs(events)).toEqual({ path: `${HANDLE}!` });
	});

	/**
	 * `beforeToolCall` receives the execution object itself, which is what
	 * `BeforeToolCallContext.args` documents. Under the old ordering the hook saw a
	 * pre-transform object and the tool ran on a transformed copy, so a hook that
	 * mutated in place had its mutation silently discarded. It is an execution-side
	 * gate, so it sees the expanded credential deliberately.
	 */
	it("hands beforeToolCall the execution object, so its in-place mutations reach the tool", async () => {
		const seen: Record<string, unknown>[] = [];
		let hookSaw: unknown;
		await runCall(
			{
				transformToolCallArguments: splitTransform,
				beforeToolCall: async ctx => {
					hookSaw = ctx.args.path;
					ctx.args.path = "src/db.ts#pinned";
					return undefined;
				},
			},
			recordingTool(seen),
			{ path: `${HANDLE}/${PLACEHOLDER}` },
		);
		expect(hookSaw).toBe(`${HANDLE_EXPANDED}/${CREDENTIAL}`);
		expect(seen).toEqual([{ path: "src/db.ts#pinned" }]);
	});

	/**
	 * A mutation on the execution object must not be visible on the display form.
	 * Regression: returning `display` and `execution` as the same reference when a
	 * secret expanded would let `beforeToolCall` write a credential into the
	 * recorded arguments after the split had already protected them.
	 */
	it("keeps a beforeToolCall mutation out of the display form", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall(
			{
				transformToolCallArguments: splitTransform,
				beforeToolCall: async ctx => {
					ctx.args.path = CREDENTIAL;
					return undefined;
				},
			},
			recordingTool(seen),
			{ path: PLACEHOLDER },
		);
		expect(seen).toEqual([{ path: CREDENTIAL }]);
		expect(startArgs(events)).toEqual({ path: PLACEHOLDER });
	});

	/**
	 * A throwing transform fails the call as a tool error rather than escaping into
	 * the loop. Moving the transform out of the execution try/catch would otherwise
	 * turn a bad rewrite into an unhandled rejection that takes down the turn — and
	 * a stale-vault refusal throws here by design, so this is the path a refused
	 * expansion takes.
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
		const message = toolResult(events);
		expect(message?.isError).toBe(true);
		expect(JSON.stringify(message?.content)).toContain("codec dictionary is corrupt");
	});

	/** With no transform configured both audiences get the raw arguments, byte for byte. */
	it("leaves arguments untouched when no transform is configured", async () => {
		const seen: Record<string, unknown>[] = [];
		const events = await runCall({}, recordingTool(seen), {
			path: "src/main.ts",
		});
		expect(startArgs(events)).toEqual({ path: "src/main.ts" });
		expect(seen).toEqual([{ path: "src/main.ts" }]);
	});
});
