/**
 * WHY: which actions record a prompt was pinned by a list written by hand, so
 * an action added beside `SubmitPrompt` that carries typed text joined the
 * protocol without a decision: it either recorded nothing, and a prompt sent
 * that way was unreachable from the recall mode, or it recorded text nobody
 * typed, and the mode offered words to put back in a composer that never held
 * them. A list cannot see either, because it names only what someone thought
 * to name.
 *
 * THE CLASS THIS CLOSES: a turn action whose text reaches the store without a
 * decision. The variant space is `turnActionHandlers`, the table the module
 * that delivers prompts registers itself through, read at run time. Every tag
 * in it is sent with text of its own against a session of its own, and the set
 * that reached the store is pinned by exact equality: an action that starts
 * recording turns this red until it is named here, one that stops recording
 * does too, and a thirteenth turn action is swept the moment it is registered.
 *
 * WHAT IT DOES NOT CATCH: an action registered outside that table that reaches
 * a prompt turn some other way; what the recall mode draws, which is the
 * desktop's own suite; the store's ranking, which is `HistoryStorage`'s; and
 * whether a recorded prompt is the text a window sent rather than a mangling
 * of it, which is
 * `a-prompt-a-window-submitted-is-recalled-from-its-history.test.ts`.
 */

import { afterAll, beforeAll, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Context } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { turnActionHandlers } from "../../src/gui-host/actions/turn";
import type { PromptHistoryView } from "../../src/gui-host/wire";
import { requestsPrompts } from "../../src/prompts/requests/rows";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

/**
 * The turn actions whose text a window recalls. Every other one either carries
 * no text a person typed or never reaches the store.
 *
 * `RephraseReply` is deliberately absent: it delivers a fixed instruction the
 * session wrote, so recalling it would put words in the composer that were
 * never in it.
 */
const RECORDS_WHAT_IT_CARRIES = ["FollowUp", "Steer", "SubmitPrompt"];

/** The text `/rephrase` delivers, which no listing may hold. */
const REPHRASE_REQUEST = requestsPrompts["requests/rephrase"].text.trim();

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(" ");
		if (text.trim()) return text.trim();
	}
	return "nothing";
}

let tempDir = "";
let server: GuiHostServer | null = null;
let client: TestSocketClient | null = null;
let nextRequest = 1;

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-records-"));
	await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
	// The store is a process singleton reached by a default path, so the sweep
	// seeds it at this run's own database rather than at a real one.
	HistoryStorage.resetInstance();
	HistoryStorage.open(path.join(tempDir, "history.db"));
	const authStorage = await isolatedAuthStorage(tempDir);
	authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
	server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
	vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => completedStream(lastUserText(context)));
	client = await TestSocketClient.connect(server.endpoint);
	await client.nextFrame();
	await client.nextFrame();
});

afterAll(async () => {
	vi.restoreAllMocks();
	client?.destroy();
	client = null;
	if (server) {
		await server.close();
		server = null;
	}
	HistoryStorage.resetInstance();
	await fs.rm(tempDir, { recursive: true, force: true });
});

function window(): TestSocketClient {
	if (!client) throw new Error("the window is not connected");
	return client;
}

/** Sends one frame and answers with its outcome. */
async function send(frame: Record<string, unknown>): Promise<unknown> {
	const sent = await window().request(nextRequest++, frame);
	return sent.outcome;
}

/**
 * Sends one frame and answers once the session is done refusing it for a turn
 * already in flight. Every other refusal is left alone: an action this sweep
 * cannot reach is measured as recording nothing, which is what it did.
 *
 * Bounded: a session that never goes idle ends this at the attempt ceiling.
 */
async function accepted(frame: Record<string, unknown>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const outcome = await send(frame);
		const failure = (outcome as { RequestFailed?: { error?: { code?: string } } }).RequestFailed;
		if (failure?.error?.code !== "TURN_IN_PROGRESS") return;
		await delay(25);
	}
	throw new Error(`${Object.keys(frame)[0]} never found the session idle`);
}

/** A session of this host's own, for one action to act on. */
async function freshSession(): Promise<string> {
	const created = await window().request(nextRequest++, { CreateSession: {} });
	const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
		| { Snapshot: { ActiveSession: { value: { id: string } } } }
		| undefined;
	if (!active) throw new Error("CreateSession emitted no ActiveSession");
	return active.Snapshot.ActiveSession.value.id;
}

/** The prompts the host lists for an empty query. */
async function listing(): Promise<PromptHistoryView> {
	const looked = await window().request(nextRequest++, { SearchPromptHistory: { query: "" } });
	const view = snapshotSections<PromptHistoryView>(looked.frames, "PromptHistory").at(-1);
	if (!view) throw new Error("SearchPromptHistory answered with no PromptHistory section");
	return view;
}

/**
 * Submits `text` on `session` and answers with the listing once it holds it,
 * which is the barrier every earlier write has cleared.
 *
 * Bounded: a barrier that never lands fails here rather than hanging the run.
 */
async function barrier(session: string, text: string): Promise<string[]> {
	await accepted({ SubmitPrompt: { session, text } });
	for (let attempt = 0; attempt < 200; attempt++) {
		const prompts = (await listing()).entries.map(entry => entry.prompt);
		if (prompts.includes(text)) return prompts;
		await delay(25);
	}
	throw new Error(`the barrier prompt ${text} never reached the store`);
}

test(
	"the turn actions whose text is recalled are the ones that were decided",
	async () => {
		const swept = Object.keys(turnActionHandlers);
		expect(swept.length).toBeGreaterThan(0);
		// One session for the whole sweep. An action that acts on a reply --
		// a rephrase, a retry, an abort -- is refused by a session with none
		// in it, and would be read as recording nothing whatever the recorder
		// does, so the session is primed with a completed turn first.
		const session = await freshSession();
		await barrier(session, "priming the swept session");
		for (const action of swept) {
			await accepted({ [action]: { session, text: `text carried by ${action}` } });
		}
		// One barrier for the whole sweep: once it is listed, every write any
		// action queued before it is listed too, so an absent text was never
		// recorded rather than still in the store's batch.
		const listed = await barrier(session, "barrier after the swept actions");
		const recorded = swept.filter(action => listed.includes(`text carried by ${action}`));
		expect(recorded.sort()).toEqual(RECORDS_WHAT_IT_CARRIES);
		// The other direction, which a set of recorded actions cannot see: an
		// action that recorded text of its own rather than the text it was
		// sent. `RephraseReply` delivers a fixed instruction, so a recorder
		// that ignores whether the text was typed writes that instruction
		// into the store under no action's carried text at all.
		//
		// Both readings name what this sweep typed. The store is a process
		// singleton and a recorded row is written after the reply, so a row
		// queued by another suite can land in this database after it is
		// opened; a reading of everything listed would call that row a defect.
		const carriedByRecorded = new Set(recorded.map(action => `text carried by ${action}`));
		const carriedRows = listed.filter(prompt => prompt.startsWith("text carried by "));
		expect(carriedRows.filter(prompt => !carriedByRecorded.has(prompt))).toEqual([]);
		expect(listed).not.toContain(REPHRASE_REQUEST);
	},
	{ timeout: 120_000 },
);
