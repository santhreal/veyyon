/**
 * WHY. Cursor surfaces one MCP tool call on two channels at once. The assistant
 * stream carries an `mcpToolCall` content block, and the exec channel separately
 * sends `mcpArgs` for the SAME `tool_call_id`, which `handleExecServerMessage`
 * dispatches through `execHandlers.mcp` — in this process, to the caller's real
 * tool — and answers with a `toolResult`. Cursor's own exec tools are safe from
 * this because `synthesizeCursorExecToolCall` stamps their block with
 * `kCursorExecResolved`, which `agent-loop.ts` filters on. The MCP block was
 * built without that stamp, so after the turn closed the loop executed every one
 * of those calls a SECOND time.
 *
 * The defect class: a tool call the provider already dispatched and answered
 * out of band must never reach the agent loop as runnable, on ANY of the
 * channels Cursor dispatches through.
 *
 * Two ways it surfaced in one recorded session, both from the same cause. When
 * Cursor sends no `args_text_delta` for a call it has already dispatched, the
 * block keeps its initial `arguments: {}`, so the second run reached the tool's
 * validator and appended `Validation failed for tool "eval": ... Received
 * arguments: {}` as a second `toolResult` under an id that already had one.
 * When argument deltas did arrive, the second run was a real second execution of
 * a side-effecting tool. In that session 146 of 146 argument-less blocks carried
 * two results.
 *
 * What this suite does NOT catch: it drives `handleServerMessage` rather than a
 * live HTTP/2 Cursor turn, so a change to how `mcpArgs` reaches that function —
 * a new exec case, or a dispatch that bypasses it — is outside what these
 * assertions can see.
 */
import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
	type BlockState,
	createCursorUsageAccount,
	handleServerMessage,
	type InteractionUpdateView,
	processInteractionUpdate,
	type ToolCallState,
} from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, CursorExecHandlers, Model, ToolResultMessage } from "@veyyon/ai/types";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	McpArgsSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

const TOOL_CALL_ID = "call-mcp-1";

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(output: AssistantMessage): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		usage: createCursorUsageAccount(
			{
				id: "cursor-composer-2.5",
				provider: "cursor",
				api: "cursor-agent",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<"cursor-agent">,
			output,
		),
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		execDispatchedToolCalls: new Set<string>(),
	};
}

/** The `toolCallStarted` update that opens an MCP block, as Cursor sends it. */
function mcpToolCallStarted(toolCallId: string, toolName: string): InteractionUpdateView {
	return {
		message: {
			case: "toolCallStarted",
			value: {
				callId: toolCallId,
				toolCall: {
					tool: {
						case: "mcpToolCall",
						value: { args: { toolCallId, name: toolName, toolName, args: {} } },
					},
				},
			},
		},
	};
}

/** The exec-channel `mcpArgs` request that makes the provider RUN the same call. */
function mcpExecRequest(toolCallId: string, toolName: string) {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-mcp-1",
				message: {
					case: "mcpArgs",
					value: create(McpArgsSchema, { name: toolName, toolName, toolCallId, args: {} }),
				},
			}),
		},
	});
}

interface Dispatch {
	output: AssistantMessage;
	ran: string[];
	block: () => (AssistantMessage["content"][number] & CursorExecResolvedCarrier) | undefined;
}

/**
 * Drive one MCP call through both channels. `order` decides whether the
 * assistant block or the exec dispatch lands first, because the wire does not
 * guarantee either.
 */
