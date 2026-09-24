/**
 * A room window shows what the conversation is doing.
 *
 * WHY THIS SUITE EXISTS. A room shows every conversation in the terminal as a
 * window, built by `buildRoomWindowSnapshot` from the live session and kept by
 * `RoomWindowFeed` from the session's events. The window is the only thing the
 * operator reads about a conversation that is not on screen, so the defect
 * class is a window that misreports it: the wrong state (a failed turn shown
 * done, a stopped one failed, a running one idle), the wrong exchange (an
 * injected message shown as the operator's prompt), a tool call shown fine that
 * never answered, a terminal escape or a tab from model output reaching the
 * painter, and the argot seam: a raw `§handle` on screen, from a stored message
 * that skipped the display transform, or from a live stream read off
 * `state.streamMessage` instead of the display event the session emits.
 *
 * Sessions are real `AgentSession`s. A stored exchange is the agent's own
 * initial history; a running turn is a real prompt whose provider stream the
 * test pushes events into, observed through a real `RoomWindowFeed`. The one
 * thing stubbed is `isCompacting`, set on the session instance, because an
 * auto-compaction in flight is internal to the session and has its own suites.
 *
 * NOT CAUGHT. How a window paints the snapshot (the room window suites). The
 * `model` and `cwd` fields are read straight from the session and not
 * asserted beyond being display-safe. A handle split across two deltas is the
 * stream decoder's contract (`argot-stream-event-display`), not repeated here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type RoomFeedBlock,
	type RoomWindowSnapshot,
	roomWindowName,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import {
	buildRoomWindowSnapshot,
	RoomWindowFeed,
} from "@veyyon/coding-agent/modes/terminal/controllers/room-window-feed";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { ArgotSession, type Vocabulary } from "argot";
import { type } from "arktype";

const DB = "src/db.ts";

let tempDir: TempDir;
const storages: AuthStorage[] = [];
const opened: AgentSession[] = [];

beforeAll(() => {
	tempDir = TempDir.createSync("@pi-room-window-");
});

afterEach(async () => {
	for (const session of opened.splice(0)) {
		if (session.isStreaming) await session.abort();
		await session.dispose();
	}
	for (const storage of storages.splice(0)) storage.close();
});

afterAll(() => {
	tempDir.removeSync();
});

function codec(): ArgotSession {
	const vocab: Vocabulary = { version: 1, sigil: "§", handles: new Map([["db", DB]]), meta: new Map() };
	const session = new ArgotSession();
	session.loadVocab(vocab);
	return session;
}

function tool(name: string, label: string): AgentTool {
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

const TOOLS = [tool("read", "Read"), tool("bash", "Run Command")];

let clock = 1_000;

function user(text: string, synthetic?: boolean): AgentMessage {
	return { role: "user", content: text, synthetic, timestamp: ++clock };
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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
		stopReason: "stop",
		timestamp: ++clock,
		...overrides,
	};
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function result(toolCallId: string, toolName: string, isError: boolean): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		isError,
		timestamp: ++clock,
	};
}

interface Opened {
	session: AgentSession;
	/** Resolves once the provider has been asked for the running turn. */
	called: Promise<void>;
	/** Push a provider stream event into the turn in flight. */
	push(event: AssistantMessageEvent): void;
}

/** A real session over `messages`, whose provider stream the test drives. */
async function open(messages: AgentMessage[], options: { argot?: ArgotSession } = {}): Promise<Opened> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model to exist");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${storages.length}.db`));
	storages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const called = Promise.withResolvers<void>();
	let stream: AssistantMessageEventStream | undefined;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: TOOLS, messages },
		streamFn: (_model, _context, streamOptions) => {
			const current = new AssistantMessageEventStream();
			stream = current;
			streamOptions?.signal?.addEventListener(
				"abort",
				() => current.push({ type: "error", reason: "aborted", error: assistant([], { stopReason: "aborted" }) }),
				{ once: true },
			);
			called.resolve();
			return current;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings: Settings.isolated(),
		modelRegistry,
		argot: options.argot,
	});
	opened.push(session);
	return {
		session,
		called: called.promise,
		push: event => {
			if (!stream) throw new Error("No turn is running");
			stream.push(event);
		},
	};
}

/** Wait, bounded, for `read` to hold. A hang is a failure, not a stall. */
async function until(read: () => boolean, what: string, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${ms}ms waiting for ${what}`);
		await sleep(2);
	}
}

function textBlocks(snapshot: RoomWindowSnapshot): string[] {
	return snapshot.blocks.flatMap(block => (block.kind === "text" ? [block.text] : []));
}

function toolRows(snapshot: RoomWindowSnapshot): Extract<RoomFeedBlock, { kind: "tool" }>[] {
	return snapshot.blocks.filter((block): block is Extract<RoomFeedBlock, { kind: "tool" }> => block.kind === "tool");
}

/** Every string anywhere in `value`, with the path it was found at. */
function strings(value: unknown, at = "snapshot"): Array<{ at: string; text: string }> {
	if (typeof value === "string") return [{ at, text: value }];
	if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${at}[${index}]`));
	if (value && typeof value === "object") {
		return Object.entries(value).flatMap(([key, item]) => strings(item, `${at}.${key}`));
	}
	return [];
}

