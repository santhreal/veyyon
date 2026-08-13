import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	type ToolBatchLedger,
} from "@veyyon/agent-core/tool-batch-ledger";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { AssistantMessage, Message, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { kCursorExecResolved, setStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

/**
 * A batch of tool calls that is cut short must report which calls ran and which
 * did not. Without that inventory the model cannot tell a transport reset from
 * a tool failure, so its cheapest safe move is to re-run discovery and reload
 * context: the expensive half of the original defect, not the failed turn.
 *
 * These tests drive the real loop and assert on the strings the model reads.
 */

const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function toolResultTexts(events: AgentEvent[]): string[] {
	const seen = new Set<string>();
	const texts: string[] = [];
	for (const event of events) {
		if (event.type !== "message_end" || event.message.role !== "toolResult") continue;
		const message = event.message as ToolResultMessage;
		if (seen.has(message.toolCallId)) continue;
		seen.add(message.toolCallId);
		texts.push(message.content.map(part => (part.type === "text" ? part.text : "")).join("\n"));
	}
	return texts;
}

/**
 * The one ledger a cut-short batch produces.
 *
 * `required` is false only for a turn the operator aborted. An abort is the
 * operator's own action, so the loop owes the model no explanation of it, and
 * whether a ledger appears depends on what survived: a batch whose calls were
 * all retained still gets one naming them as never run, while a turn left with
 * nothing to inventory gets none. Those rows assert on the retained turn rather
 * than on ledger prose. What holds either way is that there is never more than
 * one ledger, never one per call.
 */
function ledgerBlock(texts: string[], required = true): string {
	const found = texts.filter(text => text.includes("Partial completion ledger"));
	if (required) expect(found).toHaveLength(1);
	else expect(found.length).toBeLessThanOrEqual(1);
	return found[0] ?? "";
}

describe("partial completion ledger on a provider stream abort", () => {
	it("names the tool call that ran and the ones that never ran, and keeps the completed result", async () => {
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [
				// Cursor's exec channel already ran this call server-side and its
				// buffered result landed in the transcript before the reset.
				{
					role: "toolResult",
					toolCallId: "exec-done-1",
					toolName: "read",
					content: [{ type: "text", text: "REAL_TOOL_OUTPUT_THAT_MUST_NOT_BE_ECHOED".repeat(20) }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				} satisfies ToolResultMessage,
			],
			tools: [],
		};
		const config: AgentLoopConfig = { model: createMockModel().model, convertToLlm: identityConverter };

		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const execResolved = {
					type: "toolCall" as const,
					id: "exec-done-1",
					name: "read",
					arguments: { path: "a.ts" },
					[kCursorExecResolved]: true as const,
				};
				const dropped = [
					{ type: "toolCall" as const, id: "call-b", name: "grep", arguments: { pattern: "x" } },
					{ type: "toolCall" as const, id: "call-c", name: "glob", arguments: { path: "**/*.ts" } },
				];
				const partial: AssistantMessage = {
					role: "assistant",
					content: [execResolved, ...dropped],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial });
				// Every call finished streaming its arguments, so all three survive
				// `retainCompletedToolCalls` and reach the abort branch.
				partial.content.forEach((block, contentIndex) => {
					if (block.type !== "toolCall") return;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
				});
				const errored: AssistantMessage = {
					...partial,
					stopReason: "error",
					errorMessage: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
				};
				stream.push({ type: "error", reason: "error", error: errored });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		const texts = toolResultTexts(events);
		const ledger = ledgerBlock(texts);

		// Red before the fix: no ledger existed at all, so every assertion below
		// failed on `expect(found).toHaveLength(1)` in `ledgerBlock`.
		expect(ledger).toContain("Partial completion ledger for this tool batch (3 calls): 1 ran, 2 never ran.");
		expect(ledger).toContain(
			"Cause: the provider stream ended before the remaining calls were dispatched. That is a transport failure, not a tool failure.",
		);
		// "ran and failed" vs "never ran" is the distinction the model acts on.
		expect(ledger).toContain("- ran, ok: exec-done-1 (read)");
		expect(ledger).toContain("- never ran: call-b (grep)");
		expect(ledger).toContain("- never ran: call-c (glob)");
		expect(ledger).toContain('Only the calls marked "never ran" need retrying; they had no side effects.');

		// Bounded: the ledger is ids and outcomes, never a re-dump of tool output.
		expect(ledger).not.toContain("REAL_TOOL_OUTPUT_THAT_MUST_NOT_BE_ECHOED");
		expect(ledger.length).toBeLessThan(700);

		// The completed result survives the abort with its content intact.
		const survivor = context.messages.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === "exec-done-1",
		);
		expect(survivor?.content[0]).toEqual({
			type: "text",
			text: "REAL_TOOL_OUTPUT_THAT_MUST_NOT_BE_ECHOED".repeat(20),
		});

		// Structured form for consumers that must not string-match.
		const structured = events
			.filter(
				(e): e is Extract<AgentEvent, { type: "message_end" }> =>
					e.type === "message_end" && e.message.role === "toolResult",
			)
			.map(e => (e.message as ToolResultMessage<{ batchLedger?: ToolBatchLedger }>).details?.batchLedger)
			.find(entry => entry !== undefined);
		expect(structured).toMatchObject({ cause: "stream_error", completed: 1, dropped: 2, interrupted: 0 });
	});
});

