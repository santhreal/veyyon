/**
 * WHY: one connection holds one `AgentSession`, so every gesture that puts the
 * desktop on another session -- clicking a row in the rail, the new-session
 * control, a branch, an export, a prompt aimed at a session other than the one
 * on screen -- reloads that session in place. `AgentSession` ends the turn in
 * flight on its own, but as an internal abort taken after the agent is already
 * disconnected: no `message_end` reaches the host's listeners, so the reply the
 * model had already produced was appended nowhere and never persisted,
 * `StreamingChanged` was never cleared -- the window went on drawing the
 * abandoned reply over the transcript it had just switched to, with the composer
 * still in its running shape and nothing ever arriving to end it -- and the
 * session file trailed a prompt with no reply after it, which the index reports
 * as `Pending` and the rail draws as `Working`, counting up, for a turn that was
 * over.
 *
 * The class this closes: any host action that leaves the session a turn is
 * running on. The action set is read off the host's own two handler tables at
 * run time and every member is driven with a turn in flight, so a new action
 * that switches sessions fails here until its payload and its class are
 * recorded. The invariant is derived from what the action did rather than
 * written per action: an action whose frames state a different active session
 * must also have cleared the stream, and an action that cleared the stream must
 * have left the partial reply in the session that produced it.
 *
 * What it does not catch: the window's own drawing of a cleared stream, which
 * `crates/veyyon-desktop-surface` owns; a turn abandoned by a client that
 * vanishes without closing its socket, which the connection's teardown reaches
 * only when the socket is seen to close; and `HandoffSession`, which activates
 * the session it names before it refuses for a running turn, so its refusal
 * only ever guarded the session already on screen -- ending the turn deliberately
 * is what makes the two paths agree, and nothing here asserts the handoff itself.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context, StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { type GuiHostServer, type HostEvent, startGuiHostServer } from "../../src/gui-host";
import { sessionsActionHandlers } from "../../src/gui-host/actions/sessions";
import { turnActionHandlers } from "../../src/gui-host/actions/turn";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The prompt whose turn this suite leaves in flight. */
const PROMPT = "Do heavy reasoning";
/** What the model had produced when the turn was left, and must not lose. */
const PARTIAL = "Thinking deeply...";

interface SessionRow {
	id: string;
	title: string | null;
	status: string;
}

type SessionsSection = [{ revision: number; value: SessionRow[] }, unknown[]];
type ActiveSessionSection = { revision: number; value: SessionRow };

/**
 * A payload per host action, naming the other session where the action takes
 * one and the session on screen where it acts on the turn itself. Every action
 * the host dispatches has a row, which the sweep below asserts by exact
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
	SetQueueMode: (_other, onScreen) => ({ session: onScreen, mode: "Queue" }),
	DequeueQueuedPrompt: other => ({ session: other }),
	CancelTool: (_other, onScreen) => ({ session: onScreen, tool_call_id: "call-that-is-not-running" }),
	SetToolViewExpanded: (_other, onScreen) => ({ session: onScreen, call_id: "call-1", expanded: true }),
	RespondToInteraction: (_other, onScreen) => ({
		session: onScreen,
		interaction_id: "interaction-that-is-not-waiting",
		response: null,
	}),
};

/**
 * The actions that put the client on another session, and so end the turn.
 * Pinned by exact equality: an action that starts or stops switching is a
 * decision, not a detail.
 */
const LEAVES_THE_SESSION = [
	"BranchSession",
	"CompactSession",
	"CreateSession",
	"DequeueQueuedPrompt",
	"ExportSession",
	"FollowUp",
	"HandoffSession",
	"LoadTranscript",
	"OpenSession",
	"Steer",
	"SubmitPrompt",
];

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

/** A stream that delivers one delta and then waits for the abort signal. */
function abortableStream(signal: AbortSignal | undefined): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(PARTIAL, "stop");
	signal?.addEventListener("abort", () => {
		stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
	});
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: PARTIAL, partial: message });
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