describe("the state a window reports", () => {
	it("a conversation with no prompt from the operator is new", async () => {
		expect(buildRoomWindowSnapshot((await open([])).session).state).toEqual({ kind: "new" });
		const injectedOnly = (await open([user("auto-continue", true)])).session;
		expect(buildRoomWindowSnapshot(injectedOnly).state).toEqual({ kind: "new" });
		expect(buildRoomWindowSnapshot(injectedOnly).blocks).toEqual([]);
	});

	it("a finished exchange is done, at the time of its last message", async () => {
		const last = assistant([{ type: "text", text: "All set." }]);
		const { session } = await open([user("tidy the imports"), last]);
		expect(buildRoomWindowSnapshot(session).state).toEqual({ kind: "done", at: last.timestamp });
	});

	it("a turn that failed reports the first line of its error, as its state and as a note", async () => {
		const { session } = await open([
			user("deploy"),
			assistant([], { stopReason: "error", errorMessage: "Provider returned 529: overloaded\n  at retry (x.ts:1)" }),
		]);
		const snapshot = buildRoomWindowSnapshot(session);
		expect(snapshot.state).toEqual({ kind: "failed", reason: "Provider returned 529: overloaded" });
		expect(snapshot.blocks.at(-1)).toEqual({
			kind: "note",
			text: "Provider returned 529: overloaded",
			tone: "error",
		});
	});

	it("a turn the operator stopped is stopped", async () => {
		const { session } = await open([
			user("run it"),
			assistant([{ type: "text", text: "Start" }], { stopReason: "aborted" }),
		]);
		expect(buildRoomWindowSnapshot(session).state).toEqual({ kind: "stopped" });
	});

	/**
	 * The exchange starts at the operator's last prompt; a message the harness
	 * injected after it is neither the prompt nor shown. A nameless conversation
	 * goes by that prompt, not its first one: a session opened with a greeting
	 * would otherwise be called by it forever.
	 */
	it("the prompt is the last non-synthetic user message, and a nameless conversation goes by it", async () => {
		const { session } = await open([
			user("first question"),
			assistant([{ type: "text", text: "first answer" }]),
			user("second question"),
			assistant([{ type: "text", text: "second answer" }]),
			user("continue the plan", true),
			assistant([{ type: "text", text: "continued" }]),
		]);
		const snapshot = buildRoomWindowSnapshot(session);
		expect(roomWindowName(snapshot)).toBe("second question");
		expect(snapshot.blocks).toEqual([
			{ kind: "prompt", text: "second question" },
			{ kind: "text", text: "second answer" },
			{ kind: "text", text: "continued" },
		]);

		await session.sessionManager.setSessionName("parser rewrite", "user");
		expect(roomWindowName(buildRoomWindowSnapshot(session))).toBe("parser rewrite");
	});
});

describe("tool rows", () => {
	it("carry the tool's label, its primary argument, and ok, error, or error for a call that never answered", async () => {
		const { session } = await open([
			user("inspect"),
			assistant(
				[
					call("c1", "read", { path: "src/app.ts" }),
					call("c2", "bash", { command: "bun test" }),
					call("c3", "mystery", { query: "where" }),
				],
				{ stopReason: "toolUse" },
			),
			result("c1", "read", false),
			result("c2", "bash", true),
			assistant([{ type: "text", text: "done" }]),
		]);
		expect(toolRows(buildRoomWindowSnapshot(session))).toEqual([
			{ kind: "tool", label: "Read", detail: "src/app.ts", state: "ok" },
			{ kind: "tool", label: "Run Command", detail: "bun test", state: "error" },
			{ kind: "tool", label: "mystery", detail: "where", state: "error" },
		]);
	});
});

describe("display safety", () => {
	/**
	 * Every string the snapshot carries, found by walking it rather than by
	 * listing fields, so a field added later is covered: no escape, no other
	 * control byte, no tab; and nothing but a text or prompt block spans lines.
	 */
	it("no control byte, escape sequence or tab survives into any string", async () => {
		const nasty = "a\x1b[31mred\x1b[0m\tb\x07c\x1b]0;title\x07d\r\x9be";
		const { session } = await open([
			user(`fix ${nasty}\nsecond line`),
			assistant(
				[
					{ type: "text", text: `out ${nasty}\nmore` },
					call("c1", "read", { path: `src/${nasty}.ts` }),
					call("c2", `evil${nasty}`, { command: nasty }),
				],
				{ stopReason: "toolUse" },
			),
			result("c1", "read", false),
			assistant([{ type: "text", text: nasty }], { stopReason: "error", errorMessage: `boom ${nasty}\nstack` }),
		]);
		await session.sessionManager.setSessionName(`title ${nasty}`, "user");
		const snapshot = buildRoomWindowSnapshot(session);
		const found = strings(snapshot);
		expect(found.length).toBeGreaterThan(8);
		const unsafe = found.filter(({ text }) => /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text));
		expect(unsafe).toEqual([]);
		const multiLine = found.filter(({ at, text }) => text.includes("\n") && !/\.blocks\[\d+\]\.text$/.test(at));
		expect(multiLine).toEqual([]);
		// The words survive; only the bytes that would drive the terminal go.
		expect(snapshot.blocks[0]).toMatchObject({ kind: "prompt" });
		expect(snapshot.blocks[0]?.kind === "prompt" && snapshot.blocks[0].text.includes("red")).toBe(true);
	});
});

