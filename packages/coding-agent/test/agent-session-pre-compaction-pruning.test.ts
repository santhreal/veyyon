import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const STALE_READ_ID = "call-stale-read";
const NEW_READ_ID = "call-new-read";
const USELESS_ID = "call-useless-result";
const STALE_READ_BYTES = "STALE_READ_ORIGINAL_BYTES\n".repeat(200);
const NEW_READ_BYTES = "NEW_READ_ORIGINAL_BYTES\n".repeat(200);
const USELESS_BYTES = "USELESS_ORIGINAL_BYTES\n".repeat(200);

const usageZero = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession threshold compaction input", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let apiInfo: Pick<AssistantMessage, "api" | "provider" | "model">;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-pre-compaction-history-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "summary",
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
			}),
			modelRegistry,
		});
		session.settings.set("compaction.thresholdTokens", 50);
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	function appendAssistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): void {
		sessionManager.appendMessage({
			role: "assistant",
			content,
			...apiInfo,
			stopReason,
			usage: usageZero,
			timestamp: Date.now(),
		});
	}

	function appendToolResult(toolCallId: string, toolName: string, text: string, useless = false): void {
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			useless,
			timestamp: Date.now(),
		});
	}

	it("elides the stale and uneventful results, and hands compaction the newest read in full", async () => {
		sessionManager.appendMessage({ role: "user", content: "Read the target.", timestamp: Date.now() });
		appendAssistant(
			[{ type: "toolCall", id: STALE_READ_ID, name: "read", arguments: { path: "src/target.ts" } }],
			"toolUse",
		);
		appendToolResult(STALE_READ_ID, "read", STALE_READ_BYTES);
		appendAssistant([{ type: "text", text: "I need a newer read." }], "stop");

		sessionManager.appendMessage({ role: "user", content: "Read it again.", timestamp: Date.now() });
		appendAssistant(
			[{ type: "toolCall", id: NEW_READ_ID, name: "read", arguments: { path: "src/target.ts" } }],
			"toolUse",
		);
		appendToolResult(NEW_READ_ID, "read", NEW_READ_BYTES);
		appendAssistant([{ type: "text", text: "The second read is authoritative." }], "stop");

		sessionManager.appendMessage({ role: "user", content: "Run the search too.", timestamp: Date.now() });
		appendAssistant(
			[{ type: "toolCall", id: USELESS_ID, name: "grep", arguments: { pattern: "missing" } }],
			"toolUse",
		);
		appendToolResult(USELESS_ID, "grep", USELESS_BYTES, true);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const rewriteSpy = vi.spyOn(sessionManager, "rewriteEntries");
		let rewriteCallsAtCompaction: number | undefined;
		const capturedToolResults = new Map<string, string>();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			rewriteCallsAtCompaction = rewriteSpy.mock.calls.length;
			const messages = [
				...preparation.messagesToSummarize,
				...preparation.turnPrefixMessages,
				...preparation.recentMessages,
			];
			for (const message of messages) {
				if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
				capturedToolResults.set(
					message.toolCallId,
					message.content.map(block => (block.type === "text" ? block.text : "")).join(""),
				);
			}
			return {
				summary: "threshold summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});
		await session.prompt("Continue after compaction. ".repeat(120));

		expect(compactSpy).toHaveBeenCalledTimes(1);
		// `compaction.supersedeReads` is on by default: the first read of src/target.ts was
		// answered again, so it reaches compaction as the placeholder rather than as 200
		// lines the summary would have to pay for and then contradict.
		expect(capturedToolResults.get(STALE_READ_ID)).toBe(compactionModule.SUPERSEDED_NOTICE);
		expect(capturedToolResults.get(NEW_READ_ID)).toBe(NEW_READ_BYTES);
		// Uneventful-result elision is on for the same reason: a grep that matched nothing
		// costs 200 lines to say so, and the summary cannot learn anything from them.
		expect(capturedToolResults.get(USELESS_ID)).toBe(compactionModule.USELESS_NOTICE);
		// Exactly one rewrite, before compaction: the elisions are persisted so the next turn
		// does not re-send the bytes this pass just decided not to pay for, and they are
		// flushed together rather than one entry at a time.
		expect(rewriteCallsAtCompaction).toBe(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});
});