describe("a turn the desktop leaves behind is ended and stated", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-leave-turn-"));
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context, options) =>
			isTheTurnUnderTest(context) ? abortableStream(options?.signal) : completedStream("Answered."),
		);
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
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

	/** Create a session through the wire and start a turn on it that never finishes. */
	async function sessionWithATurnInFlight(client: TestSocketClient): Promise<string> {
		const created = await client.request(1, { CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession emitted no ActiveSession");
		const submitted = await client.request(2, { SubmitPrompt: { session, text: PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("StreamingChanged" in frame && frame.StreamingChanged !== null) return session;
		}
		throw new Error("the reply never started streaming");
	}

	/** The messages `session` holds on disk, as `role/stopReason:text`. */
	async function messagesOnDisk(session: string): Promise<string[]> {
		for (const file of await fs.readdir(sessionDir)) {
			const sm = await SessionManager.open(path.join(sessionDir, file), undefined, undefined, {
				suppressBreadcrumb: true,
			});
			if (sm.getSessionId() !== session) continue;
			return sm
				.getEntries()
				.filter((entry: SessionEntry) => entry.type === "message")
				.map(entry => {
					const message = (entry as { message: { role: string; stopReason?: string; content: unknown } }).message;
					return `${message.role}/${message.stopReason ?? "-"}:${JSON.stringify(message.content)}`;
				});
		}
		throw new Error(`no file on disk holds session ${session}`);
	}

	function clearedIn(frames: RequestFrame[]): boolean {
		return frames.some(frame => "StreamingChanged" in frame && frame.StreamingChanged === null);
	}

	/**
	 * Whether the client still holds `session`, asked in the host's own
	 * vocabulary and with no effect either way: `SetToolViewExpanded` refuses a
	 * session that is not the client's with `SESSION_NOT_FOUND`, and refuses an
	 * unknown call on the client's own session with `CALL_NOT_FOUND`. Reading a
	 * snapshot instead would miss every action that switches and then fails,
	 * which states no header of its own.
	 */
	async function stillHolds(client: TestSocketClient, session: string, id: number): Promise<boolean> {
		const answer = await client.request(id, {
			SetToolViewExpanded: { session, call_id: "call-that-was-never-made", expanded: true },
		});
		const code = answer.outcome.RequestFailed?.error.code;
		if (code === "CALL_NOT_FOUND") return true;
		if (code === "SESSION_NOT_FOUND") return false;
		throw new Error(`the probe for ${session} answered ${JSON.stringify(answer.outcome)}`);
	}

	// Nineteen actions, each driving a real turn to the point where the model has
	// produced something and then leaving it: past bun's unit-test budget, and
	// bounded by the assertions rather than by the clock.
	test("no action leaves a turn running on a session the client no longer holds", async () => {
		expect(Object.keys(PAYLOADS).sort()).toEqual(
			[...Object.keys(sessionsActionHandlers), ...Object.keys(turnActionHandlers)].sort(),
		);

		const prompt = `user/-:${JSON.stringify([{ type: "text", text: PROMPT }])}`;
		const partial = `assistant/aborted:${JSON.stringify([{ type: "text", text: PARTIAL }])}`;
		const switched: string[] = [];
		let id = 100;
		for (const [action, payloadFor] of Object.entries(PAYLOADS)) {
			const client = await connect();
			try {
				const onScreen = await sessionWithATurnInFlight(client);
				const other = await sessionOnDisk(`a session ${action} can name`);
				id += 2;
				const answer = await client.request(id, { [action]: payloadFor(other, onScreen) });
				const cleared = clearedIn(answer.frames);
				const held = await stillHolds(client, onScreen, id + 1);
				const kept = await messagesOnDisk(onScreen);
				if (held) {
					// Nothing left the session, so the turn is the client's to end.
					// A stream cleared here is the action's own doing -- the stop
					// control -- and it keeps the reply the same way.
					expect([action, kept]).toEqual([action, cleared ? [prompt, partial] : [prompt]]);
					continue;
				}
				switched.push(action);
				// The window is drawing another session now, so a stream still
				// open is one nothing will ever end, and a reply that reached no
				// file is work the operator cannot get back.
				expect([action, cleared, kept]).toEqual([action, true, [prompt, partial]]);
			} finally {
				client.destroy();
			}
		}
		expect(switched.sort()).toEqual(LEAVES_THE_SESSION);
	}, 120_000);

	test("the clear reaches the client before the transcript it switched to", async () => {
		const client = await connect();
		try {
			await sessionWithATurnInFlight(client);
			const other = await sessionOnDisk("elsewhere");
			const opened = await client.request(3, { OpenSession: { session: other } });
			expect(opened.outcome).toEqual({ RequestSucceeded: { request: 3 } });

			// Order is the contract: a clear that arrives after the new transcript
			// leaves the abandoned reply drawn over it for as long as the client
			// keeps that state, which is forever.
			const kinds = opened.frames.map(frame =>
				"StreamingChanged" in frame && frame.StreamingChanged === null
					? "cleared"
					: frame.Snapshot && "Transcript" in frame.Snapshot
						? "transcript"
						: "other",
			);
			expect(kinds.indexOf("cleared")).toBeGreaterThanOrEqual(0);
			expect(kinds.indexOf("transcript")).toBeGreaterThanOrEqual(0);
			expect(kinds.indexOf("cleared")).toBeLessThan(kinds.indexOf("transcript"));

			// The transcript the client is handed is the other session's own, and
			// carries nothing of the turn that was left.
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

	test("the row of the session left behind stops reporting a turn", async () => {
		const client = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(client);
			const other = await sessionOnDisk("elsewhere");
			await client.request(3, { OpenSession: { session: other } });

			// The index reads a session's status from its file, so the row settles
			// only because the abort left a reply after the prompt. Read through a
			// listing the client asks for, which is what the rail reads.
			const listed = await client.request(4, { ListSessions: {} });
			const rows = snapshotSections<SessionsSection>(listed.frames, "Sessions").at(-1)?.[0].value ?? [];
			expect(rows.find(row => row.id === onScreen)?.status).toBe("Aborted");
		} finally {
			client.destroy();
		}
	});

	test("a session that is not there, and the one already on screen, leave the turn alone", async () => {
		const client = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(client);

			const missing = await client.request(3, { OpenSession: { session: "01a00000-0000-7000-8000-000000000000" } });
			expect(missing.outcome.RequestFailed?.error.code).toBe("SESSION_NOT_FOUND");
			expect(clearedIn(missing.frames)).toBeFalse();

			const reopened = await client.request(4, { OpenSession: { session: onScreen } });
			expect(reopened.outcome).toEqual({ RequestSucceeded: { request: 4 } });
			expect(clearedIn(reopened.frames)).toBeFalse();

			// The turn is still the one in flight: the stop control answers, which
			// it cannot do once the turn has ended.
			const aborted = await client.request(5, { AbortTurn: { session: onScreen } });
			expect(aborted.outcome).toEqual({ RequestSucceeded: { request: 5 } });
			expect(clearedIn(aborted.frames)).toBeTrue();
		} finally {
			client.destroy();
		}
	});

	test("a session deleted under the turn, and one created in another workspace, end it too", async () => {
		// Two gestures that dispose the agent session rather than reloading it in
		// place: deleting the session on screen, and creating one in a workspace
		// the current session does not belong to.
		const deleting = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(deleting);
			const deleted = await deleting.request(3, { DeleteSession: { session: onScreen } });
			expect(deleted.outcome).toEqual({ RequestSucceeded: { request: 3 } });
			expect(clearedIn(deleted.frames)).toBeTrue();
			// Nothing is in flight afterwards, so the stop control has nothing to end.
			const stopped = await deleting.request(4, { AbortTurn: { session: onScreen } });
			expect(stopped.outcome.RequestFailed?.error.code).toBe("NOT_RUNNING");
		} finally {
			deleting.destroy();
		}

		const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-leave-turn-workspace-"));
		const creating = await connect();
		try {
			const onScreen = await sessionWithATurnInFlight(creating);
			const created = await creating.request(3, { CreateSession: { workspace: elsewhere } });
			expect(created.outcome).toEqual({ RequestSucceeded: { request: 3 } });
			expect(clearedIn(created.frames)).toBeTrue();
			expect(await messagesOnDisk(onScreen)).toEqual([
				`user/-:${JSON.stringify([{ type: "text", text: PROMPT }])}`,
				`assistant/aborted:${JSON.stringify([{ type: "text", text: PARTIAL }])}`,
			]);
		} finally {
			creating.destroy();
			await fs.rm(elsewhere, { recursive: true, force: true });
		}
	});

	test("a switch with no turn running states no clear of its own", async () => {
		const client = await connect();
		try {
			const created = await client.request(1, { CreateSession: {} });
			const onScreen = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
			expect(onScreen).toBeString();
			const other = await sessionOnDisk("elsewhere");

			const opened = await client.request(2, { OpenSession: { session: other } });
			expect(opened.outcome).toEqual({ RequestSucceeded: { request: 2 } });
			expect(clearedIn(opened.frames)).toBeFalse();
		} finally {
			client.destroy();
		}
	});
});
