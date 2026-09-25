/**
 * WHY: the plan board was a terminal-only surface. `todo` wrote it, the TUI
 * drew it beside the composer, and a window got nothing: no section carried
 * it, so a desktop session ran a plan it could not see. The class this closes
 * is a session-scoped domain the agent moves mid-turn that reaches one host
 * and not the other.
 *
 * This suite defends:
 * 1. A `todo` call moves the board and the moved board reaches the window,
 *    projected: phases numbered, tallies counted, the task in flight named.
 * 2. Every status the vocabulary declares survives the projection. The status
 *    set is swept from `TODO_STATUSES` in `@veyyon/wire`, which owns it, so a
 *    status added to the union turns this red until the board carries it.
 * 3. Terminality is the vocabulary's, not a second copy: the closed tally
 *    counts exactly the statuses `TODO_STATUS_IS_TERMINAL` marks closed.
 * 4. The board is stated once per move. A turn that ends without moving the
 *    plan, and the idle re-statement that follows a turn that did move it,
 *    both write nothing, so a window neither redraws nor re-runs the card's
 *    motion for a plan that stands where it stood.
 *
 * What it does NOT catch: how the desktop draws the board. A board that
 * crosses correctly into a window that paints it wrong is a surface defect,
 * and `veyyon-desktop-surface` owns that.
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
import { TODO_STATUS_IS_TERMINAL, TODO_STATUSES } from "@veyyon/wire";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { TodoBoardView } from "../../src/gui-host/wire";
import { closeDaemonClients } from "../../src/launch/client";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";

/**
 * The plan the turn writes: a first phase the turn closes whole and a second
 * it leaves open. Closing the first is what moves the task in flight across a
 * phase boundary, which is the only shape that tells the phase in flight apart
 * from the first phase on the board.
 */
const FOUNDATION = ["Scaffold the crate", "Wire the workspace", "Port the store"];
const CHECKS = ["Run the suite", "Ship the build"];

function assistantMessage(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason,
		usage: {
			input: 120,
			output: 34,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 154,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		timestamp: Date.now(),
	};
}

function endedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage([{ type: "text", text }], "stop");
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

/** A reply whose whole content is one `todo` call, ending the turn on it. */
function todoStream(id: string, args: Record<string, unknown>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const call = { type: "toolCall", id, name: "todo", arguments: { i: "Moving the plan", ...args } } as const;
	const message = assistantMessage([call], "toolUse");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

/**
 * A title request carries one plain-string message holding the transcript it
 * is naming; a turn's carries the session's own content blocks. Answering one
 * from the reply queue would spend a turn's tool call on a request whose
 * answer is read as a title and discarded.
 */
function isTitleRequest(context: Context): boolean {
	if (context.messages.length !== 1) return false;
	const content = context.messages[0]?.content;
	return typeof content === "string";
}

describe("a plan the agent moved is stated to the window", () => {
	let tempDir: string;
	let workDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	/** The streams the stubbed provider answers turn requests with, in order. */
	let replies: Array<() => AssistantMessageEventStream>;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-plan-"));
		const agentDir = path.join(tempDir, "agent");
		workDir = path.join(tempDir, "work");
		await fs.mkdir(workDir);
		await fs.mkdir(computeDefaultSessionDir(workDir, new FileSessionStorage(), path.join(agentDir, "sessions")), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\ntools:\n  approvalMode: auto\n",
			"utf8",
		);

		const authStorage = await isolatedAuthStorage(agentDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		replies = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			if (isTitleRequest(context)) return endedStream("<title>A title</title>");
			const next = replies.shift();
			return next ? next() : endedStream("Done.");
		});

		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: workDir, agentDir, authStorage });
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
		await closeDaemonClients();
		resetSettingsForTest();
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/**
	 * Run one prompt to idle and answer every board the host stated while it
	 * ran.
	 *
	 * `Usage` closes the host's idle re-statement, so reading to it is reading
	 * past the point a board could still arrive. Bounded, so a board that never
	 * comes fails as the named error rather than as a hung suite.
	 */
	async function promptForBoards(id: number, session: string, text: string): Promise<Array<TodoBoardView | null>> {
		const settled = await client.request(id, { SubmitPrompt: { session, text, images: [] } });
		expect(settled.outcome).toEqual({ RequestSucceeded: { request: id } });

		const frames: RequestFrame[] = [...settled.frames];
		for (let read = 0; read < 400; read++) {
			const frame = (await client.nextFrame()) as RequestFrame;
			if (frame.RequestFailed) throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			frames.push(frame);
			if (frame.Snapshot && "Usage" in frame.Snapshot) {
				return frames.flatMap(f => {
					const todo = f.Snapshot?.Todo as { board: TodoBoardView | null } | undefined;
					return todo ? [todo.board] : [];
				});
			}
		}
		throw new Error("the turn never settled: no Usage within 400 frames");
	}

	test("a plan the tool wrote reaches the window projected, and every status survives it", async () => {
		const session = await createSession(1);
		replies = [
			() =>
				todoStream("call-init", {
					op: "init",
					list: [
						{ phase: "Foundation", items: FOUNDATION },
						{ phase: "Checks", items: CHECKS },
					],
				}),
			() => todoStream("call-done-first", { op: "done", task: FOUNDATION[0] }),
			() => todoStream("call-drop", { op: "drop", task: FOUNDATION[1] }),
			() => todoStream("call-done-last", { op: "done", task: FOUNDATION[2] }),
			() => endedStream("The plan is under way."),
		];

		const boards = await promptForBoards(2, session, "Write the plan and work it");

		// One statement per call that moved the board, and none for the idle
		// re-statement behind the last of them: the plan had not moved since.
		expect(boards.length).toBe(4);
		const board = boards[3];
		if (!board) throw new Error("the last statement carried no board");

		expect(board.phases.map(phase => phase.name)).toEqual(["I. Foundation", "II. Checks"]);
		expect(board.total).toBe(FOUNDATION.length + CHECKS.length);

		const statuses = board.phases.flatMap(phase => phase.tasks.map(task => task.status));
		expect([...new Set(statuses)].sort()).toEqual([...TODO_STATUSES].sort());

		const closed = statuses.filter(status => TODO_STATUS_IS_TERMINAL[status]).length;
		expect(board.closed).toBe(closed);
		expect(board.phases[0]?.closed).toBe(FOUNDATION.length);
		expect(board.phases[1]?.closed).toBe(0);

		// Closing the last task of a phase promotes the first task of the next
		// one, and the task in flight is what names the phase in flight: the
		// board states the second phase as the active one and the first, whose
		// work is over, as not.
		expect(board.current).toEqual({ content: CHECKS[0], status: "in_progress" });
		expect(board.phases.map(phase => phase.active)).toEqual([false, true]);
	});

	test("a turn that leaves the plan alone states no board", async () => {
		const session = await createSession(1);
		replies = [() => todoStream("call-init", { op: "init", items: CHECKS }), () => endedStream("Planned.")];
		expect((await promptForBoards(2, session, "Plan it")).length).toBe(1);

		replies = [() => endedStream("Nothing moved.")];
		expect(await promptForBoards(3, session, "Say something")).toEqual([]);
	});
});
