/**
 * WHY: the rail draws each row's badge from the status the session index
 * reported, and a session's status is read from its file, where a turn in
 * flight is a trailing prompt with no reply after it: `pending`, which the row
 * draws as `Working` with a clock counting up. Nothing a turn streams carries a
 * status, and the host stated the index only when a request asked it to, so a
 * listing that landed mid-turn — the one that carries the name a session was
 * just given — left every row it touched reporting a turn that was over. In a
 * window driven for a minute, two finished sessions both read `Working`.
 *
 * The class this closes: any path that runs a turn leaves the index reporting
 * the session's settled status once the session is idle, whatever ended it and
 * whichever action carried the prompt. The prompt carriers are read off the
 * host's own handler table, so a fourth one fails here until it is decided.
 *
 * What it does not catch: the listing is stated at `agent_end` and not at
 * `turn_end`, because a tool call ends a turn mid-loop and the file then trails
 * a tool result, which lists as an interrupted session. This suite drives no
 * tool loop, so a regression that lists on every `turn_end` would show up here
 * only as an extra listing carrying the same settled status, not as the
 * `Interrupted` row it would draw mid-loop.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context, StopReason } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { type GuiHostServer, type HostEvent, startGuiHostServer } from "../../src/gui-host";
import { turnActionHandlers } from "../../src/gui-host/actions/turn";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** A prompt that carries no task, so titling defers and lists nothing of its own. */
const GREETING = "hi";
/** A prompt that carries one, so the name lands mid-turn as it did in the window. */
const TASK_PROMPT = "the login button is broken on mobile, please fix it";
/** The title the stubbed provider answers a title request with. */
const TITLE = "Fix the login button";

/**
 * How a reply ended, and the status the index derives from it once that reply
 * is the last message in the file. `stop` is a turn that finished; every other
 * row is an end a row must also stop reporting as running.
 */
const REPLY_ENDINGS: ReadonlyArray<{ reason: StopReason; status: string }> = [
	{ reason: "stop", status: "Complete" },
	{ reason: "length", status: "Interrupted" },
	{ reason: "aborted", status: "Aborted" },
	{ reason: "error", status: "Error" },
];

interface SessionRow {
	id: string;
	title: string | null;
	status: string;
}

type SessionsSection = [{ revision: number; value: SessionRow[] }, unknown[]];
type ActiveSessionSection = { revision: number; value: SessionRow };

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

/**
 * A stream that delivers `text` as one delta and ends for `reason`. A reply
 * cut short or failed ends on `error`, which is the only event that carries
 * those two reasons.
 */
function endedStream(text: string, reason: StopReason): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text, reason);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		if (reason === "aborted" || reason === "error") {
			stream.push({ type: "error", reason, error: message });
			return;
		}
		stream.push({ type: "done", reason, message });
	});
	return stream;
}

/**
 * A title request is the one the title generator sends: one message, holding
 * the prompt wrapped in `<user>` by `formatTitleUserMessage`. A turn's own
 * request carries the session's messages and no such wrapper.
 */
function isTitleRequest(context: Context): boolean {
	if (context.messages.length !== 1) return false;
	const content = context.messages[0]?.content;
	return typeof content === "string" && content.startsWith("<user>");
}

describe("a turn that ends stops being listed as running", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** How the next reply this suite's provider streams ends. */
	let replyEnding: StopReason;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-turn-index-"));
		await fs.mkdir(computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions")), {
			recursive: true,
		});
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		replyEnding = "stop";
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			if (isTitleRequest(context)) return endedStream(`<title>${TITLE}</title>`, "stop");
			return endedStream("Hello from engine!", replyEnding);
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
	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = snapshotSections<ActiveSessionSection>(created.frames, "ActiveSession").at(-1);
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.value.id;
	}

	/** The row for `session` in the last listing `frames` carried, if any. */
	function rowIn(frames: RequestFrame[], session: string): SessionRow | undefined {
		return snapshotSections<SessionsSection>(frames, "Sessions")
			.at(-1)?.[0]
			.value.find(row => row.id === session);
	}

	/**
	 * The status of every listing of `session` up to the first that reports it
	 * settled, and whether the reply had cleared by then.
	 *
	 * Bounded, so a listing that never comes fails as the named error below
	 * rather than as a read that never returns — which is the shape of the
	 * defect: the row waits for a listing forever, counting up.
	 */
	async function listedStatusesUntilSettled(session: string): Promise<{ statuses: string[]; cleared: boolean }> {
		const statuses: string[] = [];
		let cleared = false;
		for (let read = 0; read < 400; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			if (frame.RequestFailed) throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			const event = frame as HostEvent;
			if ("StreamingChanged" in event && event.StreamingChanged === null) cleared = true;
			const row = rowIn([frame], session);
			if (!row) continue;
			statuses.push(row.status);
			if (row.status !== "Pending") return { statuses, cleared };
		}
		throw new Error(`${session} was never listed with a settled status within 400 frames`);
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

	test("the name a session is given mid-turn does not leave its row reporting the turn", async () => {
		// The window's own sequence: a prompt that earns a title, so the listing
		// carrying that title is written while the turn is still owed a reply and
		// reports the session as pending.
		const session = await createSession(1);
		const submitted = await client.request(2, { SubmitPrompt: { session, text: TASK_PROMPT } });
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const { statuses, cleared } = await listedStatusesUntilSettled(session);
		expect(statuses.at(-1)).toBe("Complete");
		// The settled listing follows the reply, so nothing after it can put the
		// row back on a status read from a file that was still being written.
		expect(cleared).toBe(true);

		// And the name survives the listing that settles the status: the row the
		// operator reads is the titled one, not "new session" again.
		const listed = await client.request(3, "ListSessions");
		expect(rowIn(listed.frames, session)).toMatchObject({ title: TITLE, status: "Complete" });
	});

	test("every action that carries a prompt states the index when its session goes idle", async () => {
		// Derived, not written down: a fourth carrier added to the host's turn
		// handlers appears here, and has to state the index like the other three.
		expect(await promptCarryingActions()).toEqual(["SubmitPrompt", "Steer", "FollowUp"]);

		let id = 1;
		for (const action of ["SubmitPrompt", "Steer", "FollowUp"]) {
			const session = await createSession(id++);
			const request = id++;
			// A greeting is not titled, so the only listing owed for this prompt is
			// the one its turn ending states.
			const submitted = await client.request(request, { [action]: { session, text: GREETING } });
			expect(submitted.outcome).toEqual({ RequestSucceeded: { request } });

			const { statuses, cleared } = await listedStatusesUntilSettled(session);
			expect(statuses).toEqual(["Complete"]);
			expect(cleared).toBe(true);
		}
	});

	test("a reply that ends any other way settles the row it left running", async () => {
		let id = 1;
		for (const ending of REPLY_ENDINGS) {
			replyEnding = ending.reason;
			const session = await createSession(id++);
			const request = id++;
			const submitted = await client.request(request, { SubmitPrompt: { session, text: GREETING } });
			expect(submitted.outcome).toEqual({ RequestSucceeded: { request } });

			const { statuses } = await listedStatusesUntilSettled(session);
			expect(statuses.at(-1)).toBe(ending.status);
		}
	});
});
