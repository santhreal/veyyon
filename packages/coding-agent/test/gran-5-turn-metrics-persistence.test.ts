/**
 * GRAN-5: per-turn timing/throughput survives into the durable session file.
 *
 * Why this suite exists:
 *   The loop captures `turnMetrics` on the finalized assistant message (proven end
 *   to end in @veyyon/agent-core's agent-loop.test.ts), and the pure level→field
 *   math is locked in @veyyon/ai's instrumentation.test.ts. The remaining risk is
 *   the persistence layer: `turnMetrics` is a NEW field on the assistant message,
 *   and the session write path (`truncateForPersistence`, reasoning-signature
 *   stripping) reshapes messages. If that path dropped the field, the study record
 *   would silently lose every turn's latency and throughput. These tests prove the
 *   metrics round-trip through a real write + fresh reload with EXACT values.
 *
 * The contract locked in:
 *   - An assistant message carrying `turnMetrics` persists it verbatim; a fresh
 *     `SessionManager.open` recovers the exact request-start, ttft, token counts,
 *     and throughput from the on-disk JSONL.
 *   - The raw JSONL line itself contains the metrics (not just an in-memory view).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import { captureAssistantTurnMetrics } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

function assistantWithTurnMetrics(): AssistantMessage {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const turnMetrics = captureAssistantTurnMetrics({
		level: "ultra",
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_002_000, // 2000ms turn
		status: "ok",
		ttftMs: 500, // 1500ms generation window
		usage: {
			input: 100,
			output: 300,
			cacheRead: 20,
			cacheWrite: 10,
			totalTokens: 430,
			reasoningTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		upstreamProvider: "Anthropic",
	});
	if (!turnMetrics) throw new Error("Expected turnMetrics at ultra");
	return {
		role: "assistant",
		content: [{ type: "text", text: "instrumented turn" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 300,
			cacheRead: 20,
			cacheWrite: 10,
			totalTokens: 430,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_002_000,
		ttft: 500,
		duration: 2_000,
		turnMetrics,
	};
}

function firstAssistant(entries: readonly SessionEntry[]): AssistantMessage {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") return entry.message as AssistantMessage;
	}
	throw new Error("Expected a persisted assistant message");
}

describe("GRAN-5: turn metrics persist into the session file", () => {
	it("round-trips turnMetrics through a real write + fresh reload with exact values", async () => {
		const dir = TempDir.createSync("gran5-persist-");
		try {
			const cwd = dir.path();
			const sessionDir = path.join(cwd, "sessions");
			const manager = SessionManager.create(cwd, sessionDir);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file path");

			manager.appendMessage(assistantWithTurnMetrics());
			manager.flushSync();
			await manager.close();

			const reopened = await SessionManager.open(sessionFile, sessionDir);
			const assistant = firstAssistant(reopened.getEntries());
			const m = assistant.turnMetrics;
			if (!m) throw new Error("turnMetrics did not survive persistence");
			expect(m.level).toBe("ultra");
			expect(m.status).toBe("ok");
			expect(m.startedAt).toBe(1_700_000_000_000);
			expect(m.endedAt).toBe(1_700_000_002_000);
			expect(m.durationMs).toBe(2_000);
			expect(m.ttftMs).toBe(500);
			expect(m.outputTokens).toBe(300);
			expect(m.inputTokens).toBe(100);
			expect(m.totalTokens).toBe(430);
			expect(m.generationMs).toBe(1_500);
			expect(m.outputTokensPerSec).toBe(200); // 300 / 1.5s
			expect(m.cacheReadTokens).toBe(20);
			expect(m.cacheWriteTokens).toBe(10);
			expect(m.reasoningTokens).toBe(40);
			expect(m.upstreamProvider).toBe("Anthropic");
			await reopened.close();

			// The raw JSONL line itself carries the metrics, not just an in-memory view.
			const raw = fs.readFileSync(sessionFile, "utf8");
			expect(raw).toContain('"turnMetrics"');
			expect(raw).toContain('"outputTokensPerSec":200');
		} finally {
			dir.removeSync();
		}
	});
});