describe("partial completion ledger on a mid-batch interrupt", () => {
	it("separates the calls that ran and failed from the calls that never ran", async () => {
		const schema = type({ value: "string" });
		const ran: string[] = [];
		const makeTool = (name: string, fail: boolean): AgentTool<typeof schema, { value: string }> => ({
			name,
			label: name,
			description: name,
			parameters: schema,
			// Serialize the batch so the interrupt lands after the first two calls
			// instead of racing every call into the same microtask.
			concurrency: "exclusive",
			async execute(_id, params) {
				ran.push(name);
				// A tool signals failure by throwing; the loop turns that into an
				// `isError` result rather than discarding it.
				if (fail) throw new Error(`BIG_FAILURE_BODY_${params.value}`.repeat(20));
				return {
					content: [{ type: "text", text: `BIG_SUCCESS_BODY_${params.value}`.repeat(20) }],
					details: { value: params.value },
				};
			},
		});

		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [makeTool("alpha", false), makeTool("beta", true), makeTool("gamma", false), makeTool("delta", false)],
		};
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
			// Steering appears once two calls have run: the remaining two are
			// dropped before dispatch.
			hasSteeringMessages: async () => ran.length >= 2,
		};

		let turn = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const content =
					turn++ === 0
						? [
								{ type: "toolCall" as const, id: "t-alpha", name: "alpha", arguments: { value: "1" } },
								{ type: "toolCall" as const, id: "t-beta", name: "beta", arguments: { value: "2" } },
								{ type: "toolCall" as const, id: "t-gamma", name: "gamma", arguments: { value: "3" } },
								{ type: "toolCall" as const, id: "t-delta", name: "delta", arguments: { value: "4" } },
							]
						: [{ type: "text" as const, text: "done" }];
				const message: AssistantMessage = {
					role: "assistant",
					content,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: turn === 1 ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(ran).toEqual(["alpha", "beta"]);

		const texts = toolResultTexts(events);
		const ledger = ledgerBlock(texts);

		// Red before the fix: the skipped results said only "Skipped due to
		// queued user message", with no inventory, so `ledgerBlock` found zero
		// ledgers and each `toContain` below had nothing to match.
		expect(ledger).toContain("Partial completion ledger for this tool batch (4 calls): 2 ran, 2 never ran.");
		expect(ledger).toContain("- ran, ok: t-alpha (alpha)");
		expect(ledger).toContain("- ran, failed: t-beta (beta)");
		expect(ledger).toContain("- never ran: t-gamma (gamma)");
		expect(ledger).toContain("- never ran: t-delta (delta)");
		expect(ledger).toContain(
			'Results for the calls marked "ran" are already in this transcript, including the failed ones. Do not re-run them.',
		);

		// Bounded: no tool output, successful or failed, is re-dumped.
		expect(ledger).not.toContain("BIG_SUCCESS_BODY");
		expect(ledger).not.toContain("BIG_FAILURE_BODY");

		// The results that did complete are not discarded by the interrupt.
		const emitted = events.filter(
			(e): e is Extract<AgentEvent, { type: "message_end" }> =>
				e.type === "message_end" && e.message.role === "toolResult",
		);
		const alpha = emitted.find(e => (e.message as ToolResultMessage).toolCallId === "t-alpha")
			?.message as ToolResultMessage;
		const beta = emitted.find(e => (e.message as ToolResultMessage).toolCallId === "t-beta")
			?.message as ToolResultMessage;
		expect(alpha.isError).toBeFalsy();
		expect(alpha.content[0]).toMatchObject({ text: "BIG_SUCCESS_BODY_1".repeat(20) });
		expect(beta.isError).toBe(true);
		expect(beta.content[0]).toMatchObject({ text: "BIG_FAILURE_BODY_2".repeat(20) });
	});
});

/**
 * Drive one stream-error turn and return the ledger text plus the assistant
 * message the loop kept, so a test can assert on both halves of the contract.
 */
