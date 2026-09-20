/**
 * WHY: `/btw` is a builtin the terminal answers with a panel of its own, so
 * `textMode` excludes it and the desktop catalogue never carried it. A window
 * could type the command and the host passed it to the model as prose, which
 * is the defect: the question became a turn in the conversation instead of a
 * side request answered beside it.
 *
 * THE CLASS THIS CLOSES: a command the host answers for a window that is not
 * reachable, not ephemeral, or not answered. The sweep over
 * `DESKTOP_HOST_COMMAND_NAMES` fails when a name is added with no catalogue
 * row and no handler, and the ephemerality assertion reads the provider's own
 * context on a second question, which is where a recorded side turn would
 * appear.
 *
 * WHAT IT DOES NOT CATCH: a real provider request (`streamSimple` is stubbed),
 * how the window draws the two entries, which
 * `crates/veyyon-desktop/tests/transcript-roles-retain-their-register-and-searchable-content.rs`
 * owns, and a last frame restating the concatenated deltas rather than the
 * turn's own reply text — the two agree unless the session rewrites the reply
 * on the way out, which is the secret-expansion path `agent-session` owns.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { DESKTOP_HOST_COMMAND_NAMES } from "../../src/gui-host/desktop-commands";
import type { CommandView, TranscriptEntry } from "../../src/gui-host/wire";
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

/** A stream that delivers `text` in two deltas and finishes. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	const half = Math.ceil(text.length / 2);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(0, half), partial: message });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text.slice(half), partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/** A stream that reports a provider failure and finishes. */
function failedStream(failure: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = { ...assistantMessage(""), stopReason: "error", errorMessage: failure };
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

/** A stream that delivers one delta and then waits, so the turn stays open. */
function openStream(text: string, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
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
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
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

/**
 * The entries the side question itself wrote.
 *
 * Opening a session writes its own bookkeeping — the model it resolved, the
 * thinking level, the settings it read — and a request that opens one carries
 * those frames too. They are not what this suite is about.
 */
function sideEntries(frames: RequestFrame[]): TranscriptEntry[] {
	return entries(frames).filter(entry => entry.raw_discriminator.startsWith("side_"));
}

/** The text of the last entry carrying `discriminator`. */
function lastText(frames: RequestFrame[], discriminator: string): string | undefined {
	const matching = entries(frames).filter(entry => entry.raw_discriminator === discriminator);
	const last = matching[matching.length - 1];
	return last?.content.flatMap(block => ("Text" in block ? [block.Text.text] : []))[0];
}

describe("a question asked beside the work is answered from the same context", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-side-question-"));
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

	/** The names one `ListCommands` reply advertised. */
	async function catalogue(id: number): Promise<string[]> {
		const listed = snapshotSections<CommandView[]>((await client.request(id, "ListCommands")).frames, "Commands");
		return (listed[listed.length - 1] ?? []).map(command => command.name);
	}

	test("every command this host answers is listed, before a session exists and after", async () => {
		const missing = (names: string[]): string[] => DESKTOP_HOST_COMMAND_NAMES.filter(n => !names.includes(n));
		expect(missing(await catalogue(1))).toEqual([]);
		// The catalogue read off a live session is a different list: it holds
		// the skills, extension commands and MCP prompts the workspace added.
		await createSession(2);
		expect(missing(await catalogue(3))).toEqual([]);
	});

	test("the question and its answer arrive as their own entries, and the request settles on the answer", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("It is the loader, not the parser."));
		const session = await createSession(1);

		const res = await client.request(2, { RunCommand: { session, text: "/btw which file owns this?" } });
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(lastText(res.frames, "side_question")).toBe("which file owns this?");
		expect(lastText(res.frames, "side_answer")).toBe("It is the loader, not the parser.");
		// The pair is its own register: a side question is neither the operator's
		// prompt nor the agent's reply, so neither role appears for it.
		const written = sideEntries(res.frames);
		expect(written.map(entry => entry.raw_discriminator)[0]).toBe("side_question");
		expect(written.slice(1).map(entry => entry.raw_discriminator)).toEqual(written.slice(1).map(() => "side_answer"));
		expect(written.length).toBeGreaterThan(1);
		expect(entries(res.frames).filter(entry => entry.role !== "Custom")).toEqual([]);
	});

	test("a question is asked of the context and adds nothing to it", async () => {
		const contexts: Context[] = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			contexts.push(context);
			return completedStream(`answer-number-${contexts.length}`);
		});
		const session = await createSession(1);

		await client.request(2, { RunCommand: { session, text: "/btw first question" } });
		await client.request(3, { RunCommand: { session, text: "/btw second question" } });

		expect(contexts.length).toBe(2);
		const second = JSON.stringify(contexts[1]?.messages ?? []);
		expect(second).toContain("second question");
		// The first question and its answer were never recorded, so the second
		// request is built from the same conversation the first one read.
		expect(second).not.toContain("first question");
		expect(second).not.toContain("answer-number-1");
	});

	test("a question with nothing to ask is refused and draws nothing", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("unreachable"));
		const session = await createSession(1);

		const res = await client.request(2, { RunCommand: { session, text: "/btw   " } });
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(res.outcome.RequestFailed?.error.retryable).toBe(false);
		expect(sideEntries(res.frames)).toEqual([]);
	});

	test("a provider failure is stated where the answer would have been, and fails the request", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => failedStream("the provider refused"));
		const session = await createSession(1);

		const res = await client.request(2, { RunCommand: { session, text: "/btw why" } });
		expect(res.outcome.RequestFailed?.error.code).toBe("COMMAND_FAILED");
		const answered = entries(res.frames).filter(entry => entry.raw_discriminator === "side_answer");
		const last = answered[answered.length - 1];
		expect(last?.meta?.error).toContain("the provider refused");
		expect(lastText(res.frames, "side_answer")).toContain("the provider refused");
	});

	test("a question asked while a turn is running is answered without steering it", async () => {
		// The side request is the one carrying the question, and the main turn
		// is the one that stays open: routing on what the request asks keeps
		// the two apart without reading an option the host sets on either.
		const running = new AbortController();
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context, options) =>
			JSON.stringify(context.messages).includes("<btw>")
				? completedStream("beside it")
				: openStream("working on it", options?.signal ?? running.signal),
		);
		const session = await createSession(1);
		const submitted = await client.request(2, {
			SubmitPrompt: { session, text: "do the work", attachments: [] },
		});
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		const res = await client.request(3, { RunCommand: { session, text: "/btw beside" } });
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(lastText(res.frames, "side_answer")).toBe("beside it");
		// The running turn was neither steered nor queued behind: the question
		// was never submitted as a prompt, so no operator entry carries it and
		// the turn that was open when it was asked is still open.
		const asked = entries(res.frames).filter(
			entry => entry.role === "User" && JSON.stringify(entry.content).includes("beside"),
		);
		expect(asked).toEqual([]);
		expect(res.frames.filter(frame => "StreamingChanged" in frame && frame.StreamingChanged === null)).toEqual([]);

		await client.request(4, { AbortTurn: { session } });
	});
});
