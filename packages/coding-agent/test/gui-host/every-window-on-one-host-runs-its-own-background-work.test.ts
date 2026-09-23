/**
 * WHY: one host process serves every window of a profile over one socket, and
 * each window opens a top-level session of its own. Only the first of them
 * built an `AsyncJobManager`; the rest were left with none, so every window
 * after the first refused background work outright — `/tan`, an async bash job
 * and a task delivery alike — while the first one ran it. Routing them all onto
 * the first manager was the other half of the defect, because a completion is
 * delivered into the conversation that manager belongs to (issue #1923).
 *
 * THE CLASS THIS CLOSES: a per-conversation resource taken from a process-wide
 * singleton. The sweep runs three windows rather than two, so a fix that
 * special-cases "the second one" fails here; it reads each window's own
 * roster, so work that ran but landed in another window's conversation fails
 * too; and the delivery case dispatches from a window whose session was built
 * second, so a shared manager is observable rather than hidden by whichever
 * window happened to open a session first.
 *
 * WHAT IT DOES NOT CATCH: the async bash and task paths, which register on the
 * same manager through `ToolSession.asyncJobManager` and are covered by their
 * own suites, and the terminal, which holds one session per process and never
 * reached the defect.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Context } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { AgentView } from "../../src/gui-host/wire";
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

/**
 * The last thing a person said in `context`, which is what the stub answers.
 *
 * Every turn in this suite would otherwise read the same, and a result drawn
 * in the wrong conversation would be indistinguishable from that window's own
 * reply.
 */
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

/** The reply the tan below produces, which no window produces for itself. */
const ANSWER = "answered: rebuild the index";

/** One window: its socket and the session it opened. */
interface Window {
	client: TestSocketClient;
	session: string;
	next: number;
}

describe("every window on one host runs its own background work", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	const windows: Window[] = [];
	/** Every request the stubbed provider was sent, by what it was asked. */
	const requests: { asked: string; body: string }[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-windows-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		requests.length = 0;
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			const asked = lastUserText(context);
			requests.push({ asked, body: JSON.stringify(context.messages) });
			return completedStream(`answered: ${asked}`);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const window of windows.splice(0)) window.client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Connect a window and open its session, the way a second window does. */
	async function openWindow(): Promise<Window> {
		if (!server) throw new Error("the host is not listening");
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		const created = await client.request(1, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		const window: Window = { client, session: active.Snapshot.ActiveSession.value.id, next: 2 };
		windows.push(window);
		return window;
	}

	/** Dispatch tangential work from `window` and answer with the request outcome. */
	async function dispatch(window: Window, work: string): Promise<unknown> {
		const id = window.next++;
		const run = await window.client.request(id, { RunCommand: { session: window.session, text: `/tan ${work}` } });
		return run.outcome;
	}

	/** The roster this window's own session carries, once it lists `expected` tans. */
	async function tans(window: Window, expected: number): Promise<AgentView[]> {
		for (let attempt = 0; attempt < 40; attempt++) {
			const frames = (await window.client.request(window.next++, "RefreshAgents")).frames;
			const listed = snapshotSections<AgentView[]>(frames, "Agents");
			const rows = (listed[listed.length - 1] ?? []).filter(agent => agent.display_name === "tan");
			if (rows.length >= expected) return rows;
		}
		throw new Error(`the roster never listed ${expected} tans within 40 refreshes`);
	}

	/** The roster row for this window's tan, once it has stopped running. */
	async function parkedTan(window: Window): Promise<AgentView> {
		for (let attempt = 0; attempt < 200; attempt++) {
			const rows = await tans(window, 1);
			const settled = rows.find(row => row.status === "parked" || row.status === "aborted");
			if (settled) return settled;
			await delay(25);
		}
		throw new Error("the tan never stopped running within 200 refreshes");
	}

	/**
	 * Run one turn in `window` to completion.
	 *
	 * A finished job is delivered on the conversation's next turn, so the turn
	 * is what carries the delivery into the request the provider sees. Bounded
	 * by frames read, so a turn that never clears fails as the named error
	 * rather than as a stalled read.
	 */
	async function runTurn(window: Window, text: string): Promise<void> {
		const id = window.next++;
		await window.client.request(id, { SubmitPrompt: { session: window.session, text, attachments: [] } });
		for (let read = 0; read < 200; read++) {
			const frame = (await window.client.nextFrame()) as Record<string, unknown>;
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) return;
		}
		throw new Error("the turn never cleared within 200 frames");
	}

	/** The one request the provider was sent for the turn that asked `text`. */
	function requestAsking(text: string): string {
		const matching = requests.filter(request => request.asked === text);
		expect(matching.length).toBe(1);
		return matching[0]?.body ?? "";
	}

	test("three windows each dispatch, and each roster holds only its own work", async () => {
		const first = await openWindow();
		const second = await openWindow();
		const third = await openWindow();

		for (const [window, work] of [
			[first, "first work"],
			[second, "second work"],
			[third, "third work"],
		] as const) {
			expect(await dispatch(window, work)).toEqual({
				RequestSucceeded: { request: window.next - 1 },
			});
		}

		// Each window's own conversation carries its own agent: a roster holding
		// two tans would be one window running another window's work.
		for (const window of [first, second, third]) {
			const rows = await tans(window, 1);
			expect(rows.map(row => row.scope)).toEqual([window.session]);
		}
	});

	test("a window that closes leaves the other windows dispatching", async () => {
		const first = await openWindow();
		const second = await openWindow();
		expect(await dispatch(first, "work the first window sent")).toEqual({
			RequestSucceeded: { request: first.next - 1 },
		});

		windows.splice(windows.indexOf(first), 1);
		first.client.destroy();

		expect(await dispatch(second, "work the second window sent")).toEqual({
			RequestSucceeded: { request: second.next - 1 },
		});
		expect((await tans(second, 1)).map(row => row.scope)).toEqual([second.session]);
	});

	test("a finished job is delivered to the window that asked for it, and to no other", async () => {
		const first = await openWindow();
		const second = await openWindow();
		// A window builds its session on its first turn, so the first window takes
		// a turn before the second dispatches: that makes the first window the one
		// a process-wide manager would belong to, and a second window sharing it
		// would have this delivery drawn in the first window's conversation.
		await runTurn(first, "warm the first window");
		await dispatch(second, "rebuild the index");
		await parkedTan(second);

		// A completion is delivered on the conversation's next turn, so the
		// request each window sent states where the result landed.
		await runTurn(first, "ask from the first window");
		await runTurn(second, "ask from the second window");
		expect(requestAsking("ask from the first window")).not.toContain(ANSWER);
		expect(requestAsking("ask from the second window")).toContain(ANSWER);
	});
});