async function runStreamErrorTurn(options: {
	blocks: AssistantMessage["content"];
	completeIds: string[];
	messages?: AgentMessage[];
	/**
	 * Raw accumulated argument JSON per tool-call id, written to the block's
	 * `kStreamingPartialJson` marker the way every delta-streaming provider does.
	 * The harness leaves it unset by default, which is the Google-style shape:
	 * whole call objects, no marker, and therefore no evidence either way.
	 */
	partialJson?: Record<string, string>;
	/**
	 * Abort the request after the blocks are on the wire instead of ending in a
	 * transport error, and deliver every `toolcall_end` AFTER the abort so the
	 * loop discards them unprocessed. This is the operator's case: a steering
	 * interrupt, not a dead socket.
	 */
	abortAfterBlocks?: boolean;
}): Promise<{ ledger: string; assistant: AssistantMessage; events: AgentEvent[] }> {
	const context: AgentContext = {
		systemPrompt: [""],
		messages: options.messages ?? [],
		tools: [],
	};
	const config: AgentLoopConfig = { model: createMockModel().model, convertToLlm: identityConverter };
	const controller = new AbortController();
	const streamFn = () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(async () => {
			const partial: AssistantMessage = {
				role: "assistant",
				content: options.blocks,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				usage: NO_USAGE,
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			for (const block of partial.content) {
				if (block.type !== "toolCall") continue;
				const raw = options.partialJson?.[block.id];
				if (raw !== undefined) setStreamingPartialJson(block, raw);
			}
			stream.push({ type: "start", partial });
			if (options.abortAfterBlocks) {
				// The loop has to SEE the blocks first, the way it does in a real turn: it
				// records the streaming partial as it arrives and only then meets the abort.
				// Draining the microtask queue is how that ordering is expressed without a
				// timer; aborting in the same tick as the push would test a turn that never
				// received the call at all, which is a different (and already covered) case.
				for (let drain = 0; drain < 20; drain++) await Promise.resolve();
				// Abort first, THEN deliver the close events. The loop checks the signal
				// before it processes the event it has already pulled, so these arrive and
				// are thrown away: the exact sequence that made a finished call look unfinished.
				controller.abort();
				partial.content.forEach((block, contentIndex) => {
					if (block.type !== "toolCall") return;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
				});
				return;
			}
			partial.content.forEach((block, contentIndex) => {
				if (block.type !== "toolCall" || !options.completeIds.includes(block.id)) return;
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
			});
			stream.push({
				type: "error",
				reason: "error",
				error: {
					...partial,
					stopReason: "error",
					errorMessage: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
				},
			});
		});
		return stream;
	};

	const events: AgentEvent[] = [];
	for await (const event of agentLoop([createUserMessage("go")], context, config, controller.signal, streamFn)) {
		events.push(event);
	}
	// The finalized assistant turn is the last `message_end` carrying it: that is
	// the exact object the loop persists and replays to the model.
	const assistant = events
		.filter((e): e is Extract<AgentEvent, { type: "message_end" }> => e.type === "message_end")
		.map(e => e.message)
		.findLast((m): m is AssistantMessage => m.role === "assistant");
	if (!assistant) throw new Error("the loop emitted no assistant message");
	return { ledger: ledgerBlock(toolResultTexts(events), !options.abortAfterBlocks), assistant, events };
}

/**
 * Locks out the residual left by the first ledger pass: a tool call still
 * streaming its arguments when the reset lands is deleted outright by
 * `retainCompletedToolCalls`, so it has no `toolCall` block, no `tool_result`,
 * and no mention anywhere. The model then reads a turn in which it never asked
 * for that tool, and the work silently disappears.
 *
 * If this regresses, `incompleteToolCalls` stops being recorded and the ledger
 * loses the only line naming the vanished call.
 */
