/**
 * WHY: a session is only as good as its reload. The regression class this
 * file defends is the persisted journal diverging from the live one —
 * entries written twice, dropped, or reordered on disk (the duplicate-write
 * class: a compaction entry appended by both the driver and a listener, a
 * rewrite that replays the tail over itself), and the resumed manager
 * disagreeing with the pre-close one about message order, entry ids, the
 * parent chain, token accounting, or the compaction boundary. Every one of
 * those shipped symptoms before: usage-statistics.test.ts covers accounting
 * in MEMORY only, session-manager-immediate-persist.test.ts covers two raw
 * appends, and nothing covered a compacted session crossing close/reopen.
 *
 * Two suites, one disk-backed harness driving a REAL AgentSession (real
 * prompt turns through an injected streamFn, real local compaction through
 * the sideStreamFn seam, real JSONL file):
 *
 *  1. Resume parity: snapshot the live manager after two turns, a
 *     compaction, and a continued turn; dispose; reopen with
 *     SessionManager.open. Entry type/id/parentId sequence, usage
 *     statistics, replayed context, leaf, and the compaction entry's fields
 *     must be byte-identical, and the summarized span must stay gone.
 *
 *  2. Event log exactly-once: after the same drive, the JSONL on disk must
 *     be exactly the in-memory entry list — same ids, same order, one line
 *     each, one compaction line. Then a resumed manager appending a new turn
 *     must GROW the file: old ids still exactly once, new ids after them.
 *
 * Mutation gate (traced): write the compaction entry twice → the file id
 * sequence gains a duplicate and stops matching getEntries(); rewrite the
 * whole file on resume-append → old ids appear twice; drop the compaction
 * boundary on reload → the reopened context regains the discarded span;
 * mis-key usage on reload → the UsageStatistics objects stop matching.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Model, Usage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import type { CompactionEntry, SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

// Same ~25-30-token band as the round-trip suite: keepRecentTokens = 40 makes
// the cut keep exactly the final turn, so the compaction boundary is pinned.
const ALPHA_REQUEST =
	"ALPHA-REQUEST please refactor the parser module so every tokenizer path shares one entry point and delete the duplicated scanning logic that crept in last quarter";
const BRAVO_REQUEST =
	"BRAVO-REQUEST now wire the new parser through the compiler pipeline and make sure every diagnostic still carries the original source span information";
const CHARLIE_REQUEST =
	"CHARLIE-REQUEST run the full workspace test suite against the rewired pipeline and summarize any failure with the file and the rule that produced it";
const ALPHA_REPLY =
	"ALPHA-REPLY the parser now has a single entry point and the duplicate scanning logic is gone from every tokenizer path in the module";
const BRAVO_REPLY =
	"BRAVO-REPLY the compiler pipeline is rewired and every diagnostic still carries its original source span information end to end";
const CHARLIE_REPLY =
	"CHARLIE-REPLY the workspace suite is green against the rewired pipeline and no diagnostic lost its span information anywhere";
const SUMMARY_TEXT = "LOCAL-SUMMARY-ONE: the alpha turn condensed";

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	model: Model;
	queueReply(text: string, input: number): void;
	queueSummary(text: string): void;
}

/** Readable text of an agent-state / persisted message, summary roles included. */
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

/** Identity signature of an entry list: type, id, and parent link, in order. */
function entrySignature(entries: SessionEntry[]): string[] {
	return entries.map(entry => `${entry.type}:${entry.id}:${entry.parentId ?? "null"}`);
}

/** Replay signature of a built context: role plus readable text, in order. */
function contextSignature(messages: AgentMessage[]): string[] {
	return messages.map(message => `${message.role}:${stateText(message)}`);
}

/** Entry lines of a session JSONL, skipping the header and the title slot. */
function readEntryLines(sessionFile: string): Array<{ id: string; type: string }> {
	return fs
		.readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as { id?: unknown; type?: unknown })
		.filter(
			(entry): entry is { id: string; type: string } =>
				typeof entry.id === "string" &&
				typeof entry.type === "string" &&
				entry.type !== "session" &&
				entry.type !== "title",
		);
}

