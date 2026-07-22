/**
 * GRAN-6: exact per-turn request params survive into the durable session file.
 *
 * Why this suite exists:
 *   The loop attaches `request` (the sampling/reasoning/tool-choice params AS SENT)
 *   to the finalized assistant message, proven end to end in @veyyon/agent-core's
 *   agent-loop.test.ts, with the field-selection logic locked in @veyyon/ai's
 *   instrumentation.test.ts. The remaining risk is the persistence layer: `request`
 *   is a NEW field on the assistant message, and if the session write path dropped
 *   it a backtest could not reproduce the request that produced a turn. These tests
 *   prove it round-trips through a real write + fresh reload with EXACT values.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import { captureAssistantTurnRequest } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

function assistantWithRequest(): AssistantMessage {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	const request = captureAssistantTurnRequest({
		level: "ultra",
		temperature: 0.7,
		topP: 0.95,
		topK: 40,
		maxTokens: 4096,
		presencePenalty: 0.1,
		reasoningEffort: "high",
		disableReasoning: false,
		toolChoice: { type: "tool", name: "bash" },
		serviceTier: "priority",
	});
	if (!request) throw new Error("Expected request params at ultra");
	return {
		role: "assistant",
		content: [{ type: "text", text: "turn with params" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_003_000,
		request,
	};
}

function firstAssistant(entries: readonly SessionEntry[]): AssistantMessage {
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") return entry.message as AssistantMessage;
	}
	throw new Error("Expected a persisted assistant message");
}

describe("GRAN-6: request params persist into the session file", () => {
	it("round-trips request params through a real write + fresh reload with exact values", async () => {
		const dir = TempDir.createSync("gran6-persist-");
		try {
			const cwd = dir.path();
			const sessionDir = path.join(cwd, "sessions");
			const manager = SessionManager.create(cwd, sessionDir);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file path");

			manager.appendMessage(assistantWithRequest());
			manager.flushSync();
			await manager.close();

			const reopened = await SessionManager.open(sessionFile, sessionDir);
			const assistant = firstAssistant(reopened.getEntries());
			const r = assistant.request;
			if (!r) throw new Error("request params did not survive persistence");
			expect(r.temperature).toBe(0.7);
			expect(r.topP).toBe(0.95);
			expect(r.topK).toBe(40);
			expect(r.maxTokens).toBe(4096);
			expect(r.presencePenalty).toBe(0.1);
			expect(r.reasoningEffort).toBe("high");
			expect(r.disableReasoning).toBe(false);
			expect(r.toolChoice).toEqual({ type: "tool", name: "bash" });
			expect(r.serviceTier).toBe("priority");
			await reopened.close();

			// The raw JSONL line itself carries the params, not just an in-memory view.
			const raw = fs.readFileSync(sessionFile, "utf8");
			expect(raw).toContain('"request"');
			expect(raw).toContain('"reasoningEffort":"high"');
			expect(raw).toContain('"name":"bash"');
		} finally {
			dir.removeSync();
		}
	});
});