describe("a tool call whose arguments never finished streaming", () => {
	it("is named in the ledger and marked as having no arguments left to copy", async () => {
		const { ledger, assistant } = await runStreamErrorTurn({
			blocks: [
				{ type: "toolCall", id: "call-a", name: "grep", arguments: { pattern: "x" } },
				// Arguments were still arriving: no `toolcall_end` for this id.
				{ type: "toolCall", id: "call-b", name: "bash", arguments: { command: "npm ru" } },
			],
			completeIds: ["call-a"],
		});

		expect(ledger).toContain("Partial completion ledger for this tool batch (2 calls): 0 ran, 2 never ran.");
		expect(ledger).toContain("- never ran: call-a (grep)");
		expect(ledger).toContain("- never ran, arguments never finished: call-b (bash)");
		expect(ledger).toContain(
			'The calls marked "arguments never finished" were cut off while their arguments were still being written, so no record of them is left in this transcript. Reconstruct their arguments rather than copying them back.',
		);
		// The truncated arguments must not travel with the name: they are the one
		// thing the model must not treat as what it asked for.
		expect(ledger).not.toContain("npm ru");

		// The block itself is still deleted, because partial arguments are unsafe
		// to run and an unpaired `tool_use` breaks replay. Only the identity is kept.
		expect(assistant.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual(["call-a"]);
		expect(assistant.incompleteToolCalls).toEqual([{ id: "call-b", name: "bash" }]);
	});

	it("keeps its ledger line when it is the only incomplete call beside a surviving one", async () => {
		// The one-dropped-call shortcut returns no ledger, because that call's own
		// placeholder describes it. An incomplete call has no placeholder, so the
		// shortcut must not swallow it. The lone-incomplete-call turn, where there
		// is no placeholder at all to carry the ledger, is covered further down.
		const { ledger, assistant } = await runStreamErrorTurn({
			blocks: [
				{ type: "toolCall", id: "call-only", name: "read", arguments: {} },
				{ type: "toolCall", id: "call-cut", name: "write", arguments: { path: "a" } },
			],
			completeIds: ["call-only"],
		});

		expect(ledger).toContain("- never ran, arguments never finished: call-cut (write)");
		expect(assistant.incompleteToolCalls).toEqual([{ id: "call-cut", name: "write" }]);
	});
});

/**
 * A missing `toolcall_end` is not evidence the provider stopped mid-argument.
 *
 * WHY THIS SUITE EXISTS. An operator interrupted a turn holding two fully written
 * `bash` calls and the ledger told the model both had "arguments never finished"
 * and that "no record of them is left in this transcript. Reconstruct their
 * arguments rather than copying them back". Every word of that was false, and the
 * arguments it described were deleted in the same pass. The abort is decided
 * locally: `runLoop` tests `requestSignal.aborted` before it processes the event
 * it has already pulled, so a steering interrupt discards delivered events,
 * including the `toolcall_end` of a call whose last argument byte had arrived.
 * Completeness therefore cannot be read off that event.
 *
 * WHAT THESE ROWS PIN. Completeness is judged from the block's own accumulated
 * `kStreamingPartialJson`: parses to an object means the provider finished, and
 * the call is retained with those parsed arguments. Truncated JSON, a payload
 * that is not an object, and an absent marker all stay incomplete, the last one
 * deliberately, since a provider that never writes a marker tells us nothing.
 *
 * WHAT THEY DO NOT PIN. Whether the retained call is later re-run or answered
 * from cache is the batch-continuation contract, covered in
 * `unreplayable-batch-continue.test.ts`. These rows only assert the turn the
 * model reads back.
 */
describe("a tool call the abort never closed, whose arguments are provably complete", () => {
	const COMPLETE_ARGS = { command: "bun run check:ts", timeout: 600 };

	it("keeps both calls, with their parsed arguments, and calls neither unfinished", async () => {
		const { assistant } = await runStreamErrorTurn({
			blocks: [
				{ type: "toolCall", id: "call-a", name: "bash", arguments: {} },
				{ type: "toolCall", id: "call-b", name: "bash", arguments: {} },
			],
			completeIds: [],
			partialJson: {
				"call-a": JSON.stringify(COMPLETE_ARGS),
				"call-b": JSON.stringify({ command: "git status", timeout: 30 }),
			},
			abortAfterBlocks: true,
		});

		const calls = assistant.content.filter(block => block.type === "toolCall");
		expect(calls.map(block => block.id)).toEqual(["call-a", "call-b"]);
		// The arguments the model wrote come back verbatim, not as the tolerant
		// partial parse a streaming block carries while it is still being written.
		expect(calls[0]?.arguments).toEqual(COMPLETE_ARGS);
		expect(calls[1]?.arguments).toEqual({ command: "git status", timeout: 30 });
		expect(assistant.incompleteToolCalls ?? []).toEqual([]);
	});

	it("still reports an unfinished call when the accumulated JSON is truncated", async () => {
		const { assistant } = await runStreamErrorTurn({
			blocks: [
				{ type: "toolCall", id: "call-done", name: "bash", arguments: {} },
				{ type: "toolCall", id: "call-cut", name: "bash", arguments: { command: "npm ru" } },
			],
			completeIds: [],
			partialJson: {
				"call-done": JSON.stringify(COMPLETE_ARGS),
				// The provider stopped mid-string: this cannot parse, and guessing at it
				// is exactly what the ledger's advisory exists to prevent.
				"call-cut": '{"command": "npm ru',
			},
			abortAfterBlocks: true,
		});

		expect(assistant.content.filter(block => block.type === "toolCall").map(block => block.id)).toEqual([
			"call-done",
		]);
		expect(assistant.incompleteToolCalls).toEqual([{ id: "call-cut", name: "bash" }]);
	});

	/**
	 * The wording the operator actually read, on the path that produces one. A dead
	 * transport ends the same batch with a ledger, so this row is where the sentence
	 * "arguments never finished" is pinned to the call it is true of and kept off the
	 * call it is not.
	 */
	it("names only the truncated call as unfinished, and keeps the settled one as an ordinary never-ran", async () => {
		const { ledger, assistant } = await runStreamErrorTurn({
			blocks: [
				{ type: "toolCall", id: "call-done", name: "bash", arguments: {} },
				{ type: "toolCall", id: "call-cut", name: "bash", arguments: { command: "npm ru" } },
			],
			completeIds: [],
			partialJson: {
				"call-done": JSON.stringify(COMPLETE_ARGS),
				"call-cut": '{"command": "npm ru',
			},
		});

		expect(ledger).toContain("- never ran: call-done (bash)");
		expect(ledger).toContain("- never ran, arguments never finished: call-cut (bash)");
		expect(ledger).not.toContain("arguments never finished: call-done");
		expect(ledger).not.toContain("npm ru");

		const settled = assistant.content.find(block => block.type === "toolCall" && block.id === "call-done");
		expect(settled?.type === "toolCall" ? settled.arguments : undefined).toEqual(COMPLETE_ARGS);
		expect(assistant.incompleteToolCalls).toEqual([{ id: "call-cut", name: "bash" }]);
	});

	it("does not read a marker that parses to something other than an object as complete", async () => {
		// A bare scalar or array is not an argument set. Accepting one would hand the
		// tool layer a shape it cannot spread, so the conservative answer stands.
		for (const raw of ["null", "42", '"done"', "[1,2]"]) {
			const { assistant } = await runStreamErrorTurn({
				blocks: [{ type: "toolCall", id: "call-odd", name: "bash", arguments: {} }],
				completeIds: [],
				partialJson: { "call-odd": raw },
				abortAfterBlocks: true,
			});

			expect(assistant.incompleteToolCalls, `marker ${raw}`).toEqual([{ id: "call-odd", name: "bash" }]);
		}
	});

	it("leaves a provider that writes no marker exactly as it was", async () => {
		// Google-style providers deliver whole call objects and never accumulate
		// deltas, so an absent marker is silence, not a completion signal.
		const { assistant } = await runStreamErrorTurn({
			blocks: [{ type: "toolCall", id: "call-silent", name: "bash", arguments: { command: "ls" } }],
			completeIds: [],
			abortAfterBlocks: true,
		});

		expect(assistant.incompleteToolCalls).toEqual([{ id: "call-silent", name: "bash" }]);
	});
});
/**
 * The third outcome, and the reason the vocabulary is not a boolean: a call
 * that ran server-side but whose result has not landed is neither "safe to
 * retry verbatim" nor "already answered". Telling the model either one is a
 * false statement, and for a side-effecting tool the first is the dangerous
 * direction.
 *
 * If this regresses, a Cursor exec call cut off before its buffered result is
 * reported as never having run, and the model re-runs a write or a shell
 * command that already executed.
 */
describe("a call that started and has no recorded outcome", () => {
	it("is reported as started with no result, not as never run", async () => {
		const execResolved = {
			type: "toolCall" as const,
			id: "exec-pending",
			name: "bash",
			arguments: { command: "rm -rf build" },
			[kCursorExecResolved]: true as const,
		};
		// No `toolResult` for `exec-pending` anywhere in the context: the exec
		// handler was still running when the stream died.
		const { ledger } = await runStreamErrorTurn({
			blocks: [execResolved, { type: "toolCall", id: "call-z", name: "glob", arguments: { path: "*" } }],
			completeIds: ["exec-pending", "call-z"],
		});

		expect(ledger).toContain(
			"Partial completion ledger for this tool batch (2 calls): 0 ran, 1 interrupted, 1 never ran.",
		);
		expect(ledger).toContain("- started, no result recorded: exec-pending (bash)");
		expect(ledger).toContain("- never ran: call-z (glob)");
		expect(ledger).toContain(
			'The calls marked "started, no result recorded" may have applied partial side effects. Check state before retrying them.',
		);
		// The three advisory lines are mutually exclusive claims. Nothing ran to
		// completion here, so the "already in this transcript" line must be absent.
		expect(ledger).not.toContain("are already in this transcript");
	});
});

/**
 * The ledger is attached to a tool result the model reads on every retry, so an
 * unbounded one is a second copy of the payload it describes. That is the exact
 * shape of the defect it exists to fix, so the caps are asserted directly
 * rather than inferred from a small example.
 */
describe("ledger bounds", () => {
	it("lists at most 24 calls and counts the rest", () => {
		const calls = Array.from({ length: 30 }, (_value, index) => ({
			toolCallId: `call-${index}`,
			toolName: "read",
			outcome: "dropped" as const,
		}));

		const ledger = buildToolBatchLedger("stream_error", calls);
		const text = renderToolBatchLedger(ledger);

		// Literal 24, not the exported constant: the cap is the contract, and a
		// test written against the constant follows it wherever it is moved to.
		expect(ledger.entries).toHaveLength(24);
		expect(ledger.dropped).toBe(30);
		expect(ledger.omitted).toBe(6);
		expect(text).toContain("(30 calls): 0 ran, 30 never ran.");
		expect(text).toContain("- never ran: call-23 (read)");
		expect(text).not.toContain("call-24");
		expect(text).toContain("- (+6 more calls not listed)");
	});

	it("clips a hostile id and tool name to the field budget", () => {
		const ledger = buildToolBatchLedger("aborted", [
			{ toolCallId: "x".repeat(400), toolName: "y".repeat(400), outcome: "dropped" },
			{ toolCallId: "second", toolName: "read", outcome: "ok" },
		]);
		const text = renderToolBatchLedger(ledger);

		expect(ledger.entries[0]?.toolCallId).toBe(`${"x".repeat(47)}…`);
		expect(ledger.entries[0]?.toolName).toBe(`${"y".repeat(47)}…`);
		expect(text).not.toContain("x".repeat(49));
		// Two calls, two clipped fields, three advisory lines: the whole block stays
		// small enough that re-reading it costs nothing next to the batch it describes.
		expect(text.length).toBeLessThan(700);
	});
});

/**
 * LOCKS OUT: a ledger that renders the four outcomes into a block whose exact
 * text is wrong, and a ledger that echoes any part of a tool call's payload.
 *
 * The per-outcome describes above each drive a batch that exhibits ONE or TWO
 * outcomes and assert with `toContain`. Nothing pinned what the block actually
 * looks like when all four apply at once, which is precisely the case the model
 * has to read correctly: the three advisory sentences are mutually exclusive
 * CLAIMS about different calls, and emitting them in the wrong order, twice, or
 * with one missing turns a retry instruction into a contradiction. Every
 * `toContain` in this file passes against a block whose lines are shuffled or
 * duplicated, so the whole rendering is pinned here byte for byte.
 *
 * If this regresses: the model reads "only the calls marked never ran need
 * retrying" attached to a batch where a side-effecting call is marked
 * "started, no result recorded", and re-runs it; or the block silently starts
 * carrying arguments and becomes a second copy of the payload it describes,
 * which is the defect the ledger exists to avoid.
 */
describe("a batch that exhibits every outcome at once", () => {
	it("renders exactly one block with the four labels and the three advisories in order", () => {
		const ledger = buildToolBatchLedger("stream_error", [
			{ toolCallId: "c-ok", toolName: "read", outcome: "ok" },
			{ toolCallId: "c-failed", toolName: "grep", outcome: "failed" },
			{ toolCallId: "c-started", toolName: "bash", outcome: "interrupted" },
			{ toolCallId: "c-never", toolName: "glob", outcome: "dropped" },
			{ toolCallId: "c-partial", toolName: "edit", outcome: "dropped", argumentsIncomplete: true },
		]);

		// "ok" and "failed" both count as ran: the split the model needs is
		// ran/interrupted/never-ran, not success/failure.
		expect(ledger).toEqual({
			cause: "stream_error",
			completed: 2,
			interrupted: 1,
			dropped: 2,
			omitted: 0,
			entries: [
				{ toolCallId: "c-ok", toolName: "read", outcome: "ok" },
				{ toolCallId: "c-failed", toolName: "grep", outcome: "failed" },
				{ toolCallId: "c-started", toolName: "bash", outcome: "interrupted" },
				{ toolCallId: "c-never", toolName: "glob", outcome: "dropped" },
				{ toolCallId: "c-partial", toolName: "edit", outcome: "dropped", argumentsIncomplete: true },
			],
		});

		// The whole block, not a sample of it. Order is the contract: counts,
		// cause, inventory in emission order, then the advisories keyed to the
		// outcomes that are actually present.
		expect(renderToolBatchLedger(ledger)).toBe(
			[
				"Partial completion ledger for this tool batch (5 calls): 2 ran, 1 interrupted, 2 never ran.",
				"Cause: the provider stream ended before the remaining calls were dispatched. That is a transport failure, not a tool failure.",
				"- ran, ok: c-ok (read)",
				"- ran, failed: c-failed (grep)",
				"- started, no result recorded: c-started (bash)",
				"- never ran: c-never (glob)",
				"- never ran, arguments never finished: c-partial (edit)",
				'Results for the calls marked "ran" are already in this transcript, including the failed ones. Do not re-run them.',
				'The calls marked "started, no result recorded" may have applied partial side effects. Check state before retrying them.',
				'Only the calls marked "never ran" need retrying; they had no side effects.',
				'The calls marked "arguments never finished" were cut off while their arguments were still being written, so no record of them is left in this transcript. Reconstruct their arguments rather than copying them back.',
			].join("\n"),
		);
	});

	it("carries no argument bytes from the calls it describes, end to end", async () => {
		// Driven through the real loop so the arguments genuinely exist on the
		// assistant turn: a renderer that grew an `arguments` field, or a caller
		// that started passing one through `toolName`, fails here.
		const secret = "rm -rf /srv/prod --force --no-preserve-root";
		const { ledger, assistant } = await runStreamErrorTurn({
			blocks: [
				{ type: "toolCall", id: "call-danger", name: "bash", arguments: { command: secret } },
				{ type: "toolCall", id: "call-next", name: "read", arguments: { path: "/etc/shadow" } },
			],
			completeIds: ["call-danger", "call-next"],
		});

		// The control: the arguments really are on the turn the model replays,
		// so their absence from the ledger is the ledger's doing.
		expect(JSON.stringify(assistant.content)).toContain(secret);

		expect(ledger).not.toContain(secret);
		expect(ledger).not.toContain("--force");
		expect(ledger).not.toContain("/etc/shadow");
		// The whole placeholder the model reads, pinned: the per-call reason line
		// the loop writes, then the one ledger block. Nothing else, and nothing
		// from either call's arguments.
		expect(ledger).toBe(
			[
				"Tool call was not executed because the provider stream ended with an error before the tool could run: Stream closed with error code NGHTTP2_INTERNAL_ERROR",
				"",
				"Partial completion ledger for this tool batch (2 calls): 0 ran, 2 never ran.",
				"Cause: the provider stream ended before the remaining calls were dispatched. That is a transport failure, not a tool failure.",
				"- never ran: call-danger (bash)",
				"- never ran: call-next (read)",
				'Only the calls marked "never ran" need retrying; they had no side effects.',
			].join("\n"),
		);
		// The block rides along on every retry of the batch, so its size is part
		// of the contract rather than an incidental of this fixture.
		expect(ledger.length).toBeLessThan(600);
	});
});

/**
 * LOCKS OUT: the ledger being built and then thrown away in the one case it was
 * written for.
 *
 * A turn whose ONLY tool call was still streaming its arguments when the stream
 * reset has its `toolCall` block deleted by `retainCompletedToolCalls`, so the
 * loop's `toolCalls` list is empty, no placeholder result is created, and the
 * ledger was handed to nobody and dropped, even though its own comment says a
 * lone incomplete call is "the only place it is named at all". The model then read a
 * turn in which it never asked for that tool: no block, no result, no mention.
 *
 * If this regresses, the loop stops delivering the ledger as a turn-level
 * notice and a cut-off call vanishes from the transcript without a trace.
 */
describe("a cut-short turn that left no placeholder to carry the ledger", () => {
	it("delivers the ledger as a turn-level notice when the only call had incomplete arguments", async () => {
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createMockModel().model, convertToLlm: identityConverter };
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial: AssistantMessage = {
					role: "assistant",
					// No `toolcall_end` for this id: its arguments were still arriving.
					content: [{ type: "toolCall", id: "call-lone", name: "bash", arguments: { command: "npm ru" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial });
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...partial,
						stopReason: "error",
						errorMessage: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
					},
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		// The control for the whole defect: there is no placeholder result at all,
		// because the only `toolCall` block was deleted. Anything attached to a
		// tool result cannot reach the model here.
		expect(toolResultTexts(events)).toEqual([]);

		const notices = events.flatMap(event =>
			event.type === "message_end" && event.message.role === "user" && event.message.synthetic === true
				? [event.message.content]
				: [],
		);
		// Exactly one notice, and its whole text: the counts line, the transport
		// cause, the vanished call by id and name, and the instruction to
		// reconstruct the arguments rather than copy them back.
		expect(notices).toEqual([
			[
				"Partial completion ledger for this tool batch (1 call): 0 ran, 1 never ran.",
				"Cause: the provider stream ended before the remaining calls were dispatched. That is a transport failure, not a tool failure.",
				"- never ran, arguments never finished: call-lone (bash)",
				'Only the calls marked "never ran" need retrying; they had no side effects.',
				'The calls marked "arguments never finished" were cut off while their arguments were still being written, so no record of them is left in this transcript. Reconstruct their arguments rather than copying them back.',
			].join("\n"),
		]);
		// The truncated arguments must not travel with the name.
		expect(notices[0]).not.toContain("npm ru");
	});

	it("adds no notice when a lone call with complete arguments already has its own placeholder", async () => {
		// The other half of the contract: the turn-level path must not become a
		// second copy of what a placeholder already says. A single dropped call
		// with complete arguments keeps its block and gets a placeholder, so it
		// needs no ledger and no notice.
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: createMockModel().model, convertToLlm: identityConverter };
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial: AssistantMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-solo", name: "read", arguments: { path: "a" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: partial.content[0] as never, partial });
				stream.push({
					type: "error",
					reason: "error",
					error: { ...partial, stopReason: "error", errorMessage: "NGHTTP2_INTERNAL_ERROR" },
				});
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(toolResultTexts(events)).toEqual([
			"Tool call was not executed because the provider stream ended with an error before the tool could run: NGHTTP2_INTERNAL_ERROR",
		]);
		expect(
			events.filter(e => e.type === "message_end" && e.message.role === "user" && e.message.synthetic === true),
		).toEqual([]);
	});
});