async function driveMcpCall(order: "block-first" | "exec-first", toolName = "eval"): Promise<Dispatch> {
	const output = cursorAssistantMessage();
	const stream = new AssistantMessageEventStream();
	const state = newBlockState(output);
	const ran: string[] = [];
	const execHandlers = {
		async mcp(call: { toolCallId: string; toolName: string }) {
			ran.push(call.toolCallId);
			return {
				role: "toolResult",
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				content: [{ type: "text", text: "ran once" }],
				isError: false,
				timestamp: 1,
			} satisfies ToolResultMessage;
		},
	} as unknown as CursorExecHandlers;
	const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];

	const openBlock = () => processInteractionUpdate(mcpToolCallStarted(TOOL_CALL_ID, toolName), output, stream, state);
	const dispatchExec = () =>
		handleServerMessage(
			mcpExecRequest(TOOL_CALL_ID, toolName),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			[],
		);

	if (order === "block-first") {
		openBlock();
		await dispatchExec();
	} else {
		await dispatchExec();
		openBlock();
	}

	return {
		output,
		ran,
		block: () =>
			output.content.find(c => c.type === "toolCall" && c.id === TOOL_CALL_ID) as
				| (AssistantMessage["content"][number] & CursorExecResolvedCarrier)
				| undefined,
	};
}

describe("a Cursor MCP call the exec channel already ran", () => {
	it("is marked resolved when its block opened before the exec dispatch", async () => {
		const { ran, block } = await driveMcpCall("block-first");

		expect(ran).toEqual([TOOL_CALL_ID]);
		const found = block();
		expect(found?.type).toBe("toolCall");
		expect(found?.[kCursorExecResolved]).toBe(true);
	});

	it("is marked resolved when the exec dispatch arrived before its block", async () => {
		const { ran, block } = await driveMcpCall("exec-first");

		expect(ran).toEqual([TOOL_CALL_ID]);
		const found = block();
		expect(found?.type).toBe("toolCall");
		expect(found?.[kCursorExecResolved]).toBe(true);
	});

	it("leaves a call the exec channel never dispatched runnable", async () => {
		// The negative control the fix must not break: an MCP block Cursor opens
		// and never dispatches is the agent loop's to run, so stamping it would
		// silently drop the call instead of duplicating it.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState(output);

		processInteractionUpdate(mcpToolCallStarted(TOOL_CALL_ID, "eval"), output, stream, state);

		const found = output.content.find(c => c.type === "toolCall") as
			| (AssistantMessage["content"][number] & CursorExecResolvedCarrier)
			| undefined;
		expect(found?.type).toBe("toolCall");
		expect(found?.[kCursorExecResolved]).toBeUndefined();
	});

	it("stamps only the dispatched call when a turn carries several MCP blocks", async () => {
		// One block per turn cannot tell "stamp the call the exec channel named"
		// apart from "stamp every MCP block", and the second is the failure the
		// negative control exists to catch: it drops an undispatched call instead
		// of duplicating it. A turn with both shapes is what separates them.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState(output);
		const dispatched: string[] = [];
		const execHandlers = {
			async mcp(call: { toolCallId: string; toolName: string }) {
				dispatched.push(call.toolCallId);
				return {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					content: [{ type: "text", text: "ran once" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
		} as unknown as CursorExecHandlers;
		const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];

		processInteractionUpdate(mcpToolCallStarted("call-dispatched", "eval"), output, stream, state);
		processInteractionUpdate(mcpToolCallStarted("call-untouched", "glob"), output, stream, state);
		await handleServerMessage(
			mcpExecRequest("call-dispatched", "eval"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			[],
		);

		expect(dispatched).toEqual(["call-dispatched"]);
		const byId = new Map(
			output.content
				.filter(c => c.type === "toolCall")
				.map(c => [c.id, c as AssistantMessage["content"][number] & CursorExecResolvedCarrier]),
		);
		expect([...byId.keys()]).toEqual(["call-dispatched", "call-untouched"]);
		expect(byId.get("call-dispatched")?.[kCursorExecResolved]).toBe(true);
		expect(byId.get("call-untouched")?.[kCursorExecResolved]).toBeUndefined();
	});

	it("marks the block of a call whose arguments never streamed, which is the shape that reached the validator", async () => {
		// Cursor sends no `args_text_delta` for a call it has already dispatched,
		// so the block keeps `arguments: {}`. That is precisely the block whose
		// second run produced `Validation failed ... Received arguments: {}`
		// under an id that already had a result.
		const { block } = await driveMcpCall("block-first");

		const found = block();
		expect(found?.type === "toolCall" && found.arguments).toEqual({});
		expect(found?.[kCursorExecResolved]).toBe(true);
	});
});
