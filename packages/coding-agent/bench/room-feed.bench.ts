/**
 * Room feed bench: what one window rebuild costs while its conversation works.
 *
 * A room window's snapshot is rebuilt after every session event that changes
 * it, which while a turn streams is every token. Each rebuild used to read
 * every message of the exchange again: the display transform (secrets, argot)
 * over each assistant message, text sanitizing, and each tool call's argument
 * summary. A stored message never changes, so the feed now keeps each one's
 * blocks and a rebuild reads only what is new.
 *
 *   off: `buildRoomWindowSnapshot` with no block cache: every message read on
 *        every rebuild, which is the pre-change behavior.
 *   on:  the same call with the feed's cache, warmed by the first rebuild, as a
 *        `RoomWindowFeed` makes it.
 *
 * Both arms rebuild the same real `AgentSession` (a stored exchange of one
 * prompt and `rounds` assistant turns, each with a paragraph of text, two tool
 * calls and their results). Exact parity: every rebuild of the on arm is
 * deep-equal to the off arm's, or the bench fails.
 *
 * Run: `bun packages/coding-agent/bench/room-feed.bench.ts`.
 */

import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	buildRoomWindowSnapshot,
	type RoomBlockCache,
} from "@veyyon/coding-agent/modes/terminal/controllers/room-window-feed";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { benchFail, benchStats } from "@veyyon/utils/bench-harness";
import { type } from "arktype";

const REBUILDS = 400;
const WARMUP = 20;
const ROUNDS = [5, 20, 80] as const;

let clock = 1_000;

function tool(name: string, label: string): AgentTool {
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: ++clock,
	};
}

/** One prompt and `rounds` assistant turns, each a paragraph, a read and a command, both answered. */
function exchange(rounds: number): AgentMessage[] {
	const messages: AgentMessage[] = [
		{ role: "user", content: "refactor the parser into a tokenizer", timestamp: ++clock },
	];
	for (let round = 0; round < rounds; round++) {
		const text =
			`Step ${round}: the tokenizer now owns its state machine, and the parser reads tokens through one iterator. `.repeat(
				4,
			);
		messages.push(
			assistant([
				{ type: "text", text },
				{ type: "toolCall", id: `r${round}`, name: "read", arguments: { path: `src/parser/part-${round}.ts` } },
				{
					type: "toolCall",
					id: `b${round}`,
					name: "bash",
					arguments: { command: `bun test test/parser/${round}` },
				},
			]),
		);
		for (const [id, toolName] of [
			[`r${round}`, "read"],
			[`b${round}`, "bash"],
		] as const) {
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName,
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: ++clock,
			});
		}
	}
	return messages;
}

await initTheme();
const temp = TempDir.createSync("@veyyon-room-feed-bench-");
const auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
auth.setRuntimeApiKey("anthropic", "bench-key");
const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) benchFail("the bundled anthropic model is missing");

console.log("| Exchange | Arm | mean µs | p50 µs | p95 µs |");
console.log("|---|---|---|---|---|");
try {
	for (const rounds of ROUNDS) {
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Bench"],
					tools: [tool("read", "Read"), tool("bash", "Run Command")],
					messages: exchange(rounds),
				},
			}),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const cache: RoomBlockCache = { blocks: new Map() };
		const samples: Record<"off" | "on", number[]> = { off: [], on: [] };
		for (let i = 0; i < WARMUP + REBUILDS; i++) {
			let start = performance.now();
			const off = buildRoomWindowSnapshot(session);
			const offMs = performance.now() - start;
			start = performance.now();
			const on = buildRoomWindowSnapshot(session, {}, cache);
			const onMs = performance.now() - start;
			if (!isDeepStrictEqual(off, on)) benchFail(`${rounds} rounds: the cached rebuild differs from a fresh one`);
			if (i >= WARMUP) {
				samples.off.push(offMs);
				samples.on.push(onMs);
			}
		}
		for (const arm of ["off", "on"] as const) {
			const stats = benchStats(samples[arm]);
			const us = (ms: number): string => (ms * 1000).toFixed(1);
			const label = arm === "off" ? "off: every message read" : "on:  stored blocks kept";
			console.log(
				`| 1 prompt, ${rounds} turns | ${label} | ${us(stats.mean)} | ${us(stats.p50)} | ${us(stats.p95)} |`,
			);
		}
		await session.dispose();
	}
} finally {
	auth.close();
	temp.removeSync();
}
