/**
 * WHY: a thread the window leaves goes on working (see
 * `a-thread-the-window-leaves-keeps-its-turn-running`), and the window keeps
 * one thread open. Everything the host states for a session is filed by the
 * window under the id it carries, and the connection states for whichever
 * session is open: a decision the background turn raised, a status its
 * extensions set or an edit they made to the draft would be stated under the
 * thread on screen, where the operator answers the wrong card, reads another
 * thread's status and has another thread's extension type into the composer.
 * An answer aimed at the open thread would settle a card raised elsewhere, and
 * a thread whose work ended would be held for the life of the connection.
 *
 * The class this closes: what a session in the background states to the
 * window, and what the window sends to it. Driven through the real host, wire,
 * agent, tool approval and a real extension: a card raised after the thread
 * was left reaches the window under that thread's id and is settled only by an
 * answer aimed at it; nothing of the turn streams or appends; what its
 * extensions set is stated under its id and handed back whole when the thread
 * is opened again; the draft reads empty and an edit goes nowhere while it is
 * off screen, and the draft is the thread's own once it is back; a call that
 * started off screen is the one the thread's cancel reaches once it is back;
 * and the session is let go once nothing is left for it to do, whether its
 * turn ended or the only thing holding it was a card.
 *
 * What it does not catch: the window's filing and announcing of what it is
 * sent, which `crates/veyyon-desktop-model` owns; the console
 * (`AutoswarmConsole`) of a background session, which is stamped with its id
 * the way the ledger is and is not driven here; and a decision raised by an
 * extension after its session was let go, which reaches a ledger nothing
 * answers any more.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Context, StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { getAgentDir } from "@veyyon/utils";
import { isSessionFileName } from "@veyyon/utils/session-file";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ComposerEditView, ExtensionNoticeView, ExtensionUiView, PendingDecisions } from "../../src/gui-host/wire";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

useIsolatedAgentDir();
const makeTempDir = useTrackedTempDirs("gui-host-background-thread-");

/** The prompt whose turn this suite leaves in flight. */
const PROMPT = "Read the working directory";
/** The tool the config marks `prompt`, so calling it raises a card. */
const GATED_TOOL = "read";
/** What the model streams before the test lets it call the tool. */
const PARTIAL = "Looking around.";
/** The reply once the tool has answered. */
const DONE = "It holds the files.";
/** The most frames a wait reads before it gives up on the one it wants. */
const FRAME_BOUND = 400;

/**
 * Loaded into every session. It states a status when the session starts;
 * at each turn's end it states what `getEditorText` read and pastes into
 * the draft; `bg-ask` raises a confirmation it does not wait on, and states
 * the answer as a notice once one comes.
 */
const EXTENSION = `
export default function (api) {
	api.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("since", "loaded");
	});
	api.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("phase", "draft=[" + ctx.ui.getEditorText() + "]");
		ctx.ui.pasteToEditor("!");
	});
	api.registerCommand("bg-ask", {
		handler: async (_args, ctx) => {
			void ctx.ui.confirm("Keep going?", "").then(answer => ctx.ui.notify("answered " + answer, "info"));
		},
	});
}
`;

interface SessionRow {
	id: string;
	status: string;
}

type SessionsSection = [{ revision: number; value: SessionRow[] }, unknown[]];
type ActiveSessionSection = { revision: number; value: { id: string } };
type InteractionsSection = { session: string; pending: PendingDecisions };
type ExtensionUiSection = { session: string; ui: ExtensionUiView };
type ExtensionNoticeSection = { session: string; notice: ExtensionNoticeView };
type ComposerEditSection = { session: string; edit: ComposerEditView };

const NO_DECISIONS: PendingDecisions = { approvals: [], questions: [], plans: [], dialogs: [] };

function assistantMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
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

/** Lets a held reply go on to call the gated tool. */
type Release = () => void;

