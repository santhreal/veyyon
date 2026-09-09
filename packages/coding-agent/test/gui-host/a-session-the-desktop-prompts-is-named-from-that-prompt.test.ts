/**
 * WHY: the rail lists a session by its title, and the host never named one, so
 * every session the desktop created stayed "new session" for as long as it
 * existed. A window holding three of them listed three rows under that one
 * name, and the only way to tell them apart was to open each.
 *
 * CLASS CLOSED: a prompt that reaches a session without naming it. The members
 * are every action that carries a prompt, which this suite derives from the
 * host's own turn handlers at run time rather than from a list written here, so
 * a fourth prompt-carrying action turns it red until it names its session too.
 * Beside them: a name the operator chose, which a later prompt must not
 * replace, and a prompt that carries no task, which must leave the session for
 * the next prompt to name rather than latching a greeting onto it.
 *
 * NOT CAUGHT: the local tiny-model title path (a transformers.js worker, not
 * reachable in-process here), the provider request itself, and the rail's own
 * drawing of the title it is given.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { type GuiHostServer, type HostEvent, startGuiHostServer } from "../../src/gui-host";
import { turnActionHandlers } from "../../src/gui-host/actions/turn";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The title the stubbed provider answers every title request with. */
const TITLE = "Fix the login button";
/** A prompt that carries a task, so titling runs on it. */
const TASK_PROMPT = "the login button is broken on mobile, please fix it";
/** A prompt that carries none, so titling defers past it. */
const GREETING = "hi";
/** The name held against the prompt that follows it. */
const CHOSEN_NAME = "The name it was given";

interface SessionRow {
	id: string;
	title: string | null;
}

type SessionsSection = [{ revision: number; value: SessionRow[] }, unknown[]];
type ActiveSessionSection = { revision: number; value: SessionRow };

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

/**
 * A title request is the one the title generator sends: one message, holding
 * the prompt wrapped in `<user>` by `formatTitleUserMessage`. A turn's own
 * request carries the session's messages and no such wrapper.
 */
function titlePromptOf(context: Context): string | undefined {
	if (context.messages.length !== 1) return undefined;
	const content = context.messages[0]?.content;
	const text = typeof content === "string" ? content : undefined;
	return text?.startsWith("<user>") ? text : undefined;
}

/**
 * A title stream held open: the delta is delivered, the end is not, so the
 * title lands only when `finish` is called. It is what lets this suite put a
 * rename, or another session, between the request and its answer.
 */
function heldTitleStream(text: string): { stream: AssistantMessageEventStream; finish: () => void } {
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
	});
	return {
		stream,
		finish: () => {
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		},
	};
}

