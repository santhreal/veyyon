/**
 * WHY THIS SUITE EXISTS: a GUI host that dies takes its listener with it, and
 * the desktop window reconnects to the path rather than to the process. What
 * comes back is a different host with no memory of the client: the session the
 * window is showing was activated on a connection that no longer exists, and
 * the window sends no `OpenSession` after a reconnection — its next prompt just
 * names the session it has open. A replacement host that refuses that prompt,
 * that cannot bind the path the dead one left, or that lists none of the dead
 * one's sessions leaves the window attached to something it cannot use.
 *
 * THE CLASS THIS CLOSES: state a host holds per connection that the next host
 * cannot rebuild from disk. The members are the socket path (taken from an
 * entry nothing is listening on, refused while something is), the session index
 * the rail draws, and the active session a prompt names.
 *
 * WHAT IT DOES NOT CATCH: the window's own reconnection schedule, which
 * `crates/veyyon-desktop/tests/a-connection-that-came-back-starts-the-next-retry-from-the-first-attempt.rs`
 * drives over a real socket and `proof/scenes/desktop-host-restart.sh` records
 * against a host killed ten times. The entry a crashed host leaves behind is a
 * socket inode and the one written here is an empty file: both exist, neither
 * answers a connection, and the host takes the same branch for each — a test
 * that killed a real host process would pin the inode type as well. The
 * provider is stubbed at `streamSimple`, so no request leaves the machine.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, AuthStorage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type GuiHostServer, type HostEvent, type SessionSummary, startGuiHostServer } from "../../src/gui-host";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

/** The assistant message every stubbed stream reports, apart from its text. */
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

describe("a session outlives the host process it was opened on", () => {
	let tempDir: string;
	let socketPath: string;
	let authStorage: AuthStorage;
	const hosts: GuiHostServer[] = [];
	const clients: TestSocketClient[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-outlives-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		socketPath = path.join(tempDir, "gui-host.sock");
		authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const client of clients.splice(0)) client.destroy();
		for (const host of hosts.splice(0)) await host.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** A host on the one socket path this suite uses, tracked for teardown. */
	async function startHost(): Promise<GuiHostServer> {
		const host = await startGuiHostServer({
			endpoint: `unix:${socketPath}`,
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		hosts.push(host);
		return host;
	}

	/** A connected client past the greeting and the capabilities snapshot. */
	async function connect(): Promise<TestSocketClient> {
		const client = await TestSocketClient.connect(`unix:${socketPath}`);
		clients.push(client);
		await client.nextFrame();
		await client.nextFrame();
		return client;
	}

	/** What a host that died without unlinking leaves at the path. */
	async function staleEntry(): Promise<void> {
		await fs.writeFile(socketPath, "", "utf8");
	}

	async function createSession(client: TestSocketClient, id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/**
	 * Read frames until the streamed reply clears. `SubmitPrompt` settles when
	 * the session accepts the prompt, so the reply arrives after the request's
	 * own outcome. Bounded, so a reply that never clears fails as this error
	 * rather than as a stalled read.
	 */
	async function replyCleared(client: TestSocketClient): Promise<void> {
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("RequestFailed" in frame) {
				throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			}
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) return;
		}
		throw new Error("the streamed reply never cleared within 200 frames");
	}

	/**
	 * The session file's message entries, once it holds at least `expected`.
	 * Every read is triggered by a write to the directory rather than by
	 * elapsed time, so the suite carries no wall-clock delay.
	 */
	async function messagesOnDisk(file: string, expected: number): Promise<SessionEntry[]> {
		const changes = fs.watch(path.dirname(file))[Symbol.asyncIterator]();
		try {
			for (let read = 0; read < 200; read++) {
				const reloaded = await SessionManager.open(file);
				const messages = reloaded.getEntries().filter((entry: SessionEntry) => entry.type === "message");
				if (messages.length >= expected) return messages;
				if ((await changes.next()).done) break;
			}
		} finally {
			await changes.return?.();
		}
		throw new Error(`the session file never reached ${expected} message entries`);
	}

	test("a host that is still listening keeps the path instead of being displaced by the next one", async () => {
		const first = await startHost();
		const client = await connect();

		await expect(startHost()).rejects.toThrow(/already in use/);

		// The refusal left the running host alone: it still answers on the path
		// it bound, which is what a second window attaching to a live host does.
		const listed = await client.request(1, { ListSessions: {} });
		expect(listed.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		expect(first.endpoint).toBe(`unix:${socketPath}`);
	});

	test("the replacement host binds the path the dead one left and answers a client on it", async () => {
		const first = await startHost();
		await connect();
		await first.close();
		await staleEntry();

		const second = await startHost();
		expect(second.endpoint).toBe(`unix:${socketPath}`);
		const client = await connect();
		const listed = await client.request(1, { ListSessions: {} });
		expect(listed.outcome).toEqual({ RequestSucceeded: { request: 1 } });
	});

	test("the session a dead host was serving is listed by its replacement and takes the next prompt", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("First answer"));
		const first = await startHost();
		const firstClient = await connect();
		const session = await createSession(firstClient, 1);
		const started = await firstClient.request(2, {
			SubmitPrompt: { session, text: "First question", attachments: [] },
		});
		expect(started.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await replyCleared(firstClient);

		// The host dies with the connection that activated the session, and the
		// entry it was listening on stays where it was.
		await first.close();
		await staleEntry();
		await startHost();
		const secondClient = await connect();

		// The rail is drawn from the index the replacement states, so a session
		// missing here is a session the operator cannot get back to.
		const listed = await secondClient.request(1, { ListSessions: {} });
		expect(listed.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const rows = snapshotSections<[{ value: SessionSummary[] }, unknown[]]>(listed.frames, "Sessions")
			.at(-1)
			?.at(0) as { value: SessionSummary[] } | undefined;
		const row = rows?.value.find(summary => summary.id === session);
		expect(row).toBeDefined();

		// The window sends no OpenSession after a reconnection: the prompt names
		// the session it already has open, and the replacement activates it.
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("Second answer"));
		const resumed = await secondClient.request(2, {
			SubmitPrompt: { session, text: "Second question", attachments: [] },
		});
		expect(resumed.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await replyCleared(secondClient);

		// One transcript, four messages: the turn the replacement ran continued
		// the file the dead host wrote rather than starting one beside it.
		const messages = await messagesOnDisk(row?.path ?? "", 4);
		const texts = messages.map(entry => JSON.stringify((entry as { message?: unknown }).message));
		expect(texts.filter(text => text.includes("First question")).length).toBe(1);
		expect(texts.filter(text => text.includes("First answer")).length).toBe(1);
		expect(texts.filter(text => text.includes("Second question")).length).toBe(1);
		expect(texts.filter(text => text.includes("Second answer")).length).toBe(1);
	});
});