describe("session resume and event-log integrity across a compaction boundary", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-sessinv-resume-");
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
		// Disk-backed: the JSONL file IS the artifact under test.
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		const model: Model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.remote": false,
			"compaction.keepRecentTokens": 40,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});

		const replies: AssistantMessage[] = [];
		const summaries: string[] = [];

		const streamFn: StreamFn = () => {
			const response = replies.shift();
			if (!response) throw new Error("unexpected extra provider call");
			return completedStream(response);
		};
		const sideStreamFn: StreamFn = requestModel => {
			const summary = summaries.shift();
			if (!summary) throw new Error("unexpected extra summarizer call");
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
			model,
			queueReply: (text, input) => replies.push(assistantMessage(model, text, input, 10)),
			queueSummary: text => summaries.push(text),
		};
	}

	/** Two turns, one compaction, one continued turn: the shared drive. */
	async function driveCompactedSession(harness: Harness): Promise<void> {
		harness.queueReply(ALPHA_REPLY, 100);
		harness.queueReply(BRAVO_REPLY, 120);
		harness.queueReply(CHARLIE_REPLY, 50);
		harness.queueSummary(SUMMARY_TEXT);

		await harness.session.prompt(ALPHA_REQUEST);
		await harness.session.prompt(BRAVO_REQUEST);
		await harness.session.compact();
		await harness.session.prompt(CHARLIE_REQUEST);
	}

	it("reloads with identical entry identity, token accounting, replayed context, and compaction fields", async () => {
		const harness = await createHarness();
		await driveCompactedSession(harness);
		const manager = harness.sessionManager;

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const liveSessionId = manager.getSessionId();
		await harness.session.dispose();
		session = undefined;

		// Live snapshot, taken after dispose so the journal is final: dispose
		// itself appends exactly one mutation, the session_exit diagnostic.
		const liveEntries = entrySignature(manager.getEntries());
		const liveUsage = manager.getUsageStatistics();
		const liveContext = contextSignature(manager.buildSessionContext().messages);
		const liveLeafId = manager.getLeafId();
		const liveTail = manager.getEntries().at(-1);
		if (liveTail?.type !== "custom") throw new Error("Expected dispose to append a session_exit diagnostic");
		expect(liveTail.customType).toBe("session_exit");
		const liveCompaction = manager
			.getEntries()
			.find((entry): entry is CompactionEntry => entry.type === "compaction");
		if (!liveCompaction) throw new Error("Expected a compaction entry on the live branch");

		// Hand-pinned accounting, so a reload bug cannot hide behind an equally
		// wrong live computation: three assistant turns, no cache, and the
		// compaction entry's tokensBefore must NOT leak into usage.
		expect(liveUsage.input).toBe(270);
		expect(liveUsage.output).toBe(30);
		expect(liveUsage.totalTokens).toBe(300);
		// The discarded span is gone from the live replay; the summary replaced it.
		const liveContextJson = JSON.stringify(liveContext);
		expect(liveContextJson).toContain(SUMMARY_TEXT);
		expect(liveContextJson).not.toContain("ALPHA-REQUEST");
		expect(liveContextJson).not.toContain("ALPHA-REPLY");

		const reopened = await SessionManager.open(sessionFile);

		// Identity: same session, same leaf, same entry sequence — type, id,
		// and parent link, in order, no duplicates, no drops.
		expect(reopened.getSessionId()).toBe(liveSessionId);
		expect(reopened.getLeafId()).toBe(liveLeafId);
		expect(entrySignature(reopened.getEntries())).toEqual(liveEntries);

		// Token accounting survives the round trip exactly.
		expect(reopened.getUsageStatistics()).toEqual(liveUsage);

		// The replayed context is byte-identical: summary at the top, kept
		// turn, continued turn — and the discarded span stays gone.
		const reopenedContext = contextSignature(reopened.buildSessionContext().messages);
		expect(reopenedContext).toEqual(liveContext);

		// The compaction boundary survived verbatim: same summary, same cut.
		const reopenedCompaction = reopened
			.getEntries()
			.find((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(reopenedCompaction?.summary).toBe(liveCompaction.summary);
		expect(reopenedCompaction?.firstKeptEntryId).toBe(liveCompaction.firstKeptEntryId);
		expect(reopenedCompaction?.tokensBefore).toBe(130);
	});

	it("writes every entry to the JSONL exactly once, in order, across compaction, close, and resume-append", async () => {
		const harness = await createHarness();
		await driveCompactedSession(harness);
		const manager = harness.sessionManager;

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		await harness.session.dispose();
		session = undefined;

		// Snapshot after dispose: the journal then includes the session_exit
		// diagnostic, and the file must match it line for line.
		const liveIds = manager.getEntries().map(entry => entry.id);

		// The file IS the in-memory journal: same ids, same order, one line
		// each. toEqual on the full sequence catches duplicates, drops, and
		// reordering in one assertion.
		const fileIds = readEntryLines(sessionFile).map(entry => entry.id);
		expect(fileIds).toEqual(liveIds);
		// The duplicate-compaction class, directly: exactly one compaction line.
		expect(readEntryLines(sessionFile).filter(entry => entry.type === "compaction")).toHaveLength(1);

		// Resume and grow the journal: the old entries must stay exactly once,
		// ahead of the new ones — a rewrite-on-append would duplicate them.
		const reopened = await SessionManager.open(sessionFile);
		const echoUserId = reopened.appendMessage({
			role: "user",
			content: "ECHO-REQUEST tag the release and paste the final pipeline order into the changelog",
			timestamp: Date.now(),
		});
		const echoAssistantId = reopened.appendMessage(
			assistantMessage(
				harness.model,
				"ECHO-REPLY the release is tagged and the changelog carries the order",
				70,
				10,
			),
		);
		await reopened.close();

		const afterIds = readEntryLines(sessionFile).map(entry => entry.id);
		expect(afterIds).toEqual([...liveIds, echoUserId, echoAssistantId]);
	});
});
