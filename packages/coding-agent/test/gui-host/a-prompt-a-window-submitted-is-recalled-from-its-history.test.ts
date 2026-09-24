/**
 * WHY: the window's prompt recall reads the same SQLite store the terminal
 * editor writes, and the window wrote nothing into it. A window that submitted
 * every prompt of a session opened the recall mode on an empty list, and a
 * prompt typed in a window was unreachable from the terminal that shares the
 * store. The read half shipped without the write half.
 *
 * THE CLASS THIS CLOSES: a prompt that reaches a turn without reaching the
 * store. The suite drives the real host over its socket, so it covers the
 * submit path a window actually uses rather than the recorder in isolation,
 * and it runs each action that delivers a prompt end to end: the text sent,
 * the listing read back, the fields the window decodes.
 *
 * Which actions record at all is the neighbouring sweep,
 * `every-action-a-window-sends-decides-whether-its-text-is-recalled.test.ts`,
 * which reads the delivery module's own handler table at run time and pins
 * the recording set by exact equality; the four actions named below are the
 * ones this suite exercises in detail, not the variant space.
 *
 * It also pins the decode contract the window depends on: `cwd` and `session`
 * arrive as `null` rather than absent, because the window's deserializer
 * requires both fields and a row missing one rejects the whole snapshot.
 *
 * WHAT IT DOES NOT CATCH: the drawing of the recall mode, which is the
 * desktop's own suite, and the store's ranking, which is `HistoryStorage`'s.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Context } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { PromptHistoryView } from "../../src/gui-host/wire";
import { requestsPrompts } from "../../src/prompts/requests/rows";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

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

/** A stream that delivers `text` as one delta and finishes. */
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

/** The text of the prompt a turn was started with, for the stub's reply. */
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

/**
 * The actions this suite drives end to end, and whether the text each carries
 * is one to recall. The variant space is swept from the delivery module's
 * handler table by the neighbouring sweep named above; these four are the
 * detailed cases.
 */
const DELIVERS_A_PROMPT = [
	{ action: "SubmitPrompt", typed: true },
	{ action: "Steer", typed: true },
	{ action: "FollowUp", typed: true },
	// `/rephrase` submits a fixed instruction the session wrote, not a prompt
	// anyone typed, so recalling it would put words in the composer that were
	// never in it.
	{ action: "RephraseReply", typed: false },
] as const;

/** The text `/rephrase` delivers, which is what the listing must not hold. */
const REPHRASE_REQUEST = requestsPrompts["requests/rephrase"].text.trim();

