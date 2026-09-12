/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * Cursor's `shellStreamArgs` exec request forwards a running command's stdout and stderr to the
 * server as `shellStream` frames. The provider buffers each stream and sends on three triggers —
 * a newline, more than 4 KiB held, or 100 ms after the first byte arrived — and it holds back an
 * ANSI escape whose tail has not arrived yet, so `\x1b[3` followed by `1mred\x1b[0m` reaches the
 * sanitizer as one sequence and is stripped whole instead of leaking `[3` and `1m` as text.
 *
 * The class: stdout and stderr were two hand-copied closure pairs with their own timer and buffer,
 * and now share one `ShellOutputChannel`. This suite drives the REAL exec dispatch
 * (`handleServerMessage` → `handleShellStreamArgs`) with a handler that pushes chunks in the
 * shapes a shell produces, decodes the frames written to the HTTP/2 stream, and pins:
 *
 * 1. a chunk without a newline is held, and the newline that completes it sends one frame;
 * 2. a split escape is held past the 100 ms timer and stripped whole once its tail arrives;
 * 3. a held chunk with no newline is sent by the timer before the handler pushes again;
 * 4. more than 4 KiB without a newline is sent at once;
 * 5. stderr rides its own channel and its own frame case;
 * 6. what the handler leaves held is sent before the `exit` event, then `shellResult`, then
 *    `streamClose`.
 *
 * What it does not catch: the batch (`shell`) fallback, which sends the whole result after the
 * command ends and is covered by `cursor-exec-handlers.test.ts`, and how Cursor's server renders
 * the frames it receives.
 */
import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { CursorExecHandlers, ToolResultMessage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	ShellArgsSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { cursorAssistantMessage, newBlockState } from "./helpers/cursor-stream-harness";

/** One decoded client frame: the stream event it carried, or the control message that ended it. */
type Frame =
	| { kind: "start" }
	| { kind: "stdout"; data: string }
	| { kind: "stderr"; data: string }
	| { kind: "exit"; code: number }
	| { kind: "shellResult" }
	| { kind: "streamClose" }
	| { kind: "other"; name: string };

function decodeFrame(buffer: Buffer): Frame {
	const message = fromBinary(AgentClientMessageSchema, new Uint8Array(buffer.subarray(5)));
	if (message.message.case === "execClientControlMessage") {
		const control = message.message.value.message;
		return control.case === "streamClose"
			? { kind: "streamClose" }
			: { kind: "other", name: `control:${control.case}` };
	}
	if (message.message.case !== "execClientMessage") return { kind: "other", name: `${message.message.case}` };
	const exec = message.message.value.message;
	if (exec.case === "shellResult") return { kind: "shellResult" };
	if (exec.case !== "shellStream") return { kind: "other", name: `${exec.case}` };
	const event = exec.value.event;
	switch (event.case) {
		case "start":
			return { kind: "start" };
		case "stdout":
			return { kind: "stdout", data: event.value.data };
		case "stderr":
			return { kind: "stderr", data: event.value.data };
		case "exit":
			return { kind: "exit", code: event.value.code };
		default:
			return { kind: "other", name: `event:${event.case}` };
	}
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 1,
	};
}

/** Drive one `shellStreamArgs` request through the real dispatch; `frames` fills as the provider writes. */
async function runShellStream(
	frames: Frame[],
	shellStream: NonNullable<CursorExecHandlers["shellStream"]>,
): Promise<void> {
	const output = cursorAssistantMessage();
	const state = newBlockState(output);
	const h2Request = {
		write: (chunk: Buffer) => {
			frames.push(decodeFrame(chunk));
			return true;
		},
	} as unknown as Parameters<typeof handleServerMessage>[5];
	const serverMessage = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 7,
				execId: "exec-shell-stream-1",
				message: {
					case: "shellStreamArgs",
					value: create(ShellArgsSchema, {
						command: "printf",
						workingDirectory: "/repo",
						toolCallId: "call-shell-1",
					}),
				},
			}),
		},
	});
	await handleServerMessage(
		serverMessage,
		output,
		new AssistantMessageEventStream(),
		state,
		new Map(),
		h2Request,
		{ shellStream },
		undefined,
		[],
	);
}

function outputFrames(frames: Frame[]): Frame[] {
	return frames.filter(frame => frame.kind === "stdout" || frame.kind === "stderr");
}

/**
 * The exit the provider reports for a handler that returned normally. A throw inside the handler —
 * including a failed `expect` — is turned into a failure result by the dispatch, so every
 * observation is snapshotted inside the handler and asserted out here, after this exit is pinned.
 */
const CLEAN_EXIT: Frame = { kind: "exit", code: 0 };

describe("a Cursor shell stream holds a split escape until it completes", () => {
	it("sends a line once its newline arrives and strips an escape that arrived in two chunks", async () => {
		const frames: Frame[] = [];
		let heldPastTimer: Frame[] = [];
		await runShellStream(frames, async (args, callbacks) => {
			callbacks.onStdout("par");
			callbacks.onStdout("tial\n");
			callbacks.onStdout("\x1b[3");
			// Past the 100 ms timer: the escape prefix is still held, not sent as text.
			await sleep(150);
			heldPastTimer = outputFrames(frames);
			callbacks.onStdout("1mred\x1b[0m\n");
			callbacks.onStderr("warn\n");
			return toolResult(args.toolCallId);
		});
		expect(frames).toContainEqual(CLEAN_EXIT);
		expect(heldPastTimer).toEqual([{ kind: "stdout", data: "partial\n" }]);
		expect(outputFrames(frames)).toEqual([
			{ kind: "stdout", data: "partial\n" },
			{ kind: "stdout", data: "red\n" },
			{ kind: "stderr", data: "warn\n" },
		]);
	});

	it("sends a held chunk on the timer, and more than 4 KiB at once, without waiting for a newline", async () => {
		const frames: Frame[] = [];
		const big = "x".repeat(4097);
		let onPush: Frame[] = [];
		let afterTimer: Frame[] = [];
		let afterBig: Frame[] = [];
		await runShellStream(frames, async (args, callbacks) => {
			callbacks.onStdout("slow");
			onPush = outputFrames(frames);
			await sleep(150);
			afterTimer = outputFrames(frames);
			callbacks.onStdout(big);
			afterBig = outputFrames(frames);
			return toolResult(args.toolCallId);
		});
		expect(frames).toContainEqual(CLEAN_EXIT);
		expect(onPush).toEqual([]);
		expect(afterTimer).toEqual([{ kind: "stdout", data: "slow" }]);
		expect(afterBig).toEqual([
			{ kind: "stdout", data: "slow" },
			{ kind: "stdout", data: big },
		]);
	});

	it("sends what the handler left held before the exit event, then the result and the stream close", async () => {
		const frames: Frame[] = [];
		await runShellStream(frames, async (args, callbacks) => {
			callbacks.onStdout("done: ");
			callbacks.onStderr("tail");
			return toolResult(args.toolCallId);
		});
		expect(frames).toContainEqual(CLEAN_EXIT);
		expect(frames.map(frame => frame.kind)).toEqual([
			"start",
			"stdout",
			"stderr",
			"exit",
			"shellResult",
			"streamClose",
		]);
		expect(outputFrames(frames)).toEqual([
			{ kind: "stdout", data: "done: " },
			{ kind: "stderr", data: "tail" },
		]);
	});
});
