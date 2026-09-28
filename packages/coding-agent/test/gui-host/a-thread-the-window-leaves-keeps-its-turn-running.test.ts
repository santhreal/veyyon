/**
 * WHY: the window keeps one thread open at a time, with the rest in its
 * sidebar, and a thread the operator leaves goes on working. Every gesture
 * that puts the window on another session -- clicking a row, the new-session
 * control, a branch, an export, a prompt aimed at another session, clearing
 * the output -- used to end the turn running on the session it left: the host
 * aborted it, filed the partial reply and the row settled as `Aborted`, so
 * looking at another thread cost the work on this one.
 *
 * The class this closes: any host action that leaves a session a turn is
 * running on. The action set is read at run time off every handler table that
 * holds an action whose payload names a session -- sessions, turn,
 * diagnostics, commands, goals, plan review, share, foreground and history --
 * and every member is driven with a turn in flight, so a new action in one of
 * them that switches sessions fails here until its payload and its class are
 * recorded. The invariant is derived from what the action did rather than
 * written per action: an action after which the client no longer holds the
 * session must have cleared the stream before stating anything of the next
 * one, left the turn running (the file holds the prompt and no reply yet), and
 * left it reachable, so a stop aimed at it by its own id ends it and files the
 * partial reply with the session that produced it.
 * The same holds for a leave sent right behind the request that starts the
 * turn, before anything states the thread is working: a thread's first prompt
 * builds the agent that runs it, and a leave that got there first left the
 * turn with no owner and the client back on the thread it left. Every request
 * that carries text into a turn is swept in front of every leave onto a
 * session on disk, and in front of an open of a thread working in the
 * background, which is taken back rather than opened.
 * Around the sweep: a reply that finishes off screen lands in its own file and
 * sends the window nothing but its row; a thread opened again mid-reply has its
 * reply restated behind its transcript; a stop aimed at one thread leaves the
 * other alone; and what ends a thread outright still ends it -- a delete, a
 * branch of the thread on screen, the window going away.
 *
 * What it does not catch: the window's own drawing of a cleared or restated
 * stream, which `crates/veyyon-desktop-app` owns; decisions, extension chrome
 * and the release of an idle background session, which
 * `a-thread-working-in-the-background-reaches-the-window-under-its-own-id`
 * covers; an action in a table outside the nine that starts naming a
 * session; a share joined over the thread on screen, which replaces that
 * session in place once the relay answers and ends its turn as the terminal's
 * `/join` does, and which needs a relay this suite does not run; and a client
 * that vanishes without closing its socket, which the connection's teardown
 * reaches only when the socket is seen to close. The requests that start work
 * without text -- a retry, a rephrase, a plan review, a goal, a compaction --
 * wait for their work the same way (`startingWork`), but each needs a state
 * of its own to start from, and the right-behind sweep does not build it.
 * Onto a thread working in the background only the open is sent right behind
 * a start: every other leave that names that thread reaches it through the
 * same take-back in `activateSession`, and most of them ask the model about
 * the thread, whose held reply would hold them too.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context, StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { getAgentDir } from "@veyyon/utils";
import { isSessionFileName } from "@veyyon/utils/session-file";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { commandsActionHandlers } from "../../src/gui-host/actions/commands";
import { diagnosticsActionHandlers } from "../../src/gui-host/actions/diagnostics";
import { foregroundActionHandlers } from "../../src/gui-host/actions/foreground";
import { goalActionHandlers } from "../../src/gui-host/actions/goals";
import { historyActionHandlers } from "../../src/gui-host/actions/history";
import { planReviewActionHandlers } from "../../src/gui-host/actions/plan-review";
import { sessionsActionHandlers } from "../../src/gui-host/actions/sessions";
import { shareActionHandlers } from "../../src/gui-host/actions/share";
import { turnActionHandlers } from "../../src/gui-host/actions/turn";
import type { ActionHandlersMap } from "../../src/gui-host/actions/types";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The prompt whose turn this suite leaves in flight. */
const PROMPT = "Do heavy reasoning";
/** What the model had produced when the turn was left. */
const PARTIAL = "Thinking deeply...";
/** What the model adds once the test lets the reply finish. */
const REST = " and done.";