describe("a prompt a window submitted is recalled from its history", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient | null = null;
	let session = "";
	let nextRequest = 1;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-prompt-history-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		// The store is a process singleton reached by a default path. Seeding it
		// at this run's own database is what keeps the rows this suite asserts
		// on from mixing with another suite's, and from reaching a real one.
		HistoryStorage.resetInstance();
		HistoryStorage.open(path.join(tempDir, "history.db"));
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) =>
			completedStream(`answered: ${lastUserText(context)}`),
		);
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		nextRequest = 1;
		const created = await client.request(nextRequest++, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		session = active.Snapshot.ActiveSession.value.id;
	});

	afterEach(async () => {
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

	/** Sends one action and answers with its outcome. */
	async function send(action: string, payload: Record<string, unknown>): Promise<unknown> {
		if (!client) throw new Error("the window is not connected");
		const sent = await client.request(nextRequest++, { [action]: { session, ...payload } });
		return sent.outcome;
	}

	/**
	 * Sends one action and answers when the session accepted it. A request
	 * settles when the prompt is accepted rather than when its turn ends, so a
	 * prompt sent straight after another is refused with `TURN_IN_PROGRESS`
	 * until that turn finishes; any other refusal is the failure it looks
	 * like. Bounded: a session that never goes idle fails here.
	 */
	async function accepted(action: string, payload: Record<string, unknown>): Promise<void> {
		for (let attempt = 0; attempt < 80; attempt++) {
			const outcome = await send(action, payload);
			const failure = (outcome as { RequestFailed?: { error?: { code?: string } } }).RequestFailed;
			if (!failure) return;
			if (failure.error?.code !== "TURN_IN_PROGRESS") {
				throw new Error(`${action} was refused: ${JSON.stringify(outcome)}`);
			}
			await delay(25);
		}
		throw new Error(`${action} never found the session idle within two seconds`);
	}

	/** The prompts the host answers `query` with. */
	async function recall(query: string): Promise<PromptHistoryView> {
		if (!client) throw new Error("the window is not connected");
		const looked = await client.request(nextRequest++, { SearchPromptHistory: { query } });
		const views = snapshotSections<PromptHistoryView>(looked.frames, "PromptHistory");
		const view = views.at(-1);
		if (!view) throw new Error("SearchPromptHistory answered with no PromptHistory section");
		return view;
	}

	/**
	 * The listing, once `prompt` is in it. The row is written after the reply
	 * and the store batches its inserts, so a listing read the instant the
	 * request settles is read before the write. Bounded: a prompt that never
	 * arrives fails here rather than hanging the suite.
	 */
	async function listingHolding(prompt: string): Promise<PromptHistoryView> {
		for (let attempt = 0; attempt < 60; attempt++) {
			const view = await recall("");
			if (view.entries.some(entry => entry.prompt === prompt)) return view;
			await delay(25);
		}
		throw new Error(`'${prompt}' did not reach the prompt store within a second and a half`);
	}

	/**
	 * Submits `text` and waits for it to land, which also proves every write
	 * queued before it has landed: the store's inserts drain in order, so a
	 * later prompt in the listing is a barrier for an earlier one.
	 */
	async function submitAndSettle(text: string): Promise<PromptHistoryView> {
		await accepted("SubmitPrompt", { text });
		return listingHolding(text);
	}

	test("a prompt submitted from a window is in the listing the recall mode opens on", async () => {
		const view = await submitAndSettle("rebuild the search index");
		expect(view.entries.map(entry => entry.prompt)).toEqual(["rebuild the search index"]);
		expect(view.entries[0]?.session).toBe(session);
	});

	test("a query matching a word of the prompt finds it", async () => {
		await submitAndSettle("rebuild the search index");
		await submitAndSettle("open the loader");
		const view = await recall("index");
		expect(view.query).toBe("index");
		expect(view.entries.map(entry => entry.prompt)).toEqual(["rebuild the search index"]);
	});

	test("every field the window decodes is present, with null where there is no value", async () => {
		// Written through the store rather than the host, because the host always
		// has a working directory to record and this pins the shape of a row that
		// does not: an absent key rejects the whole snapshot in the window.
		await HistoryStorage.open().add("a prompt recorded with nothing beside it");
		const entry = (await recall("")).entries.at(0);
		expect(Object.keys(entry ?? {}).sort()).toEqual([
			"cwd",
			"id",
			"prompt",
			"session",
			"submitted_at_ms",
			"truncated",
		]);
		expect(entry?.cwd).toBeNull();
		expect(entry?.session).toBeNull();
		expect(entry?.truncated).toBe(false);
		expect(entry?.submitted_at_ms).toBeGreaterThan(0);
	});

	test("a prompt sent twice is one row, not two", async () => {
		await submitAndSettle("rebuild the search index");
		await accepted("SubmitPrompt", { text: "rebuild the search index" });
		// The barrier is a later prompt, so the second submission has had its
		// chance to write a row of its own by the time the count is taken.
		const view = await submitAndSettle("open the loader");
		expect(view.entries.filter(entry => entry.prompt === "rebuild the search index")).toHaveLength(1);
	});

	test("each action that delivers a prompt records it, and the fixed instruction does not", async () => {
		for (const { action, typed } of DELIVERS_A_PROMPT) {
			const text = `prompt carried by ${action}`;
			await accepted(action, typed ? { text } : {});
			if (typed) {
				expect((await listingHolding(text)).entries.map(entry => entry.prompt)).toContain(text);
				continue;
			}
			// The text `/rephrase` delivers is a fixed instruction, not a
			// prompt anyone typed, so it is that instruction the listing must
			// not hold. A later prompt is the barrier: once it is in the
			// listing, every write queued before it is too, so an absent
			// instruction was never recorded rather than still queued.
			const barrier = await submitAndSettle("the prompt after the instruction");
			const prompts = barrier.entries.map(entry => entry.prompt);
			expect(REPHRASE_REQUEST.length).toBeGreaterThan(0);
			expect(prompts).not.toContain(REPHRASE_REQUEST);
			expect(prompts).not.toContain(text);
		}
	});
});