describe("a running turn", () => {
	it("reads starting, thinking, writing, tool and compacting from the session's own events", async () => {
		const live = await open([]);
		const { session, push } = live;
		const feed = new RoomWindowFeed(session, () => {});
		const turn = session.prompt("look at the database");
		try {
			await Promise.race([live.called, turn]);
			const activity = (): string | undefined => {
				const state = feed.snapshot().state;
				return state.kind === "working" ? state.activity : state.kind;
			};
			await until(() => activity() === "starting", "the turn to start");
			expect(feed.snapshot().blocks).toEqual([{ kind: "prompt", text: "look at the database" }]);

			push({ type: "start", partial: assistant([]) });
			const thinking = assistant([{ type: "thinking", thinking: "which table" }]);
			push({ type: "thinking_start", contentIndex: 0, partial: thinking });
			push({ type: "thinking_delta", contentIndex: 0, delta: "which table", partial: thinking });
			await until(() => activity() === "thinking", "thinking");
			expect(feed.snapshot().blocks.at(-1)).toEqual({ kind: "thinking" });

			const writing = assistant([...thinking.content, { type: "text", text: "Reading it now." }]);
			push({ type: "text_delta", contentIndex: 1, delta: "Reading it now.", partial: writing });
			await until(() => activity() === "writing", "writing");
			// Reasoning shows only while it is the thing being written.
			expect(feed.snapshot().blocks.map(block => block.kind)).toEqual(["prompt", "text"]);

			const readCall = call("c1", "read", { path: "src/app.ts" });
			const calling = assistant([...writing.content, readCall]);
			push({ type: "toolcall_start", contentIndex: 2, partial: calling });
			push({ type: "toolcall_end", contentIndex: 2, toolCall: readCall, partial: calling });
			await until(() => activity() === "tool", "the tool call");
			expect(toolRows(feed.snapshot())).toEqual([
				{ kind: "tool", label: "Read", detail: "src/app.ts", state: "running" },
			]);

			const running = feed.snapshot().state;
			expect(running.kind === "working" && running.since > 0).toBe(true);

			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => true });
			expect(buildRoomWindowSnapshot(session).state).toMatchObject({ kind: "working", activity: "compacting" });
		} finally {
			feed.dispose();
			if (session.isStreaming) await session.abort();
			await turn;
		}
	});
});

describe("the argot seam", () => {
	/**
	 * Stored messages keep cheap handles; the window reads them through the
	 * session's display transform. Text, the tool row's argument and a
	 * failure note all show the expansion.
	 */
	it("a stored assistant message shows its handles expanded", async () => {
		const { session } = await open(
			[
				user("check the schema"),
				assistant([{ type: "text", text: "The schema is in §db ." }, call("c1", "read", { path: "§db" })], {
					stopReason: "toolUse",
				}),
				result("c1", "read", false),
				assistant([{ type: "text", text: "Done with §db ." }]),
			],
			{ argot: codec() },
		);
		const snapshot = buildRoomWindowSnapshot(session);
		expect(textBlocks(snapshot)).toEqual([`The schema is in ${DB} .`, `Done with ${DB} .`]);
		expect(toolRows(snapshot)).toEqual([{ kind: "tool", label: "Read", detail: DB, state: "ok" }]);
		expect(strings(snapshot).filter(({ text }) => text.includes("§"))).toEqual([]);
	});

	/**
	 * The live window shows only what the session's `message_update` display
	 * event carried. The negative control feeds the same session's raw
	 * `state.streamMessage` to the same builder and shows the handle, so the
	 * seam is what this test observes, not a stream that never had one.
	 */
	it("the live stream shows what the display event carried; the raw stream message would show the handle", async () => {
		const live = await open([], { argot: codec() });
		const { session, push } = live;
		const feed = new RoomWindowFeed(session, () => {});
		const turn = session.prompt("check the schema");
		try {
			await Promise.race([live.called, turn]);
			push({ type: "start", partial: assistant([]) });
			const writing = assistant([{ type: "text", text: "Opening §db now." }]);
			push({ type: "text_delta", contentIndex: 0, delta: "Opening §db now.", partial: writing });
			await until(() => textBlocks(feed.snapshot()).length > 0, "the streamed text");

			expect(textBlocks(feed.snapshot())).toEqual([`Opening ${DB} now.`]);

			const raw = session.state.streamMessage;
			if (raw?.role !== "assistant") throw new Error("Expected the raw stream message to be the assistant's");
			expect(textBlocks(buildRoomWindowSnapshot(session, { stream: raw }))).toEqual(["Opening §db now."]);
		} finally {
			feed.dispose();
			if (session.isStreaming) await session.abort();
			await turn;
		}
	});
});