interface SessionRow {
	id: string;
	title: string | null;
	status: string;
}

type SessionsSection = [{ revision: number; value: SessionRow[] }, unknown[]];
type ActiveSessionSection = { revision: number; value: SessionRow };

/**
 * Every handler table holding an action whose payload names a session: the
 * only actions that can move the client off the session it holds.
 */
const SWEPT_TABLES: ActionHandlersMap[] = [
	sessionsActionHandlers,
	turnActionHandlers,
	diagnosticsActionHandlers,
	commandsActionHandlers,
	goalActionHandlers,
	planReviewActionHandlers,
	shareActionHandlers,
	foregroundActionHandlers,
	historyActionHandlers,
];

/**
 * A payload per host action, naming the other session where the action takes
 * one and the session on screen where it acts on the turn itself. Every action
 * the swept tables dispatch has a row, which the sweep asserts by exact
 * equality, so a new action arrives here as a red test rather than as a gap.
 */
const PAYLOADS: Record<string, (other: string, onScreen: string) => unknown> = {
	ListSessions: () => ({}),
	OpenSession: other => ({ session: other }),
	CreateSession: () => ({}),
	RenameSession: other => ({ session: other, title: "renamed elsewhere" }),
	DeleteSession: other => ({ session: other }),
	BranchSession: other => ({ session: other }),
	ExportSession: other => ({ session: other, format: "json" }),
	CompactSession: other => ({ session: other }),
	HandoffSession: other => ({ session: other }),
	LoadTranscript: other => ({ session: other }),
	SubmitPrompt: other => ({ session: other, text: "a prompt for the other session" }),
	Steer: other => ({ session: other, text: "a steer for the other session" }),
	FollowUp: other => ({ session: other, text: "a follow-up for the other session" }),
	AbortTurn: (_other, onScreen) => ({ session: onScreen }),
	RetryTurn: other => ({ session: other }),
	RephraseReply: other => ({ session: other }),
	SetQueueMode: (_other, onScreen) => ({ session: onScreen, mode: "Queue" }),
	SetSessionMode: (_other, onScreen) => ({ session: onScreen, mode: "plan" }),
	DequeueQueuedPrompt: other => ({ session: other }),
	CancelTool: (_other, onScreen) => ({ session: onScreen, tool_call_id: "call-that-is-not-running" }),
	SetToolViewExpanded: (_other, onScreen) => ({ session: onScreen, call_id: "call-1", expanded: true }),
	RespondToInteraction: (_other, onScreen) => ({
		session: onScreen,
		interaction_id: "interaction-that-is-not-waiting",
		response: null,
	}),
	RefreshDiagnostics: () => ({}),
	RetryDiagnosticSource: () => ({ source: "not-a-source" }),
	ClearOutput: (_other, onScreen) => ({ session: onScreen }),
	GetUsage: (_other, onScreen) => ({ session: onScreen }),
	GetContextBreakdown: (_other, onScreen) => ({ session: onScreen }),
	ListCommands: () => ({}),
	RunCommand: other => ({ session: other, text: "/not-a-command-anywhere" }),
	SetGoal: other => ({ session: other, objective: "a goal for the other session", token_budget: null }),
	ControlGoal: other => ({ session: other, op: "pause" }),
	ReviewPlan: other => ({ session: other }),
	// The relay is configured empty, so starting a share is refused before
	// anything reaches the network.
	StartShare: () => ({ read_only: true }),
	StopShare: () => ({}),
	RefreshShare: () => ({}),
	JoinShare: other => ({ session: other, link: "not-a-collab-link" }),
	LeaveShare: () => ({}),
	BackgroundCommand: (_other, onScreen) => ({ session: onScreen }),
	SearchSessions: () => ({ query: "elsewhere" }),
	PreviewSessionTranscript: other => ({ session: other }),
	SearchPromptHistory: () => ({ query: "heavy" }),
};

