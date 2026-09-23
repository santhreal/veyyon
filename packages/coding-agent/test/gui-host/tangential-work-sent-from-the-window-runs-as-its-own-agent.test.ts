/**
 * WHY: `/tan` was a terminal controller, so a window that typed it had the text
 * passed to the model as prose: the tangential work became a turn in the
 * conversation it was meant to be kept out of. The dispatch is now
 * `src/task/tan.ts`, which both hosts call, and the window reaches it through
 * the same `RunCommand` path every other host command arrives on.
 *
 * THE CLASS THIS CLOSES: a command the host answers for a window that is
 * reachable but does no work, and work that runs without the conversation or
 * the roster stating it. The catalogue sweep in
 * `a-question-asked-beside-the-work-is-answered-from-the-same-context.test.ts`
 * reads `DESKTOP_HOST_COMMAND_NAMES` at run time, so a name added with no
 * handler turns that suite red; this one drives the dispatch itself and
 * observes what it left behind: the breadcrumb in the parent's transcript, the
 * agent in the roster the window refreshes, and the fork nested in the parent's
 * own directory rather than beside it.
 *
 * WHAT IT DOES NOT CATCH: a real provider request (`streamSimple` is stubbed),
 * how the window draws the breadcrumb, which the desktop's own transcript suite
 * owns, and the second top-level session in one host process, which owns no
 * async job manager and is refused by the driver rather than silently dropped.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { AgentView, TranscriptEntry } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

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

/** Every entry the frames of one request appended or restated, in order. */
function entries(frames: RequestFrame[]): TranscriptEntry[] {
	return frames.flatMap(frame => {
		const appended = frame.TranscriptAppended as { entries: TranscriptEntry[] } | undefined;
		const updated = frame.TranscriptUpdated as { entry: TranscriptEntry } | undefined;
		if (appended) return appended.entries;
		return updated ? [updated.entry] : [];
	});
}

/** The text of every block those entries carry, concatenated. */
function text(frames: RequestFrame[]): string {
	return entries(frames)
		.flatMap(entry => entry.content.flatMap(block => ("Text" in block ? [block.Text.text] : [])))
		.join("\n");
}

describe("tangential work sent from the window runs as its own agent", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-tan-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
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

	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/** The roster one `RefreshAgents` reply carried. */
	async function roster(id: number): Promise<AgentView[]> {
		const sections = snapshotSections<AgentView[]>((await client.request(id, "RefreshAgents")).frames, "Agents");
		return sections[sections.length - 1] ?? [];
	}

	/**
	 * The roster once it lists a tan, or a named failure.
	 *
	 * The dispatch settles when the job is registered, and the fork opens its
	 * own session after that, so the row arrives a moment later. Bounded by the
	 * number of refreshes rather than by elapsed time: a tan that never reaches
	 * the roster fails here instead of stalling the suite.
	 */
	async function rosterWithTan(firstId: number): Promise<AgentView[]> {
		for (let attempt = 0; attempt < 40; attempt++) {
			const listed = await roster(firstId + attempt);
			if (listed.some(agent => agent.display_name === "tan")) return listed;
		}
		throw new Error("no tan reached the roster within 40 refreshes");
	}

	test("work sent with /tan is dispatched, stated in the transcript, and listed as its own agent", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("Ported."));
		const session = await createSession(1);

		const run = await client.request(2, { RunCommand: { session, text: "/tan port the parser" } });
		expect(run.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		// The conversation states that the work was sent, naming the job it was
		// sent as, so the next turn reads its own history and knows a fork is
		// carrying that work rather than adopting it.
		const stated = text(run.frames);
		expect(stated).toContain("port the parser");
		expect(stated).toMatch(/\bbg_\d+\b/);

		const listed = await rosterWithTan(3);
		const tan = listed.find(agent => agent.display_name === "tan");
		expect(tan?.id.startsWith("Tan-")).toBe(true);
		// The fork is the session's own child, not a peer of it: the roster
		// states which conversation it belongs to, which is what scopes the
		// Agents surface to the window that dispatched it.
		expect(tan?.scope).toBe(session);
	});

	test("a /tan with no work is refused, and nothing is dispatched for it", async () => {
		const session = await createSession(1);

		const run = await client.request(2, { RunCommand: { session, text: "/tan   " } });
		expect(run.outcome).toEqual({
			RequestFailed: {
				request: 2,
				error: expect.objectContaining({ code: "INVALID_ARGUMENTS", message: "Usage: /tan <work>" }),
			},
		});
		expect(text(run.frames)).not.toContain("tan");
		expect((await roster(3)).filter(agent => agent.display_name === "tan")).toEqual([]);
	});
});