/**
 * LOCKS OUT: a tool cut off INSIDE `tool.execute()` being told to retry itself
 * verbatim.
 *
 * `record.entered` exists to separate "cut off waiting for approval, nothing
 * ran, safe to retry verbatim" from "cut off mid-execution, side effects may be
 * half applied". That distinction was carried only by the batch ledger, and the
 * ledger is suppressed for a one-call batch, so a lone `bash` interrupted after
 * it started running received the plain skip text ending "retry the skipped
 * tool if it is still needed", an instruction to re-run a command that may
 * have partly executed, which for a side-effecting tool is the dangerous
 * direction.
 *
 * If this regresses, the entered flag stops reaching the placeholder text and a
 * half-applied command gets double-applied on the retry.
 */
describe("a single call cut off after it entered execution", () => {
	it("tells the model to check state instead of retrying the tool verbatim", async () => {
		const schema = type({ value: "string" });
		let entered = false;
		const bash: AgentTool<typeof schema, { value: string }> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: schema,
			// Interruptible so steering aborts it while it is running, which is the
			// case that can leave half-applied side effects behind.
			interruptible: true,
			async execute(_id, _params, signal) {
				entered = true;
				await new Promise<void>(resolve => {
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("aborted mid-run");
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [bash] };
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
			hasSteeringMessages: async () => entered,
			getSteeringMessages: async () => [],
		};

		let turn = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const content =
					turn++ === 0
						? [{ type: "toolCall" as const, id: "t-bash", name: "bash", arguments: { value: "1" } }]
						: [{ type: "text" as const, text: "done" }];
				const message: AssistantMessage = {
					role: "assistant",
					content,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: turn === 1 ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(entered).toBe(true);
		// The whole placeholder the model reads, pinned. Red before the fix: the
		// last sentence was "After the queued message is handled on the next step,
		// retry the skipped tool if it is still needed."
		expect(toolResultTexts(events)).toEqual([
			[
				"Skipped due to queued user message.",
				"Do not count this skipped result as completed work or verification.",
				"This tool had already started running when it was cut off, so it may have applied partial side effects.",
				"Check state before retrying it.",
				"After the queued message is handled on the next step, decide from that state whether a retry is still needed.",
			].join(" "),
		]);
		expect(toolResultTexts(events)[0]).not.toContain("retry the skipped tool if it is still needed");
		// A one-call batch still gets no ledger: it has no siblings to inventory,
		// so a ledger there would only restate the placeholder above. The
		// side-effect warning no longer depends on it.
		expect(toolResultTexts(events)[0]).not.toContain("Partial completion ledger");
	});
});

/**
 * LOCKS OUT: the ledger reporting a call cut off mid-execution as one that ran.
 *
 * The tail sweep keyed each outcome off `record.toolResultMessage`, but a call
 * whose `tool.execute()` was aborted mid-flight is answered eagerly with a
 * skipped placeholder, so it HAS a result message with `isError` true. It was
 * therefore inventoried as "ran, failed", under an advisory saying its result is
 * already in the transcript and it must not be re-run. Both halves are false:
 * nothing usable ran, and its side effects may be half applied.
 *
 * If this regresses, the model is told a half-run side-effecting call completed
 * and is instructed not to check it.
 */
describe("a batch with one call cut off mid-execution and one never dispatched", () => {
	it("inventories the cut-off call as started with no result, not as one that ran", async () => {
		const schema = type({ value: "string" });
		let entered = false;
		const bash: AgentTool<typeof schema, { value: string }> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters: schema,
			interruptible: true,
			// Serialize so `read` is still undispatched when the interrupt lands.
			concurrency: "exclusive",
			async execute(_id, _params, signal) {
				entered = true;
				await new Promise<void>(resolve => {
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("aborted mid-run");
			},
		};
		const read: AgentTool<typeof schema, { value: string }> = {
			name: "read",
			label: "read",
			description: "read",
			parameters: schema,
			concurrency: "exclusive",
			async execute() {
				throw new Error("read must never be dispatched in this batch");
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [bash, read] };
		const config: AgentLoopConfig = {
			model: createMockModel().model,
			convertToLlm: identityConverter,
			hasSteeringMessages: async () => entered,
			getSteeringMessages: async () => [],
		};

		let turn = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const content =
					turn++ === 0
						? [
								{ type: "toolCall" as const, id: "t-bash", name: "bash", arguments: { value: "1" } },
								{ type: "toolCall" as const, id: "t-read", name: "read", arguments: { value: "2" } },
							]
						: [{ type: "text" as const, text: "done" }];
				const message: AssistantMessage = {
					role: "assistant",
					content,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					usage: NO_USAGE,
					stopReason: turn === 1 ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		for await (const event of agentLoop([createUserMessage("go")], context, config, undefined, streamFn)) {
			events.push(event);
		}

		expect(entered).toBe(true);
		const ledger = ledgerBlock(toolResultTexts(events));
		// Red before the fix: "0 ran" was "1 ran", the bash line read
		// "- ran, failed: t-bash (bash)", and the block carried the advisory
		// 'Results for the calls marked "ran" are already in this transcript'.
		expect(ledger).toBe(
			[
				"Skipped due to queued user message. Do not count this skipped result as completed work or verification. After the queued message is handled on the next step, retry the skipped tool if it is still needed.",
				"",
				"Partial completion ledger for this tool batch (2 calls): 0 ran, 1 interrupted, 1 never ran.",
				"Cause: the batch was interrupted before the remaining calls were dispatched.",
				"- started, no result recorded: t-bash (bash)",
				"- never ran: t-read (read)",
				'The calls marked "started, no result recorded" may have applied partial side effects. Check state before retrying them.',
				'Only the calls marked "never ran" need retrying; they had no side effects.',
			].join("\n"),
		);
	});
});