/**
 * The actions that put the client on another session. Pinned by exact
 * equality: an action that starts or stops switching is a decision, not a
 * detail.
 */
const LEAVES_THE_SESSION = [
	"BranchSession",
	"ClearOutput",
	"CompactSession",
	"ControlGoal",
	"CreateSession",
	"DequeueQueuedPrompt",
	"ExportSession",
	"FollowUp",
	"HandoffSession",
	"JoinShare",
	"LoadTranscript",
	"OpenSession",
	"RephraseReply",
	"RetryTurn",
	"ReviewPlan",
	"RunCommand",
	"SetGoal",
	"Steer",
	"SubmitPrompt",
];

/** A command in the agent's own command directory whose body is this suite's prompt. */
const COMMAND = "heavy";

/**
 * The requests that carry text into a turn, each with the text that starts
 * this suite's turn through it. Pinned against the `PAYLOADS` rows whose
 * payload holds text, so an action that starts carrying text into a turn is
 * swept here or recorded.
 */
const STARTS_A_TURN: Record<string, string> = {
	FollowUp: PROMPT,
	RunCommand: `/${COMMAND}`,
	Steer: PROMPT,
	SubmitPrompt: PROMPT,
};

function carriesText(payload: unknown): boolean {
	return typeof payload === "object" && payload !== null && "text" in payload;
}

function assistantMessage(text: string, stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason,
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

/** Finishes the reply a held stream is waiting on. */
type Finish = () => void;

/**
 * A stream that delivers one delta and then waits: for the abort signal, which
 * ends it `aborted` with the delta, or for the test to finish it. Each one's
 * finisher is pushed onto `finishers` in the order the requests were made.
 */
function heldStream(signal: AbortSignal | undefined, finishers: Finish[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const partial = assistantMessage(PARTIAL, "stop");
	let over = false;
	signal?.addEventListener("abort", () => {
		if (over) return;
		over = true;
		stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
	});
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...partial, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...partial, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: PARTIAL, partial });
	});
	finishers.push(() => {
		if (over) return;
		over = true;
		const full = assistantMessage(PARTIAL + REST, "stop");
		stream.push({ type: "text_delta", contentIndex: 0, delta: REST, partial: full });
		stream.push({ type: "text_end", contentIndex: 0, content: PARTIAL + REST, partial: full });
		stream.push({ type: "done", reason: "stop", message: full });
	});
	return stream;
}

/** A stream that finishes on its own, for every request that is not the turn under test. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text, "stop");
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

/**
 * The request that carries this suite's prompt into a turn: the session's own
 * messages, and not the title generator's single `<user>`-wrapped copy of them.
 */
function isTheTurnUnderTest(context: Context): boolean {
	const first = context.messages[0]?.content;
	if (context.messages.length === 1 && typeof first === "string" && first.startsWith("<user>")) return false;
	return JSON.stringify(context.messages).includes(PROMPT);
}

function isClear(frame: RequestFrame): boolean {
	return "StreamingChanged" in frame && frame.StreamingChanged === null;
}

function isStream(frame: RequestFrame): boolean {
	return ("StreamingChanged" in frame && frame.StreamingChanged !== null) || "StreamingAppended" in frame;
}

function isHeaderOrTranscript(frame: RequestFrame): boolean {
	return frame.Snapshot !== undefined && ("ActiveSession" in frame.Snapshot || "Transcript" in frame.Snapshot);
}

/** Whether the stream was cleared before anything of the next session was stated. */
function clearedFirst(frames: RequestFrame[]): boolean {
	const cleared = frames.findIndex(isClear);
	const next = frames.findIndex(isHeaderOrTranscript);
	return cleared >= 0 && (next < 0 || cleared < next);
}

/**
 * The roles of the conversation the last transcript in `frames` holds, without
 * the `Custom` entries the session files for its own model and settings.
 */
function conversationRoles(frames: RequestFrame[]): string[] | undefined {
	return snapshotSections<{ value: Array<{ role: string }> }>(frames, "Transcript")
		.at(-1)
		?.value.map(entry => entry.role)
		.filter(role => role !== "Custom");
}