describe("a session the desktop prompts is named from that prompt", () => {
	let tempDir: string;
	let sessionDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** The prompt of every title request the stubbed provider received. */
	let titleRequests: string[];
	/** Resolves with the prompt of the next title request the stub receives. */
	let titleRequested: Promise<string>;
	/** Set while a test wants the title request held open. */
	let holdTitle: { finish: () => void } | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-session-title-"));
		sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		titleRequests = [];
		holdTitle = undefined;
		const requested = Promise.withResolvers<string>();
		titleRequested = requested.promise;
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const titlePrompt = titlePromptOf(context);
			if (titlePrompt !== undefined) {
				titleRequests.push(titlePrompt);
				requested.resolve(titlePrompt);
				if (holdTitle) {
					const held = heldTitleStream(`<title>${TITLE}</title>`);
					holdTitle = { finish: held.finish };
					return held.stream;
				}
				return completedStream(`<title>${TITLE}</title>`);
			}
			return completedStream("Hello from engine!");
		});
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Create a session through the wire and answer with the id the host activated. */
	async function createSession(id: number, title?: string): Promise<string> {
		const created = await client.request(id, { CreateSession: title ? { title } : {} });
		const active = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1);
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.value.id;
	}

	/** The last session listing in `frames`, or nothing when it carries none. */
	function listedIn(frames: RequestFrame[]): SessionRow[] | undefined {
		return snapshotSections<SessionsSection>(frames, "Sessions").at(-1)?.[0].value;
	}

	/**
	 * Frames up to the point where `session` is listed under a title and the
	 * reply that prompt started has cleared. Both, because the name arrives
	 * beside a streaming turn and the next request in a sweep must not land in
	 * the middle of one. Bounded, so a title that never lands fails as the named
	 * error below rather than as a stalled read.
	 */
	async function framesUntilNamedAndSettled(session: string): Promise<RequestFrame[]> {
		const frames: RequestFrame[] = [];
		let named = false;
		let settled = false;
		for (let read = 0; read < 400; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (frame.RequestFailed) throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			named ||= Boolean(listedIn([frame])?.some(row => row.id === session && row.title));
			const event = frame as HostEvent;
			settled ||= "StreamingChanged" in event && event.StreamingChanged === null;
			if (named && settled) return frames;
		}
		throw new Error(`${session} was not listed under a title with its reply cleared within 400 frames`);
	}

	/** The name the session file itself holds. */
	async function nameOnDisk(session: string): Promise<string | undefined> {
		for (const entry of await fs.readdir(sessionDir)) {
			if (!entry.endsWith(".jsonl")) continue;
			const opened = await SessionManager.open(path.join(sessionDir, entry), undefined, undefined, {
				suppressBreadcrumb: true,
			});
			if (opened.getSessionId() === session) return opened.getSessionName();
		}
		throw new Error(`no session file in ${sessionDir} holds ${session}`);
	}

	/**
	 * The actions that carry a prompt into a session, read off the host's own
	 * handler table: `deliver` is the only path that refuses for want of a
	 * session and a text, so its refusal names its callers.
	 */
	async function promptCarryingActions(): Promise<string[]> {
		const carriers: string[] = [];
		let id = 1000;
		for (const action of Object.keys(turnActionHandlers)) {
			id += 1;
			const answer = await client.request(id, { [action]: { session: "", text: "" } });
			if (answer.outcome.RequestFailed?.error.message === `${action} requires session and text`) {
				carriers.push(action);
			}
		}
		return carriers;
	}

	test("every action that carries a prompt names the session that prompt lands in", async () => {
		// Derived, not written down: a fourth carrier added to the host's turn
		// handlers appears here, and has to name its session like the other three.
		expect(await promptCarryingActions()).toEqual(["SubmitPrompt", "Steer", "FollowUp"]);

		let id = 1;
		for (const action of ["SubmitPrompt", "Steer", "FollowUp"]) {
			const session = await createSession(id++);
			expect(await nameOnDisk(session)).toBeUndefined();

			const request = id++;
			const submitted = await client.request(request, { [action]: { session, text: TASK_PROMPT } });
			expect(submitted.outcome).toEqual({ RequestSucceeded: { request } });

			// The name reaches the client twice: the header of the session it is on,
			// and the row the rail draws. A title only on disk renames nothing on
			// screen until the window is opened again.
			const frames = await framesUntilNamedAndSettled(session);
			expect(listedIn(frames)?.find(row => row.id === session)?.title).toBe(TITLE);
			const header = snapshotSections<ActiveSessionSection>(frames, "ActiveSession").at(-1);
			expect(header?.value).toMatchObject({ id: session, title: TITLE });
			expect(await nameOnDisk(session)).toBe(TITLE);
		}

		// One title request per session, not one per frame of its turn.
		expect(titleRequests.length).toBe(3);
		expect(titleRequests.every(prompt => prompt.includes("login button"))).toBe(true);
	});

	test("a name the session was given survives the prompt that follows it", async () => {
		const session = await createSession(1, CHOSEN_NAME);

		const submitted = await client.request(2, { SubmitPrompt: { session, text: TASK_PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		// Not titling is decided before the reply is written, so one round trip
		// after it reads the decision: no title was requested, and the name in
		// hand is the one on disk and in the listing.
		const listed = await client.request(3, "ListSessions");
		expect(titleRequests).toEqual([]);
		expect(listedIn(listed.frames)?.find(row => row.id === session)?.title).toBe(CHOSEN_NAME);
		expect(await nameOnDisk(session)).toBe(CHOSEN_NAME);
	});

	test("a prompt that carries no task leaves the session for the next one to name", async () => {
		const session = await createSession(1);

		const greeted = await client.request(2, { SubmitPrompt: { session, text: GREETING } });
		expect(greeted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		const listed = await client.request(3, "ListSessions");
		expect(titleRequests).toEqual([]);
		expect(listedIn(listed.frames)?.find(row => row.id === session)?.title).toBeNull();
		expect(await nameOnDisk(session)).toBeUndefined();

		// The next prompt is the one that names it, so a greeting defers titling
		// rather than spending it.
		const submitted = await client.request(4, { SubmitPrompt: { session, text: TASK_PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 4 } });
		await framesUntilNamedAndSettled(session);
		expect(await nameOnDisk(session)).toBe(TITLE);
		expect(titleRequests.length).toBe(1);

		// And a session already named this way is not titled again by the prompts
		// after it: one title per session, whoever named it.
		const third = await client.request(5, { SubmitPrompt: { session, text: "and check the signup form too" } });
		expect(third.outcome).toEqual({ RequestSucceeded: { request: 5 } });
		await client.request(6, "ListSessions");
		expect(titleRequests.length).toBe(1);
		expect(await nameOnDisk(session)).toBe(TITLE);
	});

	test("a name given while the title was being generated is the one that stands", async () => {
		holdTitle = { finish: () => {} };
		const session = await createSession(1);

		const submitted = await client.request(2, { SubmitPrompt: { session, text: TASK_PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await titleRequested;

		// The rename lands while the title request is still open, so the title
		// answers into a session that already carries a name.
		const renamed = await client.request(3, { RenameSession: { session, title: CHOSEN_NAME } });
		expect(renamed.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		holdTitle?.finish();

		const listed = await client.request(4, "ListSessions");
		expect(listedIn(listed.frames)?.find(row => row.id === session)?.title).toBe(CHOSEN_NAME);
		expect(await nameOnDisk(session)).toBe(CHOSEN_NAME);
	});

	test("a title generated for a session no longer in hand names nothing", async () => {
		holdTitle = { finish: () => {} };
		const first = await createSession(1);

		const submitted = await client.request(2, { SubmitPrompt: { session: first, text: TASK_PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await titleRequested;

		// The window moves on to a new session before the title answers. The
		// title belongs to the prompt that asked for it, so it names neither the
		// session that has replaced it nor, once dropped, the one it was for.
		const second = await createSession(3);
		expect(second).not.toBe(first);
		holdTitle?.finish();

		const listed = await client.request(4, "ListSessions");
		const rows = listedIn(listed.frames) ?? [];
		expect(rows.find(row => row.id === second)?.title).toBeNull();
		expect(await nameOnDisk(second)).toBeUndefined();
	});
});
