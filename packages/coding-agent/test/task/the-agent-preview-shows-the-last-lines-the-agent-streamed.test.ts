/**
 * WHY: the live preview of a running agent (`progress.recentOutput`, the lines the agent HUD and the
 * task card draw) is derived from the agent's streamed text. A streamed delta only appends to the
 * tail buffer; the lines are derived when a progress snapshot is taken, and the buffer is cut back
 * only once it holds twice the window. Deriving the lines on every delta re-split the whole 8 KB
 * window per token once an answer passed 8 KB, which was most of what a long agent answer cost its
 * parent.
 *
 * The class this closes: any snapshot that disagrees with the preview defined on the whole stream —
 * the last eight non-blank lines of the last 8 KB of decoded output since the message started,
 * newest first — whatever the delta sizes, line shapes, buffer cuts, content replacements and
 * message restarts in between. Every op of a seeded stream is followed by a forced snapshot, and each
 * snapshot is compared with that definition computed from the full text.
 *
 * Not caught: the decoding of argot handles (argot-agent-stream-display.test.ts owns that seam), and
 * the cost of a delta, which a value comparison cannot see; the bench in the change measures it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@veyyon/coding-agent/task/types";
import { createMockSession, createSessionResult } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const WINDOW = 8 * 1024;
const LINES = 8;

/** The preview defined on the whole decoded stream. */
function expectedPreview(stream: string): string[] {
	return stream
		.slice(-WINDOW)
		.split("\n")
		.filter(line => line.trim())
		.slice(-LINES)
		.reverse();
}

type Op =
	| { kind: "delta"; text: string }
	| { kind: "replace"; blocks: string[] }
	| { kind: "end"; blocks: string[] }
	| { kind: "restart" };

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 2 ** 32;
	};
}

/** Line shapes that move the preview: prose, blank, whitespace-only (including NBSP and CR), CRLF, and lines longer than the window. */
function streamText(random: () => number, chars: number): string {
	const shapes = [
		() => `step ${Math.floor(random() * 1000)} checks the layout of column ${Math.floor(random() * 90)}\n`,
		() => "\n",
		() => "   \t\n",
		() => "\u00a0\n",
		() => "\r\n",
		() => `windows line ${Math.floor(random() * 50)}\r\n`,
		() => `${"x".repeat(WINDOW + 700)}\n`,
		() => `no newline yet ${Math.floor(random() * 10)} `,
	];
	let text = "";
	while (text.length < chars) text += shapes[Math.floor(random() * shapes.length)]!();
	return text.slice(0, chars);
}

/** A seeded stream: deltas of every size up to past twice the window, with content replacements, message ends and restarts between them. */
function seededOps(seed: number): Op[] {
	const random = rng(seed);
	const sizes = [1, 3, 17, 200, 1500, 4096, WINDOW + 1, 2 * WINDOW + 5];
	const ops: Op[] = [];
	for (let i = 0; i < 120; i++) {
		const pick = random();
		if (pick < 0.85)
			ops.push({ kind: "delta", text: streamText(random, sizes[Math.floor(random() * sizes.length)]!) });
		else if (pick < 0.91)
			ops.push({
				kind: "replace",
				blocks: [streamText(random, 600), streamText(random, Math.floor(random() * 3 * WINDOW))],
			});
		else if (pick < 0.93) ops.push({ kind: random() < 0.5 ? "replace" : "end", blocks: [] });
		else if (pick < 0.96) ops.push({ kind: "end", blocks: [streamText(random, Math.floor(random() * 2 * WINDOW))] });
		else ops.push({ kind: "restart" });
	}
	return ops;
}

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

/**
 * Run `ops` through the real executor against a scripted child, forcing a snapshot after each op.
 * Returns each forced snapshot's preview beside the preview defined on the stream at that point.
 */
async function runOps(id: string, ops: Op[]): Promise<{ seen: string[][]; expected: string[][] }> {
	const seen: string[][] = [];
	const expected: string[][] = [];
	let capture = false;
	const onProgress = (progress: AgentProgress) => {
		if (capture) seen.push([...progress.recentOutput]);
	};
	const session = createMockSession(({ promptIndex, emit }) => {
		if (promptIndex !== 1) return;
		let stream = "";
		emit({ type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
		for (const op of ops) {
			if (op.kind === "delta") {
				stream += op.text;
				emit({
					type: "message_update",
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", delta: op.text },
				} as unknown as AgentSessionEvent);
			} else if (op.kind === "replace") {
				stream = op.blocks.join("");
				emit({
					type: "message_update",
					message: { role: "assistant", content: op.blocks.map(text => ({ type: "text", text })) },
				} as unknown as AgentSessionEvent);
			} else if (op.kind === "end") {
				stream = op.blocks.join("");
				emit({
					type: "message_end",
					message: { role: "assistant", content: op.blocks.map(text => ({ type: "text", text })) },
				} as unknown as AgentSessionEvent);
			} else {
				stream = "";
				emit({ type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
			}
			// A retry event flushes the progress card synchronously, so this snapshot is the state the op left.
			capture = true;
			emit({ type: "retry_fallback_succeeded", model: "mock/model" } as unknown as AgentSessionEvent);
			capture = false;
			expected.push(expectedPreview(stream));
		}
	});
	vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
	await runSubprocess({
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		onProgress,
	});
	return { seen, expected };
}

describe("the live agent preview", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const seed of [1, 7, 42, 1009]) {
		it(`matches the last lines of the stream at every snapshot (seed ${seed})`, async () => {
			const ops = seededOps(seed);
			const { seen, expected } = await runOps(`preview-${seed}`, ops);
			expect(seen.length).toBe(ops.length);
			for (let i = 0; i < ops.length; i++)
				expect({ op: i, preview: seen[i] }).toEqual({ op: i, preview: expected[i]! });
		});
	}

	it("follows a stream of one-character deltas across both buffer cuts", async () => {
		// One character at a time past twice the window: every delta between the cuts lands on a
		// buffer longer than the window, which the snapshot has to read only the end of.
		const text = streamText(rng(5), 2 * WINDOW + 900).replaceAll("x".repeat(WINDOW + 700), "long");
		const ops: Op[] = [...text].map(ch => ({ kind: "delta", text: ch }));
		const { seen, expected } = await runOps("preview-chars", ops);
		expect(seen.length).toBe(ops.length);
		for (let i = 0; i < ops.length; i++)
			expect({ op: i, preview: seen[i] }).toEqual({ op: i, preview: expected[i]! });
	});
});