// The host re-reads the command catalogue off the process's profile whatever
// agent dir it was started with, so the command this suite runs lives in a
// profile of this file's own.
useIsolatedAgentDir();

describe("a thread the window leaves keeps its turn running", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let finishers: Finish[] = [];
	/** Settles when the model is asked for the turn under test. */
	let turnRequested = Promise.withResolvers<void>();

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-leave-turn-"));
		const profile = getAgentDir();
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(profile, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			path.join(profile, "config.yml"),
			'modelRoles:\n  default: openai/gpt-4o-mini\ncollab:\n  relayUrl: ""\n',
			"utf8",
		);
		await fs.mkdir(path.join(profile, "commands"), { recursive: true });
		await fs.writeFile(path.join(profile, "commands", `${COMMAND}.md`), `${PROMPT}\n`, "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		finishers = [];
		turnRequested = Promise.withResolvers<void>();
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context, options) => {
			if (!isTheTurnUnderTest(context)) return completedStream("Answered.");
			turnRequested.resolve();
			return heldStream(options?.signal, finishers);
		});
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: profile,
			authStorage,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** A client of its own, so one action's leftover frames cannot be read as the next one's. */
	async function connect(): Promise<TestSocketClient> {
		if (!server) throw new Error("the host is not running");
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		return client;
	}

	/** A session on disk the desktop can navigate to, with one message of its own. */
	async function sessionOnDisk(text: string): Promise<string> {
		const storage = new FileSessionStorage();
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		await sm.flush();
		await sm.ensureOnDisk();
		return sm.getSessionId();
	}

	/**
	 * Create a session through the wire and start a turn on it that runs until
	 * the test finishes or stops it. Uses request ids `first` and `first + 1`.
	 */
	async function sessionWithATurnInFlight(client: TestSocketClient, first = 1): Promise<string> {
		const created = await client.request(first, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		const submitted = await client.request(first + 1, { SubmitPrompt: { session, text: PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: first + 1 } });
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			if ("StreamingChanged" in frame && frame.StreamingChanged !== null) return session;
		}
		throw new Error("the reply never started streaming");
	}

	/** The messages `session` holds on disk, as `role/stopReason:content`. */
	async function messagesOnDisk(session: string): Promise<string[]> {
		for (const file of await fs.readdir(sessionDir)) {
			// The directory also holds the picker's `.session-list-index.json`
			// cache, which is not a session file and fails to open as one.
			if (!isSessionFileName(file)) continue;
			const sm = await SessionManager.open(path.join(sessionDir, file), undefined, undefined, {
				suppressBreadcrumb: true,
			});
			if (sm.getSessionId() !== session) continue;
			const described: string[] = [];
			for (const entry of sm.getEntries()) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				const stop = "stopReason" in message ? message.stopReason : "-";
				const content = "content" in message ? message.content : undefined;
				described.push(`${message.role}/${stop}:${JSON.stringify(content)}`);
			}
			return described;
		}
		throw new Error(`no file on disk holds session ${session}`);
	}

	const prompt = `user/-:${JSON.stringify([{ type: "text", text: PROMPT }])}`;
	const partial = `assistant/aborted:${JSON.stringify([{ type: "text", text: PARTIAL }])}`;
	const finished = `assistant/stop:${JSON.stringify([{ type: "text", text: PARTIAL + REST }])}`;

	/**
	 * Whether the client still has `session` open, asked in the host's own
	 * vocabulary and with no effect either way: `SetToolViewExpanded` refuses a
	 * session that is not the client's open one with `SESSION_NOT_FOUND`, and
	 * refuses an unknown call on it with `CALL_NOT_FOUND`. Reading a snapshot
	 * instead would miss every action that switches and then fails, which
	 * states no header of its own.
	 */
	async function stillOpen(client: TestSocketClient, session: string, id: number): Promise<boolean> {
		const answer = await client.request(id, {
			SetToolViewExpanded: { session, call_id: "call-that-was-never-made", expanded: true },
		});
		const code = answer.outcome.RequestFailed?.error.code;
		if (code === "CALL_NOT_FOUND") return true;
		if (code === "SESSION_NOT_FOUND") return false;
		throw new Error(`the probe for ${session} answered ${JSON.stringify(answer.outcome)}`);
	}

	// Forty-one actions, each driving a real turn to the point where the
	// model has produced something and then leaving it: past bun's unit-test
	// budget, and bounded by the assertions rather than by the clock.
	test("no action that leaves a thread ends the turn running on it", async () => {
		expect(Object.keys(PAYLOADS).sort()).toEqual(SWEPT_TABLES.flatMap(table => Object.keys(table)).sort());

		const left: string[] = [];
		let id = 100;
		for (const [action, payloadFor] of Object.entries(PAYLOADS)) {
			const client = await connect();
			try {
				const onScreen = await sessionWithATurnInFlight(client);
				const other = await sessionOnDisk(`a session ${action} can name`);
				id += 3;
				const answer = await client.request(id, { [action]: payloadFor(other, onScreen) });
				const cleared = answer.frames.some(isClear);
				if (await stillOpen(client, onScreen, id + 1)) {
					// Nothing left the session. A stream cleared here is the
					// action's own doing -- the stop control -- and it files the
					// reply with the session that produced it.
					expect([action, await messagesOnDisk(onScreen)]).toEqual([
						action,
						cleared ? [prompt, partial] : [prompt],
					]);
					continue;
				}
				left.push(action);
				// The window draws another thread now: the stream it held for this
				// one is cleared before anything of that thread arrives, and the
				// turn goes on, so no reply has reached the file yet.
				expect([action, clearedFirst(answer.frames), await messagesOnDisk(onScreen)]).toEqual([
					action,
					true,
					[prompt],
				]);
				// It is still running, and still this session's: a stop aimed at it
				// by its own id ends it and files the partial reply with it.
				const stopped = await client.request(id + 2, { AbortTurn: { session: onScreen } });
				expect([action, stopped.outcome]).toEqual([action, { RequestSucceeded: { request: id + 2 } }]);
				expect([action, await messagesOnDisk(onScreen)]).toEqual([action, [prompt, partial]]);
			} finally {
				client.destroy();
			}
		}
		expect(left.sort()).toEqual(LEAVES_THE_SESSION);
	}, 180_000);

	// The window sends a leave in the same breath as the prompt when the
	// operator opens another thread right after pressing Enter. The leave then
	// reaches the host while the prompt is still starting its turn -- a
	// thread's first prompt builds the agent that runs it -- and nothing yet
	// states the thread is working. Every request that carries text into a
	// turn is swept as the one in front, against every leave behind it.
	test("a leave sent right behind the request that starts a turn leaves the turn running", async () => {
		const carrying = Object.entries(PAYLOADS)
			.filter(([, payloadFor]) => carriesText(payloadFor("", "")))
			.map(([action]) => action);
		expect(carrying.sort()).toEqual(Object.keys(STARTS_A_TURN).sort());

		let id = 100;
		for (const [starter, text] of Object.entries(STARTS_A_TURN)) {
			for (const action of LEAVES_THE_SESSION) {
				const payloadFor = PAYLOADS[action];
				if (!payloadFor) throw new Error(`no payload for ${action}`);
				const pair = `${starter} then ${action}`;
				turnRequested = Promise.withResolvers<void>();
				const client = await connect();
				try {
					const created = await client.request(id, { CreateSession: {} });
					const onScreen = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value
						.id;
					if (!onScreen) throw new Error("CreateSession emitted no ActiveSession");
					const other = await sessionOnDisk(`a session ${action} can name`);
					const [start, leave, probe, stop] = [id + 1, id + 2, id + 3, id + 5];
					id += 10;
					client.send({ id: start, action: { [starter]: { session: onScreen, text } } });
					client.send({ id: leave, action: { [action]: payloadFor(other, onScreen) } });
					const frames: RequestFrame[] = [];
					const outcomes = new Map<number, RequestFrame>();
					while (outcomes.size < 2) {
						const frame = (await client.nextFrame()) as RequestFrame;
						frames.push(frame);
						const answered = frame.RequestSucceeded?.request ?? frame.RequestFailed?.request;
						if (answered === start || answered === leave) outcomes.set(answered, frame);
					}
					expect([pair, outcomes.get(start)]).toEqual([pair, { RequestSucceeded: { request: start } }]);
					await turnRequested.promise;

					// The client is off the session it left, and on the one the
					// window was last told of, when it was told of one.
					expect([pair, await stillOpen(client, onScreen, probe)]).toEqual([pair, false]);
					const told = snapshotSections<ActiveSessionSection>(frames, "ActiveSession").at(-1)?.value.id;
					if (told) expect([pair, await stillOpen(client, told, probe + 1)]).toEqual([pair, true]);

					// The turn is running, and still the left session's own.
					const stopped = await client.request(stop, { AbortTurn: { session: onScreen } });
					expect([pair, stopped.outcome]).toEqual([pair, { RequestSucceeded: { request: stop } }]);
					expect([pair, await messagesOnDisk(onScreen)]).toEqual([pair, [prompt, partial]]);
				} finally {
					client.destroy();
				}
			}
		}
	}, 180_000);

	// A thread working in the background is taken back rather than opened from
	// disk, and that path leaves the thread on screen as well: a leave onto it
	// right behind a request that starts a turn waits for that turn the same
	// way, or the turn is built on the agent the leave took back.
	test("a leave onto a thread working in the background waits for the turn in front of it", async () => {
		let id = 1_000;
		for (const [starter, text] of Object.entries(STARTS_A_TURN)) {
			const client = await connect();
			try {
				const working = await sessionWithATurnInFlight(client, id);
				const created = await client.request(id + 2, { CreateSession: {} });
				const onScreen = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
				if (!onScreen) throw new Error("CreateSession emitted no ActiveSession");
				const [start, leave, probe, stop] = [id + 3, id + 4, id + 5, id + 7];
				id += 10;
				turnRequested = Promise.withResolvers<void>();
				client.send({ id: start, action: { [starter]: { session: onScreen, text } } });
				client.send({ id: leave, action: { OpenSession: { session: working } } });
				const outcomes = new Map<number, RequestFrame>();
				while (outcomes.size < 2) {
					const frame = (await client.nextFrame()) as RequestFrame;
					const answered = frame.RequestSucceeded?.request ?? frame.RequestFailed?.request;
					if (answered === start || answered === leave) outcomes.set(answered, frame);
				}
				expect([starter, outcomes.get(start), outcomes.get(leave)]).toEqual([
					starter,
					{ RequestSucceeded: { request: start } },
					{ RequestSucceeded: { request: leave } },
				]);
				await turnRequested.promise;

				expect([starter, await stillOpen(client, onScreen, probe)]).toEqual([starter, false]);
				expect([starter, await stillOpen(client, working, probe + 1)]).toEqual([starter, true]);
				// Each turn is its own thread's, and running: a stop aimed at the
				// one left ends it alone.
				const stopped = await client.request(stop, { AbortTurn: { session: onScreen } });
				expect([starter, stopped.outcome]).toEqual([starter, { RequestSucceeded: { request: stop } }]);
				expect([starter, await messagesOnDisk(onScreen), await messagesOnDisk(working)]).toEqual([
					starter,
					[prompt, partial],
					[prompt],
				]);
			} finally {
				client.destroy();
			}
		}
	});

	// A leave waits for the request in front only until that request has
	// started its work or given up. One the host refuses after it began --
	// a prompt into a thread already mid-turn, with no queue mode set --
	// must not hold the leave behind it; if it did, this test times out.
	test("a leave behind a prompt the host refuses is not held by it", async () => {
		const client = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(client);
			const other = await sessionOnDisk("elsewhere");
			client.send({ id: 3, action: { SubmitPrompt: { session: onScreen, text: "a second prompt" } } });
			client.send({ id: 4, action: { OpenSession: { session: other } } });
			const outcomes = new Map<number, unknown>();
			while (outcomes.size < 2) {
				const frame = (await client.nextFrame()) as RequestFrame;
				if (frame.RequestSucceeded) outcomes.set(frame.RequestSucceeded.request, "succeeded");
				if (frame.RequestFailed) outcomes.set(frame.RequestFailed.request, frame.RequestFailed.error.code);
			}
			expect(Object.fromEntries(outcomes)).toEqual({ 3: "TURN_IN_PROGRESS", 4: "succeeded" });
			expect(await stillOpen(client, other, 5)).toBeTrue();
		} finally {
			client.destroy();
		}
	});

	test("the clear reaches the client before the transcript it switched to", async () => {
		const client = await connect();
		try {
			await sessionWithATurnInFlight(client);
			const other = await sessionOnDisk("elsewhere");
			const opened = await client.request(3, { OpenSession: { session: other } });
			expect(opened.outcome).toEqual({ RequestSucceeded: { request: 3 } });

			// Order is the contract: the window files a stream under the thread it
			// has open, so a clear that arrives after the next header lands on the
			// next thread and leaves the reply drawn over the one left behind.
			expect(clearedFirst(opened.frames)).toBeTrue();
			const transcript = snapshotSections<{ value: Array<{ role: string; content: unknown }> }>(
				opened.frames,
				"Transcript",
			).at(-1);
			expect(transcript?.value.map(entry => entry.role)).toEqual(["User"]);
			expect(transcript?.value[0]?.content).toEqual([{ Text: { text: "elsewhere" } }]);
		} finally {
			client.destroy();
		}
	});

	test("a reply that finishes off screen lands in its own file and sends the window only its row", async () => {
		const client = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(client);
			const other = await sessionOnDisk("elsewhere");
			await client.request(3, { OpenSession: { session: other } });

			const [finish] = finishers;
			if (!finish) throw new Error("the turn under test made no request");
			finish();
			// The row is re-listed when the turn ends, and that listing is the
			// only thing of the thread the window is sent.
			const between: RequestFrame[] = [];
			let rows: SessionRow[] | undefined;
			for (let read = 0; read < 200 && !rows; read++) {
				const frame = (await client.nextFrame()) as RequestFrame;
				rows = snapshotSections<SessionsSection>([frame], "Sessions").at(-1)?.[0].value;
				if (!rows) between.push(frame);
			}
			expect(rows?.find(row => row.id === onScreen)?.status).toBe("Complete");
			expect(between.filter(frame => isStream(frame) || "TranscriptAppended" in frame)).toEqual([]);
			expect(await messagesOnDisk(onScreen)).toEqual([prompt, finished]);

			// The thread opened again reads the finished reply from its file and
			// has no stream to restate.
			const reopened = await client.request(4, { OpenSession: { session: onScreen } });
			expect(reopened.frames.some(isStream)).toBeFalse();
			expect(conversationRoles(reopened.frames)).toEqual(["User", "Assistant"]);
		} finally {
			client.destroy();
		}
	});

	test("a thread opened again mid-reply has the reply restated behind its transcript", async () => {
		const client = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(client);
			const other = await sessionOnDisk("elsewhere");
			await client.request(3, { OpenSession: { session: other } });

			const reopened = await client.request(4, { OpenSession: { session: onScreen } });
			expect(reopened.outcome).toEqual({ RequestSucceeded: { request: 4 } });
			// Nothing is cleared: the stream the window held for this thread went
			// when it left, and the reply so far is stated whole right behind the
			// transcript it streams under, which holds the prompt alone.
			expect(reopened.frames.some(isClear)).toBeFalse();
			const transcriptAt = reopened.frames.findIndex(
				frame => frame.Snapshot !== undefined && "Transcript" in frame.Snapshot,
			);
			const streamAt = reopened.frames.findIndex(isStream);
			expect(transcriptAt).toBeGreaterThanOrEqual(0);
			expect(streamAt).toBe(transcriptAt + 1);
			expect(JSON.stringify(reopened.frames[streamAt]?.StreamingChanged)).toContain(PARTIAL);
			expect(conversationRoles(reopened.frames)).toEqual(["User"]);

			// It is the same turn, taken back as it was: the stop ends it.
			const stopped = await client.request(5, { AbortTurn: { session: onScreen } });
			expect(stopped.outcome).toEqual({ RequestSucceeded: { request: 5 } });
			expect(await messagesOnDisk(onScreen)).toEqual([prompt, partial]);
		} finally {
			client.destroy();
		}
	});

	test("a stop aimed at one thread ends that thread's turn and leaves the other's", async () => {
		const client = await connect();
		try {
			const behind = await sessionWithATurnInFlight(client, 1);
			const onScreen = await sessionWithATurnInFlight(client, 3);

			// A session neither open nor working has nothing to stop, and the
			// open one does not stand in for it.
			const nowhere = await sessionOnDisk("idle on disk");
			const refused = await client.request(5, { AbortTurn: { session: nowhere } });
			expect(refused.outcome.RequestFailed?.error.code).toBe("NOT_RUNNING");

			const stopped = await client.request(6, { AbortTurn: { session: behind } });
			expect(stopped.outcome).toEqual({ RequestSucceeded: { request: 6 } });
			// The window has the other thread open, so the stop sends it no clear.
			expect(stopped.frames.some(isClear)).toBeFalse();
			expect(await messagesOnDisk(behind)).toEqual([prompt, partial]);
			expect(await messagesOnDisk(onScreen)).toEqual([prompt]);

			const stoppedOpen = await client.request(7, { AbortTurn: { session: onScreen } });
			expect(stoppedOpen.outcome).toEqual({ RequestSucceeded: { request: 7 } });
			expect(await messagesOnDisk(onScreen)).toEqual([prompt, partial]);
		} finally {
			client.destroy();
		}
	});

	test("the window going away ends every thread it left running and keeps their replies", async () => {
		const client = await connect();
		const behind = await sessionWithATurnInFlight(client, 1);
		const onScreen = await sessionWithATurnInFlight(client, 3);
		expect(await messagesOnDisk(behind)).toEqual([prompt]);

		client.destroy();
		if (!server) throw new Error("the host is not running");
		await server.close();
		server = null;
		expect(await messagesOnDisk(behind)).toEqual([prompt, partial]);
		expect(await messagesOnDisk(onScreen)).toEqual([prompt, partial]);
	});

	test("deleting a thread left running ends its turn", async () => {
		const client = await connect();
		try {
			const behind = await sessionWithATurnInFlight(client, 1);
			await sessionWithATurnInFlight(client, 3);
			const deleted = await client.request(5, { DeleteSession: { session: behind } });
			expect(deleted.outcome).toEqual({ RequestSucceeded: { request: 5 } });
			const stopped = await client.request(6, { AbortTurn: { session: behind } });
			expect(stopped.outcome.RequestFailed?.error.code).toBe("NOT_RUNNING");
		} finally {
			client.destroy();
		}
	});

	test("branching the thread on screen ends the turn it branches away from", async () => {
		// A branch reloads the session under its own running turn, so the branch
		// is the only thing that can end it.
		const client = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(client);
			const branched = await client.request(3, { BranchSession: { session: onScreen } });
			expect(branched.outcome).toEqual({ RequestSucceeded: { request: 3 } });
			expect(branched.frames.some(isClear)).toBeTrue();
			expect(await messagesOnDisk(onScreen)).toEqual([prompt, partial]);
		} finally {
			client.destroy();
		}
	});

	test("a switch with no turn running states no clear and leaves nothing behind", async () => {
		const client = await connect();
		try {
			const created = await client.request(1, { CreateSession: {} });
			const idle = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
			if (!idle) throw new Error("CreateSession emitted no ActiveSession");
			const other = await sessionOnDisk("elsewhere");

			const opened = await client.request(2, { OpenSession: { session: other } });
			expect(opened.outcome).toEqual({ RequestSucceeded: { request: 2 } });
			expect(opened.frames.some(isClear)).toBeFalse();
			const stopped = await client.request(3, { AbortTurn: { session: idle } });
			expect(stopped.outcome.RequestFailed?.error.code).toBe("NOT_RUNNING");
		} finally {
			client.destroy();
		}
	});
});
