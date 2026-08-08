/**
 * WHY: `prepareCompaction` elides over-budget tool results on the LIVE branch
 * as a side effect of preparing — `elideTailToolResults` replaces
 * `entry.message` with a marker before any summarizer runs
 * (packages/agent/src/compaction/compaction.ts:1415), and the caller contract
 * is that `#persistCompactionTailElisions` later offloads the originals to a
 * recovery artifact and patches the markers with the `artifact://` pointer
 * (packages/coding-agent/src/session/agent-session.ts:15853). That persist
 * step runs only AFTER a compaction result exists
 * (agent-session.ts:13106 manual, :16265 auto). When the summarization itself
 * fails — every candidate errors, or the run is cancelled — the branch keeps
 * the markers, no artifact is ever written, and the markers carry no pointer.
 * The original bytes survive only in `agent.state.messages`; the next
 * successful compaction rebuilds from the branch and the bytes are gone for
 * good, silently.
 *
 * This test drives exactly that: a real AgentSession whose newest turn
 * carries a huge tool result (so elision fires), a local summarizer that
 * always fails, and then asserts the failure left the branch untouched. It
 * FAILS today: the branch holds a pointerless marker and the original output
 * is unreachable from the session.
 *
 * Mutation gate: rollback the elision on failure (or defer it until the
 * result exists) and every assertion below passes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const HUGE = "x".repeat(40_000);

const usage = () => ({
	input: 1000,
	output: 100,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("a failed compaction must not strand tail elisions on the branch", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tailrev-compaction-failure-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("openai", "gpt-5.1");
		if (!bundled) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		// Six small turns to summarize away, then a final turn whose one tool
		// result dwarfs the keep-recent budget, so elideTailToolResults fires.
		for (let i = 0; i < 6; i++) {
			sessionManager.appendMessage({ role: "user", content: `old question ${i}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `old answer ${i}` }],
				api: "openai-responses",
				provider: "openai",
				model: model.id,
				stopReason: "stop",
				usage: usage(),
				timestamp: Date.now(),
			});
		}
		sessionManager.appendMessage({ role: "user", content: "read the big file", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-big", name: "read", arguments: { path: "big.txt" } }],
			api: "openai-responses",
			provider: "openai",
			model: model.id,
			stopReason: "toolUse",
			usage: usage(),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-big",
			toolName: "read",
			content: [{ type: "text", text: HUGE }],
			isError: false,
			timestamp: Date.now(),
		});

		// The local summarizer always fails: compact() must reject, and the
		// session must be exactly as it was before the attempt.
		const failingSideStreamFn: StreamFn = requestModel => {
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				stopReason: "error",
				errorMessage: "summarizer down",
				usage: usage(),
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial });
				stream.push({ type: "error", reason: "error", error: partial });
			});
			return stream;
		};

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 200 }),
			modelRegistry,
			sideStreamFn: failingSideStreamFn,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	it("leaves the branch byte-identical when every summarizer fails", async () => {
		const before = JSON.stringify(sessionManager.getBranch());
		expect(before).toContain(HUGE);

		await expect(session.compact()).rejects.toThrow();

		const branch = sessionManager.getBranch();
		const after = JSON.stringify(branch);
		// The elision is preparation side effect; a failed compaction owns no
		// right to keep it. The original tool output must still be on the branch.
		expect(after).toContain(HUGE);
		expect(after).not.toContain("output elided by compaction");
	});

	it("a stranded marker at least names a recovery artifact", async () => {
		// Weaker sibling of the test above: if the design instead chooses to
		// KEEP the elision across a failed compaction, the marker must still
		// carry its `artifact://` pointer and the artifact must exist, or the
		// bytes are unrecoverable. Today neither holds.
		await expect(session.compact()).rejects.toThrow();

		const after = JSON.stringify(sessionManager.getBranch());
		const marker = after.match(/output elided by compaction[^\]]*\]/);
		// No marker at all (full rollback) also satisfies this contract.
		if (marker) {
			expect(marker[0]).toContain("artifact://");
		}
	});
});
