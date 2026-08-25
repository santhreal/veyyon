/**
 * Measures the per-delta snapshot cost on the message_update path.
 *
 * Streams one tool call over 1,500 deltas and times consuming the whole event
 * stream. Two argument shapes isolate what the snapshot clone actually pays
 * for: `string` accumulates one long string (clones share string references,
 * so cost stays flat), while `nodes` grows a parsed-JSON-shaped tree of items
 * (clone cost scales with node count, the realistic worst case for large
 * structured payloads like todo lists).
 *
 * Run: BENCH_SHAPE=string|nodes bun run bench/snapshot.bench.ts (from packages/agent)
 */
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "@veyyon/agent-core/types";
import type { AssistantMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

const DELTAS = 1500;
const CHUNK = "x".repeat(96); // ~144 KB of accumulated arguments

function identityConverter(messages: unknown[]): unknown[] {
	return messages;
}

function partialWith(content: unknown[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason: "toolUse",
		api: "mock",
		usage: { cost: {} },
	} as unknown as AssistantMessage;
}

function streamTurn0(shape: "string" | "nodes"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	// Local mutable block mirroring what providers do: replace `arguments`
	// wholesale as the streaming parser grows the buffer.
	let accumulated = "";
	const block = {
		type: "toolCall" as const,
		id: "bench-tc",
		name: "bash",
		arguments: {} as Record<string, unknown>,
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: partialWith([block]) });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: partialWith([block]) });
		for (let i = 0; i < DELTAS; i++) {
			accumulated += CHUNK;
			block.arguments =
				shape === "string"
					? { input: accumulated }
					: {
							items: Array.from({ length: Math.floor(i / 4) }, (_, k) => ({
								id: k,
								name: `task-${k}`,
								status: "pending",
								meta: { priority: k % 5 },
							})),
						};
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: CHUNK, partial: partialWith([block]) });
		}
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: partialWith([block]) });
		stream.push({ type: "done", reason: "toolUse", message: partialWith([block]) });
	});
	return stream;
}

function streamTurn1(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: partialWith([{ type: "text", text: "done" }]) });
		stream.push({ type: "done", reason: "stop", message: partialWith([{ type: "text", text: "done" }]) });
	});
	return stream;
}

async function once(shape: "string" | "nodes"): Promise<number> {
	let turn = 0;
	const context: AgentContext = { systemPrompt: ["bench"], messages: [], tools: [] } as AgentContext;
	const mock = createMockModel();
	const config = { model: mock.model, convertToLlm: identityConverter } as unknown as AgentLoopConfig;
	const start = performance.now();
	const stream = agentLoop(
		[{ role: "user", content: "go", timestamp: Date.now() }] as never,
		context,
		config,
		undefined,
		() => (turn++ === 0 ? streamTurn0(shape) : streamTurn1()),
	);
	for await (const _event of stream as AsyncIterable<AgentEvent>) {
		// Drain.
	}
	return performance.now() - start;
}

const shape = process.env.BENCH_SHAPE === "nodes" ? ("nodes" as const) : ("string" as const);
// Warmup (JIT + allocator), then measure.
await once(shape);
await once(shape);
const runs = [await once(shape), await once(shape), await once(shape)];
console.log(
	`shape=${shape} deltas=${DELTAS} chunk=${CHUNK.length}B runs_ms=[${runs.map(r => r.toFixed(0)).join(", ")}] median_ms=${runs
		.slice()
		.sort((a, b) => a - b)[1]!
		.toFixed(0)}`,
);
