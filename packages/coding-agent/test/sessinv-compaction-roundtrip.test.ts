/**
 * WHY: a manual compaction must change exactly what the continued turn sees —
 * the generated summary plus the declared kept tail — and nothing else. The
 * regression class this defends is the replay disagreeing with the persisted
 * cut: the summary silently dropped, the discarded span still replayed
 * (context bloat the operator paid to remove), the kept tail reordered or
 * duplicated, the first summary leaking past a second compaction, or the
 * summarizer billed more than once for one compaction (the paying-twice class
 * of f6f2d26c0, local half).
 *
 * Existing coverage stops one seam away on purpose: compaction.test.ts proves
 * the engine's cut math, session-manager/build-context.test.ts proves replay
 * from hand-built entry lists, and remote-compaction-write-path.test.ts
 * proves the remote driver path with contains/shorter assertions. No suite
 * drove a REAL AgentSession through the local summarizer and then asserted
 * the EXACT message array the next provider call receives. This one does:
 * real AgentSession, real SessionManager branch, the real prepareCompaction
 * cut, the summarizer observed at the sideStreamFn seam, and the continued
 * turn observed at the agent streamFn seam.
 *
 * Fixture shape, and why it is pinned this way: each turn's text is ~30
 * tokens and keepRecentTokens is 40, so the backward walk crosses the budget
 * exactly at the last USER message — the kept tail is the whole final turn
 * and the cut is not a split turn, which means exactly one summarizer pass
 * per compaction (a split turn legitimately buys a second, turn-prefix pass).
 * Assistant usage figures stay small so the provider-estimate ratio in
 * prepareCompaction never rescales the configured budget.
 *
 * Mutation gate (traced, not just asserted): drop the summary in the rebuild
 * → the first provider message stops carrying LOCAL-SUMMARY; replay the
 * discarded span → the ALPHA markers reappear; append the compaction entry
 * twice → the branch carries two compaction entries; run the summarizer twice
 * for one span → sideCallModelIds grows past one entry; replay an earlier
 * compaction after a second one → LOCAL-SUMMARY-ONE leaks into the continued
 * turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Message, Model, Usage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import type { CompactionEntry, SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

// ~25-30 tokens each: the cut math in the WHY comment depends on every turn
// message sitting in this band, so the markers ride long sentences.
const ALPHA_REQUEST =
	"ALPHA-REQUEST please refactor the parser module so every tokenizer path shares one entry point and delete the duplicated scanning logic that crept in last quarter";
const BRAVO_REQUEST =
	"BRAVO-REQUEST now wire the new parser through the compiler pipeline and make sure every diagnostic still carries the original source span information";
const CHARLIE_REQUEST =
	"CHARLIE-REQUEST run the full workspace test suite against the rewired pipeline and summarize any failure with the file and the rule that produced it";
const DELTA_REQUEST =
	"DELTA-REQUEST finally update the operator docs with the new pipeline order and call out the one behavior change around span reporting";
const ALPHA_REPLY =
	"ALPHA-REPLY the parser now has a single entry point and the duplicate scanning logic is gone from every tokenizer path in the module";
const BRAVO_REPLY =
	"BRAVO-REPLY the compiler pipeline is rewired and every diagnostic still carries its original source span information end to end";
const CHARLIE_REPLY =
	"CHARLIE-REPLY the workspace suite is green against the rewired pipeline and no diagnostic lost its span information anywhere";
const DELTA_REPLY =
	"DELTA-REPLY the operator docs now describe the new pipeline order and name the single span reporting behavior change explicitly";
const ECHO_REQUEST =
	"ECHO-REQUEST close out the work by tagging the release commit and pasting the final pipeline order into the changelog entry for operators";
const ECHO_REPLY =
	"ECHO-REPLY the release commit is tagged and the changelog entry carries the final pipeline order verbatim";

interface RecordedCall {
	roles: string[];
	texts: string[];
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	mainCalls: RecordedCall[];
	sideCallModelIds: string[];
	queueReply(text: string, input: number): void;
	queueSummary(text: string): void;
}

/** Readable text of an LLM-bound message; non-text blocks stay visible as markers. */
function llmText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

/** Readable text of an agent-state message, including the compaction summary role. */
function stateText(message: AgentMessage): string {
	if (message.role === "compactionSummary" || message.role === "branchSummary") return message.summary;
	if (!("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!block || typeof block !== "object" || !("type" in block)) return "";
			if (block.type !== "text" || !("text" in block)) return `[${String(block.type)}]`;
			return typeof block.text === "string" ? block.text : "";
		})
		.join("\n");
}

function makeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(model: Model, text: string, input: number, output: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: makeUsage(input, output),
		timestamp: Date.now(),
	};
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function compactionEntries(sessionManager: SessionManager): CompactionEntry[] {
	return sessionManager.getBranch().filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

/** Index access that fails loudly instead of fabricating a cast. */
function at<T>(list: readonly T[], index: number): T {
	const value = list[index];
	if (value === undefined) throw new Error(`expected element at index ${index}`);
	return value;
}

describe("compaction round-trip: the continued turn sees the summary and the kept tail, nothing else", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-sessinv-roundtrip-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
		session = undefined;
	});

	async function createHarness(): Promise<Harness> {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		// Pin the window so catalog regeneration cannot shift the compaction
		// budget math under the test.
		const model: Model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			// Manual compact() only: auto-compaction must never fire mid-prompt.
			"compaction.enabled": false,
			// The local summarizer is the path under test; remote has its own suite.
			"compaction.remote": false,
			// Cross the budget exactly at the last user message; see the WHY.
			"compaction.keepRecentTokens": 40,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});

		const replies: AssistantMessage[] = [];
		const summaries: string[] = [];
		const mainCalls: RecordedCall[] = [];
		const sideCallModelIds: string[] = [];

		const streamFn: StreamFn = (_requestModel, context) => {
			mainCalls.push({
				roles: context.messages.map(message => message.role),
				texts: context.messages.map(llmText),
			});
			const response = replies.shift();
			if (!response) throw new Error("unexpected extra provider call");
			return completedStream(response);
		};
		// The local summarizer runs through the session's side-stream seam
		// (#compactWithFallbackModel installs a completeImpl over #sideStreamFn),
		// so observing here observes every summarization pass.
		const sideStreamFn: StreamFn = requestModel => {
			const summary = summaries.shift();
			if (!summary) throw new Error("unexpected extra summarizer call");
			sideCallModelIds.push(requestModel.id);
			return completedStream(assistantMessage(requestModel, summary, 100, 50));
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			sideStreamFn,
		});
		return {
			session,
			sessionManager,
			mainCalls,
			sideCallModelIds,
			queueReply: (text, input) => replies.push(assistantMessage(model, text, input, 10)),
			queueSummary: text => summaries.push(text),
		};
	}

	it("replays exactly the summary and the declared kept tail into the continued provider call", async () => {
		const harness = await createHarness();
		harness.queueReply(ALPHA_REPLY, 100);
		harness.queueReply(BRAVO_REPLY, 120);
		harness.queueReply(CHARLIE_REPLY, 50);
		harness.queueSummary("LOCAL-SUMMARY-ONE: the alpha turn condensed");

		await harness.session.prompt(ALPHA_REQUEST);
		await harness.session.prompt(BRAVO_REQUEST);
		expect(harness.sessionManager.getBranch().filter(entry => entry.type === "message")).toHaveLength(4);

		const result = await harness.session.compact();

		// The summarizer ran exactly once, on the session model (no
		// compaction.model configured), and billed nothing else.
		expect(harness.sideCallModelIds).toEqual(["claude-sonnet-4-5"]);
		// tokensBefore is the context size the LAST turn charged:
		// totalTokens = 120 input + 10 output, no cache.
		expect(result.tokensBefore).toBe(130);

		// Exactly one compaction entry landed on the branch, carrying the summary
		// the engine composed from the single summarizer pass.
		expect(compactionEntries(harness.sessionManager)).toHaveLength(1);
		const compaction = at(compactionEntries(harness.sessionManager), 0);
		expect(compaction.summary).toBe(result.summary);
		expect(result.summary).toContain("LOCAL-SUMMARY-ONE");

		// The declared cut keeps the whole final turn — and the branch agrees:
		// every kept message entry after firstKeptEntryId, in order, is that turn.
		const branch = harness.sessionManager.getBranch();
		const keptIndex = branch.findIndex(entry => entry.id === compaction.firstKeptEntryId);
		expect(keptIndex).toBeGreaterThanOrEqual(0);
		const keptMessages = branch
			.slice(keptIndex)
			.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		expect(keptMessages.map(entry => entry.message.role)).toEqual(["user", "assistant"]);
		expect(stateText(at(keptMessages, 0).message)).toContain("BRAVO-REQUEST");
		expect(stateText(at(keptMessages, 1).message)).toBe(BRAVO_REPLY);

		// The live agent state was swapped to the replayed context: summary at
		// the top, then the kept turn, exact roles, exact order.
		const stateMessages = harness.session.agent.state.messages;
		expect(stateMessages.map(message => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
		expect(stateText(at(stateMessages, 0))).toContain("LOCAL-SUMMARY-ONE");
		expect(stateText(at(stateMessages, 1))).toContain("BRAVO-REQUEST");
		expect(stateText(at(stateMessages, 2))).toBe(BRAVO_REPLY);
		// The discarded span is gone from the live context.
		const stateJson = JSON.stringify(stateMessages);
		expect(stateJson).not.toContain("ALPHA-REQUEST");
		expect(stateJson).not.toContain("ALPHA-REPLY");

		// The continued turn: the provider receives exactly [summary, kept turn,
		// new prompt] — roles, order, and texts.
		await harness.session.prompt(CHARLIE_REQUEST);
		expect(harness.mainCalls).toHaveLength(3);
		const continued = at(harness.mainCalls, 2);
		expect(continued.roles).toEqual(["user", "user", "assistant", "user"]);
		expect(continued.texts[0]).toContain("LOCAL-SUMMARY-ONE");
		expect(continued.texts[1]).toContain("BRAVO-REQUEST");
		expect(continued.texts[2]).toBe(BRAVO_REPLY);
		expect(continued.texts[3]).toContain("CHARLIE-REQUEST");
		const continuedJson = JSON.stringify(continued.texts);
		expect(continuedJson).not.toContain("ALPHA-REQUEST");
		expect(continuedJson).not.toContain("ALPHA-REPLY");
	});

	it("a second compaction replaces the first summary everywhere the first one was visible", async () => {
		const harness = await createHarness();
		harness.queueReply(ALPHA_REPLY, 100);
		harness.queueReply(BRAVO_REPLY, 120);
		harness.queueReply(CHARLIE_REPLY, 50);
		harness.queueReply(DELTA_REPLY, 60);
		harness.queueReply(ECHO_REPLY, 70);
		harness.queueSummary("LOCAL-SUMMARY-ONE: the alpha turn condensed");
		harness.queueSummary("LOCAL-SUMMARY-TWO: everything through charlie condensed");

		await harness.session.prompt(ALPHA_REQUEST);
		await harness.session.prompt(BRAVO_REQUEST);
		await harness.session.compact();
		// Two full turns between the compactions: with a one-turn range the
		// engine's dead-end guard would force a mid-turn cut (a split turn buys
		// a second summarizer pass), and this test pins one pass per compaction.
		await harness.session.prompt(CHARLIE_REQUEST);
		await harness.session.prompt(DELTA_REQUEST);

		const second = await harness.session.compact();

		// Two compactions, two summarizer passes — one each, never more.
		expect(harness.sideCallModelIds).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-5"]);
		expect(second.tokensBefore).toBe(70);
		expect(compactionEntries(harness.sessionManager)).toHaveLength(2);

		// The replay trusts the LATEST compaction only: the first summary must
		// not leak into the rebuilt state next to the second one.
		const stateMessages = harness.session.agent.state.messages;
		expect(stateMessages.map(message => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
		expect(stateText(at(stateMessages, 0))).toContain("LOCAL-SUMMARY-TWO");
		expect(stateText(at(stateMessages, 1))).toContain("DELTA-REQUEST");
		expect(stateText(at(stateMessages, 2))).toBe(DELTA_REPLY);
		expect(JSON.stringify(stateMessages)).not.toContain("LOCAL-SUMMARY-ONE");

		// And the continued turn carries the same replacement through to the wire.
		await harness.session.prompt(ECHO_REQUEST);
		expect(harness.mainCalls).toHaveLength(5);
		const continued = at(harness.mainCalls, 4);
		expect(continued.roles).toEqual(["user", "user", "assistant", "user"]);
		expect(continued.texts[0]).toContain("LOCAL-SUMMARY-TWO");
		expect(continued.texts[1]).toContain("DELTA-REQUEST");
		expect(continued.texts[2]).toBe(DELTA_REPLY);
		expect(continued.texts[3]).toContain("ECHO-REQUEST");
		const continuedJson = JSON.stringify(continued.texts);
		expect(continuedJson).not.toContain("LOCAL-SUMMARY-ONE");
		expect(continuedJson).not.toContain("CHARLIE-REQUEST");
		expect(continuedJson).not.toContain("CHARLIE-REPLY");
	});
});