/**
 * A reply that streams `PARTIAL` and then waits: for the abort signal, which
 * ends it `aborted`, or for the test to release it, which ends it with a call
 * to the gated tool. Each one's release is pushed onto `releases`.
 */
function heldToolCall(signal: AbortSignal | undefined, releases: Release[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const text = { type: "text", text: PARTIAL } as const;
	const partial = assistantMessage([text], "stop");
	let over = false;
	signal?.addEventListener("abort", () => {
		if (over) return;
		over = true;
		stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted" } });
	});
	queueMicrotask(() => {
		stream.push({ type: "start", partial: assistantMessage([], "stop") });
		stream.push({ type: "text_start", contentIndex: 0, partial: assistantMessage([{ ...text, text: "" }], "stop") });
		stream.push({ type: "text_delta", contentIndex: 0, delta: PARTIAL, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: PARTIAL, partial });
	});
	releases.push(() => {
		if (over) return;
		over = true;
		const call = { type: "toolCall", id: "call-gated-1", name: GATED_TOOL, arguments: { path: "." } } as const;
		const message = assistantMessage([text, call], "toolUse");
		stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

/** A stream that finishes on its own. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage([{ type: "text", text }], "stop");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: assistantMessage([], "stop") });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: assistantMessage([{ type: "text", text: "" }], "stop"),
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

function sectionOf<T>(frame: RequestFrame, section: string): T | undefined {
	return snapshotSections<T>([frame], section)[0];
}

/** A frame that draws the turn: its stream, or an entry appended to or updated in its transcript. */
function drawsTheTurn(frame: RequestFrame): boolean {
	return (
		("StreamingChanged" in frame && frame.StreamingChanged !== null) ||
		"StreamingAppended" in frame ||
		"TranscriptAppended" in frame ||
		"TranscriptUpdated" in frame
	);
}

/** The session every extension-chrome section in `frames` was stated for, in order. */
function chromeSessions(frames: RequestFrame[]): string[] {
	return [
		...snapshotSections<ExtensionUiSection>(frames, "ExtensionUi"),
		...snapshotSections<ExtensionNoticeSection>(frames, "ExtensionNotice"),
		...snapshotSections<ComposerEditSection>(frames, "ComposerEdit"),
	].map(section => section.session);
}

describe("a thread working in the background reaches the window under its own id", () => {
	let workspace: string;
	let sessionDir: string;
	let server: GuiHostServer | undefined;
	let client: TestSocketClient;
	let releases: Release[] = [];
	let nextId = 1;

	async function send(action: unknown): Promise<{ frames: RequestFrame[]; outcome: RequestFrame }> {
		const id = nextId++;
		return await client.request(id, action);
	}

	/** Read frames until one satisfies `found`; every frame read, the match last. */
	async function readUntil(found: (frame: RequestFrame) => boolean): Promise<RequestFrame[]> {
		const frames: RequestFrame[] = [];
		for (let read = 0; read < FRAME_BOUND; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (found(frame)) return frames;
		}
		throw new Error("the frame waited for never arrived");
	}

	beforeEach(async () => {
		workspace = makeTempDir();
		const profile = getAgentDir();
		sessionDir = computeDefaultSessionDir(workspace, new FileSessionStorage(), path.join(profile, "sessions"));
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.mkdir(path.join(profile, "extensions"), { recursive: true });
		await fs.writeFile(path.join(profile, "extensions", "background.ts"), EXTENSION);
		await fs.writeFile(
			path.join(profile, "config.yml"),
			`modelRoles:\n  default: openai/gpt-4o-mini\ntools:\n  approval:\n    ${GATED_TOOL}: prompt\n`,
		);
		clearFsCache();
		resetSettingsForTest();
		const authStorage = await isolatedAuthStorage(workspace);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		releases = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context, options) => {
			if (!isTheTurnUnderTest(context)) return completedStream("Answered.");
			return context.messages.some(message => message.role === "toolResult")
				? completedStream(DONE)
				: heldToolCall(options?.signal, releases);
		});
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: workspace,
			agentDir: profile,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		nextId = 1;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		await server?.close();
		server = undefined;
		resetSettingsForTest();
	});

	/** A session on disk the window can open, with one message of its own. */
	async function sessionOnDisk(text: string): Promise<string> {
		const sm = SessionManager.create(workspace, sessionDir, new FileSessionStorage());
		sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		await sm.flush();
		await sm.ensureOnDisk();
		return sm.getSessionId();
	}

	/** Create a session and prompt it, returning once its reply has started streaming. */
	async function sessionWithATurnInFlight(): Promise<string> {
		const created = await send({ CreateSession: {} });
		const session = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!session) throw new Error("CreateSession stated no ActiveSession");
		const submitted = await send({ SubmitPrompt: { session, text: PROMPT } });
		expect(submitted.outcome.RequestSucceeded).toBeDefined();
		await readUntil(frame => "StreamingChanged" in frame && frame.StreamingChanged !== null);
		return session;
	}

	/** Open `session`, which must succeed; the frames it was answered with. */
	async function open(session: string): Promise<RequestFrame[]> {
		const opened = await send({ OpenSession: { session } });
		expect(opened.outcome.RequestSucceeded).toBeDefined();
		return opened.frames;
	}

	/** Release the held reply, which calls the gated tool. */
	function release(): void {
		const [first] = releases;
		if (!first) throw new Error("the turn under test made no request");
		first();
	}

	/** Read until a card for the gated tool is up, and return its section with the frames before it. */
	async function untilACardIsUp(): Promise<{ frames: RequestFrame[]; section: InteractionsSection }> {
		const frames = await readUntil(
			frame => (sectionOf<InteractionsSection>(frame, "Interactions")?.pending.approvals.length ?? 0) > 0,
		);
		const section = sectionOf<InteractionsSection>(frames[frames.length - 1] ?? {}, "Interactions");
		if (!section) throw new Error("no card came up");
		expect(section.pending.approvals.map(card => card.tool_name)).toEqual([GATED_TOOL]);
		return { frames, section };
	}

	/** The session let go: its extensions' chrome taken off its thread. */
	function isLetGo(session: string): (frame: RequestFrame) => boolean {
		return frame => {
			const ui = sectionOf<ExtensionUiSection>(frame, "ExtensionUi");
			return ui?.session === session && ui.ui.statuses.length === 0;
		};
	}

	/** The messages `session` holds on disk, as `role/stopReason`. */
	async function messagesOnDisk(session: string): Promise<string[]> {
		for (const file of await fs.readdir(sessionDir)) {
			if (!isSessionFileName(file)) continue;
			const sm = await SessionManager.open(path.join(sessionDir, file), undefined, undefined, {
				suppressBreadcrumb: true,
			});
			if (sm.getSessionId() !== session) continue;
			const described: string[] = [];
			for (const entry of sm.getEntries()) {
				if (entry.type !== "message") continue;
				const message = entry.message;
				described.push(`${message.role}/${"stopReason" in message ? message.stopReason : "-"}`);
			}
			return described;
		}
		throw new Error(`no file on disk holds session ${session}`);
	}

	test("a card a thread raises off screen is stated under its id and settled only by an answer aimed at it", async () => {
		const left = await sessionWithATurnInFlight();
		const onScreen = await sessionOnDisk("the thread on screen");
		const idle = await sessionOnDisk("a thread doing nothing");
		await open(onScreen);
		const typed = "typed on screen";
		const reported = await send({
			ReportComposerDraft: { session: onScreen, text: typed, cursor: typed.length, applied_edit: 0 },
		});
		expect(reported.outcome.RequestSucceeded).toBeDefined();

		release();
		const { frames: beforeTheCard, section } = await untilACardIsUp();
		expect(section.session).toBe(left);
		expect(beforeTheCard.filter(drawsTheTurn)).toEqual([]);
		const card = section.pending.approvals[0]?.id;
		if (!card) throw new Error("the card has no id");

		// Each session numbers its own cards, so the id alone names none: an
		// answer aimed at the thread on screen, or at one doing nothing, is
		// refused and leaves the card up.
		for (const elsewhere of [onScreen, idle]) {
			const refused = await send({
				RespondToInteraction: { session: elsewhere, interaction_id: card, response: { approved: true } },
			});
			expect([elsewhere, refused.outcome.RequestFailed?.error.code]).toEqual([elsewhere, "INTERACTION_NOT_FOUND"]);
			expect(snapshotSections<InteractionsSection>(refused.frames, "Interactions")).toEqual([]);
		}

		const answered = await send({
			RespondToInteraction: { session: left, interaction_id: card, response: { approved: true } },
		});
		expect(answered.outcome.RequestSucceeded).toBeDefined();
		expect(snapshotSections<InteractionsSection>(answered.frames, "Interactions")).toEqual([
			{ session: left, pending: NO_DECISIONS },
		]);

		// The turn runs to its end off screen and is let go: nothing of it is
		// drawn, what its extensions set is stated under its own id, the draft
		// of the thread on screen reads empty to them and their edit goes
		// nowhere.
		const afterTheAnswer = [...answered.frames, ...(await readUntil(isLetGo(left)))];
		expect(afterTheAnswer.filter(drawsTheTurn)).toEqual([]);
		expect(new Set(chromeSessions([...beforeTheCard, ...afterTheAnswer]))).toEqual(new Set([left]));
		expect(snapshotSections<ComposerEditSection>([...beforeTheCard, ...afterTheAnswer], "ComposerEdit")).toEqual([]);
		const stated = snapshotSections<ExtensionUiSection>(afterTheAnswer, "ExtensionUi").find(ui =>
			ui.ui.statuses.some(status => status.key === "phase"),
		);
		expect(stated?.ui.statuses).toEqual([
			{ key: "phase", text: "draft=[]" },
			{ key: "since", text: "loaded" },
		]);

		expect(await messagesOnDisk(left)).toEqual(["user/-", "assistant/toolUse", "toolResult/-", "assistant/stop"]);
		const listed = await send({ ListSessions: {} });
		const rows = snapshotSections<SessionsSection>(listed.frames, "Sessions").at(-1)?.[0].value ?? [];
		expect(rows.find(row => row.id === left)?.status).toBe("Complete");
		// Let go, it has nothing left to stop.
		const stopped = await send({ AbortTurn: { session: left } });
		expect(stopped.outcome.RequestFailed?.error.code).toBe("NOT_RUNNING");
	}, 30_000);

	test("what a thread's extensions set is kept for it off screen and handed back when it is opened again", async () => {
		const left = await sessionWithATurnInFlight();
		const onScreen = await sessionOnDisk("the thread on screen");

		// Leaving states nothing of the chrome: the window keeps what it was
		// sent for the thread it left, and the thread it opens has none.
		expect(snapshotSections<ExtensionUiSection>(await open(onScreen), "ExtensionUi")).toEqual([]);
		// Opening it again states nothing either: the window still has it.
		expect(snapshotSections<ExtensionUiSection>(await open(left), "ExtensionUi")).toEqual([]);

		const typed = "typed on the thread";
		const reported = await send({
			ReportComposerDraft: { session: left, text: typed, cursor: typed.length, applied_edit: 0 },
		});
		expect(reported.outcome.RequestSucceeded).toBeDefined();
		release();
		const { section } = await untilACardIsUp();
		expect(section.session).toBe(left);
		const answered = await send({
			RespondToInteraction: {
				session: left,
				interaction_id: section.pending.approvals[0]?.id,
				response: { approved: true },
			},
		});
		expect(answered.outcome.RequestSucceeded).toBeDefined();

		// Back on screen, its extensions draw into the window's chrome again,
		// which holds what they set before the thread was left, and they read
		// and edit its draft.
		const frames = [
			...answered.frames,
			...(await readUntil(frame => sectionOf<ComposerEditSection>(frame, "ComposerEdit") !== undefined)),
		];
		const stated = snapshotSections<ExtensionUiSection>(frames, "ExtensionUi").find(ui =>
			ui.ui.statuses.some(status => status.key === "phase"),
		);
		expect(stated).toEqual({
			session: left,
			ui: {
				statuses: [
					{ key: "phase", text: `draft=[${typed}]` },
					{ key: "since", text: "loaded" },
				],
				working_message: null,
				widgets: [],
				completes: false,
			},
		});
		const edit = snapshotSections<ComposerEditSection>(frames, "ComposerEdit")[0];
		expect([edit?.session, edit?.edit.kind, edit?.edit.text]).toEqual([left, "Paste", "!"]);
	}, 30_000);

	test("a thread opened again in the middle of a call can have that call cancelled", async () => {
		const left = await sessionWithATurnInFlight();
		await open(await sessionOnDisk("the thread on screen"));
		release();
		const { section } = await untilACardIsUp();
		expect(section.session).toBe(left);

		// The call started off screen, so the thread taken back has to be told
		// which call it is in: the cancel its run bar offers names that call.
		await open(left);
		const cancelled = await send({ CancelTool: { session: left, tool_call_id: "call-gated-1" } });
		expect(cancelled.outcome.RequestSucceeded).toBeDefined();
		expect(snapshotSections<InteractionsSection>(cancelled.frames, "Interactions").at(-1)).toEqual({
			session: left,
			pending: NO_DECISIONS,
		});
		const stopped = await send({ AbortTurn: { session: left } });
		expect(stopped.outcome.RequestFailed?.error.code).toBe("NOT_RUNNING");
	}, 30_000);

	test("a thread held only by a card is let go once the card is answered", async () => {
		const created = await send({ CreateSession: {} });
		const left = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1)?.value.id;
		if (!left) throw new Error("CreateSession stated no ActiveSession");
		const asked = await send({ RunCommand: { session: left, text: "bg-ask" } });
		expect(asked.outcome.RequestSucceeded).toBeDefined();
		const card = snapshotSections<InteractionsSection>(asked.frames, "Interactions")
			.filter(section => section.session === left)
			.at(-1)?.pending.questions[0]?.id;
		if (!card) throw new Error("bg-ask raised no card");

		// No turn runs on it, so only the card holds it: had leaving ended
		// it, the card would be gone and the answer refused.
		await open(await sessionOnDisk("the thread on screen"));
		const answered = await send({
			RespondToInteraction: { session: left, interaction_id: card, response: { option: 0 } },
		});
		expect(answered.outcome.RequestSucceeded).toBeDefined();

		// The notice and the release both follow the answer, in whichever order
		// the answer's continuations run.
		const noticed = (frame: RequestFrame) =>
			sectionOf<ExtensionNoticeSection>(frame, "ExtensionNotice") !== undefined;
		let sawNotice = answered.frames.some(noticed);
		let sawRelease = answered.frames.some(isLetGo(left));
		const frames = [
			...answered.frames,
			...(sawNotice && sawRelease
				? []
				: await readUntil(frame => {
						sawNotice ||= noticed(frame);
						sawRelease ||= isLetGo(left)(frame);
						return sawNotice && sawRelease;
					})),
		];
		expect(new Set(chromeSessions(frames))).toEqual(new Set([left]));
		expect(
			snapshotSections<ExtensionNoticeSection>(frames, "ExtensionNotice").map(each => each.notice.message),
		).toEqual(["answered true"]);
		const again = await send({
			RespondToInteraction: { session: left, interaction_id: card, response: { option: 0 } },
		});
		expect(again.outcome.RequestFailed?.error.code).toBe("INTERACTION_NOT_FOUND");
	}, 30_000);
});
