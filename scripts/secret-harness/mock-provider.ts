#!/usr/bin/env bun
/**
 * OpenAI-compatible provider stand-in for the `/secret` container harness.
 *
 * WHY A FAKE PROVIDER AT ALL. Three of the `/secret` behaviours that matter most
 * — a placeholder actually being expanded into a tool's arguments, the
 * secret-use boundary asking before that happens, and the literal text arriving
 * after a revocation — are only reachable through a real model turn that emits a
 * real tool call. Nothing in the CLI produces a tool call on its own, and a
 * hosted model cannot be part of a hermetic container run. This serves the exact
 * `openai-completions` wire shape veyyon consumes, so every layer below the HTTP
 * boundary (session, obfuscator, tool wrapper, approval gate) is shipped code.
 *
 * WHY IT LOGS EVERY REQUEST BODY VERBATIM. The bytes this server receives are
 * the bytes veyyon sent to a provider. Appending them to `HARNESS_WIRE_LOG`
 * turns "no credential reached the provider" from an inspection of veyyon's own
 * stdout into an assertion over real network traffic. It is also where the
 * harness reads a blocked tool call's error text from, since a tool result is
 * carried back to the provider on the next request.
 *
 * ONE TOOL CALL PER CONVERSATION. The turn is chosen from the request itself: a
 * body that already carries a `tool` role message is the follow-up after the
 * call ran (or failed), so it gets a plain text ending. Keying off the request
 * rather than a counter keeps the server correct when veyyon retries, and keeps
 * one run from inheriting another's state.
 *
 * THE TOOL CALL IS RE-READ FROM DISK ON EVERY REQUEST. The harness drives every
 * approval mode against one long-lived server and rewrites the spec file between
 * scenarios. Reading it per request rather than once at startup is what makes
 * that safe: a scenario can never measure a server still holding the previous
 * scenario's arguments.
 */

import * as fs from "node:fs";

/**
 * File holding `{"name":"<tool>","arguments":"<raw JSON text>"}`, or `{}` for
 * "answer with plain text and never call a tool".
 */
const SPEC_PATH = process.env.HARNESS_TOOL_SPEC ?? "";
const WIRE_LOG = process.env.HARNESS_WIRE_LOG ?? "";
const PORT = Number(process.env.HARNESS_MOCK_PORT ?? "8899");
const MODEL_ID = process.env.HARNESS_MODEL_ID ?? "harness-model";

/** Text the model "says" once the tool turn is over. The harness asserts it, as proof the turn ran to completion. */
const FINAL_TEXT = "HARNESS_TURN_COMPLETE";

interface ToolSpec {
	name?: string;
	/** Raw JSON text, forwarded byte for byte as `function.arguments`. */
	arguments?: string;
}

interface ChatMessage {
	role?: unknown;
}

interface ChatRequest {
	messages?: readonly ChatMessage[];
	stream?: unknown;
}

function readToolSpec(): ToolSpec {
	if (SPEC_PATH === "") return {};
	try {
		return JSON.parse(fs.readFileSync(SPEC_PATH, "utf8")) as ToolSpec;
	} catch {
		// A missing or half-written spec means "no tool call" rather than a 500: a
		// crashed server would look to the harness like a blocked tool call, which
		// is the one confusion this file must never cause.
		return {};
	}
}

function appendWireLog(kind: string, body: string): void {
	if (WIRE_LOG === "") return;
	fs.appendFileSync(WIRE_LOG, `${kind} ${body}\n`);
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
	return {
		id: "chatcmpl-harness",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

/**
 * The whole SSE chunk sequence for one turn.
 *
 * Both turns end with a usage-only chunk because `isOpenAICompletionsProgressChunk`
 * treats terminal usage as progress, and a host that omits it leaves veyyon's
 * idle watchdog governing the tail of every turn.
 */
function turnChunks(spec: ToolSpec, wantsToolCall: boolean): Record<string, unknown>[] {
	const usage = {
		id: "chatcmpl-harness",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: MODEL_ID,
		choices: [],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	if (!wantsToolCall) {
		return [
			chunk({ role: "assistant", content: "" }, null),
			chunk({ content: FINAL_TEXT }, null),
			chunk({}, "stop"),
			usage,
		];
	}
	return [
		chunk({ role: "assistant", content: "" }, null),
		chunk({ tool_calls: [{ index: 0, ...toolCallPayload(spec) }] }, null),
		chunk({}, "tool_calls"),
		usage,
	];
}

/** The `function` entry both the streaming and non-streaming shapes carry, so they cannot drift. */
function toolCallPayload(spec: ToolSpec): Record<string, unknown> {
	return {
		id: "call_harness_1",
		type: "function",
		function: { name: spec.name, arguments: spec.arguments ?? "{}" },
	};
}

function sseResponse(chunks: readonly Record<string, unknown>[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const item of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

/** Non-streaming shape, for any caller that asks for one (title generation, health probes). */
function jsonCompletion(spec: ToolSpec, wantsToolCall: boolean): Response {
	const message = wantsToolCall
		? { role: "assistant", content: null, tool_calls: [toolCallPayload(spec)] }
		: { role: "assistant", content: FINAL_TEXT };
	return Response.json({
		id: "chatcmpl-harness",
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: MODEL_ID,
		choices: [
			{
				index: 0,
				message,
				finish_reason: wantsToolCall ? "tool_calls" : "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname.endsWith("/models") && request.method === "GET") {
			appendWireLog("GET", url.pathname);
			return Response.json({
				object: "list",
				data: [{ id: MODEL_ID, object: "model", max_model_len: 200_000 }],
			});
		}

		const raw = await request.text();
		appendWireLog(`${request.method} ${url.pathname}`, raw);

		let body: ChatRequest = {};
		try {
			body = JSON.parse(raw) as ChatRequest;
		} catch {
			// A body veyyon did not send as JSON is still logged above; answer with the
			// closing turn rather than a 400 so a probe cannot hang the run.
			return sseResponse(turnChunks({}, false));
		}

		const spec = readToolSpec();
		const alreadyRanTool = (body.messages ?? []).some(message => message.role === "tool");
		const wantsToolCall = typeof spec.name === "string" && spec.name !== "" && !alreadyRanTool;
		const chunks = turnChunks(spec, wantsToolCall);

		if (body.stream === true) return sseResponse(chunks);
		return jsonCompletion(spec, wantsToolCall);
	},
});

process.stderr.write(`mock-provider listening on http://127.0.0.1:${server.port} spec=${SPEC_PATH || "(none)"}\n`);
