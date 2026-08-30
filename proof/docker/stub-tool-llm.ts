/**
 * An OpenAI-compatible endpoint that calls one tool, then answers.
 *
 * WHY IT EXISTS. Some rows only exist after a TOOL has run: the row that stands
 * in for a picture the terminal will not draw is written by the tool block that
 * holds the picture, so reaching it needs a turn in which the model called `read`
 * on an image. A 1.5B model asked nicely will call something else, spell the path
 * wrong, or answer in prose, and a recording cannot be retried until it complies.
 *
 * So the first chat completion streams exactly one tool call, named by
 * `TOOL_NAME` with `TOOL_ARGS` as its arguments, and every completion after it
 * streams a short reply. Everything else is the product: it decides whether the
 * call is allowed, runs the real tool against the real file, and draws the result
 * itself.
 *
 * It serves the two routes an `openai-completions` provider reaches -- the model
 * list and chat completions -- and nothing else, so a scene that strays past them
 * fails loudly rather than recording a screen built on a stub's guess.
 *
 * Not a test double: nothing under test is replaced. The provider is the thing
 * being stood in for, and the product does not know the difference.
 */

import * as http from "node:http";

const port = Number(process.argv[2] ?? 9102);
const toolName = process.env.TOOL_NAME ?? "read";
const toolArgs = process.env.TOOL_ARGS ?? '{"path":"shots/board.png"}';
const reply = process.env.TOOL_REPLY ?? "That is the dashboard mock-up.";
const modelId = process.env.TOOL_MODEL ?? "qwen2.5-1.5b";

interface ToolCallDelta {
	index: number;
	id?: string;
	type?: "function";
	function: { name?: string; arguments?: string };
}

interface Delta {
	role?: string;
	content?: string;
	tool_calls?: ToolCallDelta[];
}

let seen = 0;
let called = false;

/** One SSE frame in the chat-completions chunk shape. */
function chunk(delta: Delta, finish: string | null): string {
	const payload = {
		id: "stub-tool-completion",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function beginStream(res: http.ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.write(chunk({ role: "assistant" }, null));
}

/**
 * The call, in two frames: the name arrives with the id, the arguments after it.
 * A provider that streams them together hides a decoder that only reads the
 * first frame, and the product's own decoder is part of what is under capture.
 */
function streamToolCall(res: http.ServerResponse): void {
	beginStream(res);
	res.write(chunk({ tool_calls: [{ index: 0, id: "call_stub_1", type: "function", function: { name: toolName } }] }, null));
	res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }, null));
	res.write(chunk({}, "tool_calls"));
	res.write("data: [DONE]\n\n");
	res.end();
}

function streamReply(res: http.ServerResponse): void {
	beginStream(res);
	res.write(chunk({ content: reply }, null));
	res.write(chunk({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
}

function wholeCompletion(res: http.ServerResponse, message: Record<string, unknown>): void {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			id: "stub-tool-completion",
			object: "chat.completion",
			created: 0,
			model: modelId,
			choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
		}),
	);
}

const server = http.createServer((req, res) => {
	const url = req.url ?? "/";
	if (req.method === "GET" && url.endsWith("/models")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", owned_by: "stub" }] }));
		return;
	}
	if (req.method !== "POST" || !url.includes("/chat/completions")) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: `stub serves no ${req.method} ${url}`, type: "not_found" } }));
		return;
	}

	const body: Buffer[] = [];
	req.on("data", part => body.push(part as Buffer));
	req.on("end", () => {
		seen += 1;
		const sent = Buffer.concat(body).toString("utf8");
		const wantsStream = sent.includes('"stream":true');
		// THE FIRST REQUEST IS NOT THE TURN. A session names a title on a second
		// request of its own, with no tools in it, and it goes out first; a stub that
		// answered request one handed the tool call to the title generator, which
		// discards it, and the turn under capture then got the plain reply and drew no
		// tool block at all. The turn is the request that carries the tool list.
		const isTurn = sent.includes('"tools":[');
		const callsTool = isTurn && !called;
		if (callsTool) called = true;
		process.stderr.write(
			`stub-tool-llm: request ${seen} answered ${callsTool ? toolName : "text"} (turn=${isTurn}, stream=${wantsStream})\n`,
		);
		if (wantsStream) {
			if (callsTool) streamToolCall(res);
			else streamReply(res);
			return;
		}
		wholeCompletion(
			res,
			callsTool
				? {
						role: "assistant",
						content: null,
						tool_calls: [{ id: "call_stub_1", type: "function", function: { name: toolName, arguments: toolArgs } }],
					}
				: { role: "assistant", content: reply },
		);
	});
});

server.listen(port, "127.0.0.1", () => {
	process.stderr.write(`stub-tool-llm: listening on 127.0.0.1:${port}, calling ${toolName} once with ${toolArgs}\n`);
});
