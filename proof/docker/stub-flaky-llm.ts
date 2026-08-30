/**
 * An OpenAI-compatible endpoint that fails a fixed number of times, then answers.
 *
 * WHY IT EXISTS. Some of the product's sentences are only reachable through a
 * turn that recovered — the retry summary is written when a turn succeeded after
 * a transient provider failure — and no weights on any machine can be asked to
 * fail twice on cue. A scene that needs that state starts this instead of the
 * llama.cpp container: the first `FLAKY_FAILURES` chat completions answer 503,
 * and every request after them streams a short completion. The turn is the
 * product's own: real request, real backoff, real recovery, real status line.
 *
 * TWO RETRY LAYERS, AND ONLY THE OUTER ONE IS VISIBLE. A 503 is transient to the
 * HTTP transport, which retries it six times per turn without telling the
 * session anything, so a handful of failures recovers invisibly and no summary
 * is ever written. The summary belongs to the session's own retry loop, which
 * only sees an error the transport gave up on. So a scene that wants N retries
 * in the summary asks for `6 * N` failures, and the 503 carries `retry-after: 0`
 * so the transport's own backoff does not add a minute of waiting to a recording.
 *
 * It serves the two routes an `openai-completions` provider reaches — the model
 * list and chat completions — and nothing else, so a scene that strays past them
 * fails loudly rather than recording a screen built on a stub's guess.
 *
 * Not a test double: nothing under test is replaced. The provider is the thing
 * being stood in for, and the product does not know the difference.
 */

import * as http from "node:http";

const port = Number(process.argv[2] ?? 9101);
const failures = Number(process.env.FLAKY_FAILURES ?? 2);
const reply = process.env.FLAKY_REPLY ?? "Recovered, and here is the answer.";
const modelId = process.env.FLAKY_MODEL ?? "qwen2.5-1.5b";

let seen = 0;

/** One SSE frame in the chat-completions chunk shape. */
function chunk(delta: Record<string, string>, finish: string | null): string {
	const payload = {
		id: "stub-completion",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamCompletion(res: http.ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	res.write(chunk({ role: "assistant" }, null));
	res.write(chunk({ content: reply }, null));
	res.write(chunk({}, "stop"));
	res.write("data: [DONE]\n\n");
	res.end();
}

function wholeCompletion(res: http.ServerResponse): void {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({
			id: "stub-completion",
			object: "chat.completion",
			created: 0,
			model: modelId,
			choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
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
		if (seen <= failures) {
			// 503 is in the canonical transient set, so the product retries the same
			// request against the same credential — which is the state under capture.
			// `retry-after: 0` is honoured by the transport's hint extraction, which
			// keeps a twelve-failure scene inside a recording's patience.
			res.writeHead(503, { "Content-Type": "application/json", "retry-after": "0" });
			res.end(
				JSON.stringify({
					error: { message: "Upstream temporarily unavailable, please retry.", type: "server_error" },
				}),
			);
			process.stderr.write(`stub-flaky-llm: request ${seen} answered 503\n`);
			return;
		}
		const wantsStream = Buffer.concat(body).toString("utf8").includes('"stream":true');
		process.stderr.write(`stub-flaky-llm: request ${seen} answered 200 (stream=${wantsStream})\n`);
		if (wantsStream) streamCompletion(res);
		else wholeCompletion(res);
	});
});

server.listen(port, "127.0.0.1", () => {
	process.stderr.write(`stub-flaky-llm: listening on 127.0.0.1:${port}, failing the first ${failures} completions\n`);
});
