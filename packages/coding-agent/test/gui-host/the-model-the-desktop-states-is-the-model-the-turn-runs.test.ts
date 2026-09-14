/**
 * WHY:
 *
 * The composer's model control draws whatever the `Models` snapshot's `current`
 * names, and the host resolved that field from `modelRoles.default` alone --- a
 * slot the product documents as legacy and no ordinary configuration writes. A
 * session resolves its model through a longer chain (the default role, then the
 * allowed set, then the first authenticated provider default), so on every
 * machine whose operator never hand-picked a model the window said "Select
 * model" while a submitted prompt ran on a model it had never named. Nothing
 * republished the snapshot once the session existed either: `Models` was sent
 * by `RefreshModels`, `SelectModel`, `SetThinkingLevel` and a credential
 * change, and never by creating, opening or first prompting a session.
 *
 * The class this closes: the model surface states something other than the
 * model the next turn will run on.
 *
 * This suite defends:
 * 1. The model stated before any session exists is the model the turn then
 *    runs on, read back from the host after a real turn.
 * 2. The same holds when the configured default role names a provider with no
 *    credential, where the product substitutes.
 * 3. `enabledModels` narrows the offered list to what a turn could run.
 * 4. The desktop is told the session's model without asking for it.
 *
 * What it does NOT catch: a discovery-backed provider whose models arrive from
 * its own endpoint (discovery is disabled under the test runtime), and how the
 * desktop draws the control.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, AuthStorage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { resetSettingsForTest } from "../../src/config/settings";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ModelRef, ModelsView } from "../../src/gui-host/wire";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

/** The provider this suite signs in; the bundled catalog lists it. */
const PROVIDER = "anthropic";
/** A provider the suite deliberately leaves without a credential. */
const UNAUTHENTICATED = "openai";
const SECRET = "sk-ant-not-a-real-key-000111";

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

function modelsFrom(frames: RequestFrame[]): ModelsView {
	const views = snapshotSections<ModelsView>(frames, "Models");
	if (views.length === 0) throw new Error("no Models snapshot in frames");
	return views[0];
}

function named(model: ModelRef | null): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

describe("the model the desktop states", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let authStorage: AuthStorage;
	let client: TestSocketClient | null = null;

	beforeEach(async () => {
		// A session initializes the process-wide settings singleton, and one left
		// over from another test resolves against a directory this test does not
		// own: the model a session picks would then come from someone else's
		// configuration. Cleared on both sides so this file neither inherits one
		// nor leaves one.
		resetSettingsForTest();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-stated-model-"));
		authStorage = await isolatedAuthStorage(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client?.destroy();
		client = null;
		if (server) {
			await server.close();
			server = null;
		}
		resetSettingsForTest();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup error
		}
	});

	async function start(config?: string): Promise<TestSocketClient> {
		if (config !== undefined) await fs.writeFile(path.join(tempDir, "config.yml"), config, "utf8");
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
		return client;
	}

	/** Create a session through the wire and answer with the id the host activated. */
	async function createSession(connected: TestSocketClient, id: number): Promise<string> {
		const created = await connected.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/** Read frames until the streamed reply clears, so the turn has ended. */
	async function drainTurn(connected: TestSocketClient): Promise<RequestFrame[]> {
		const frames: RequestFrame[] = [];
		for (let read = 0; read < 200; read++) {
			const frame = (await connected.nextFrame()) as RequestFrame;
			frames.push(frame);
			if (frame.RequestFailed) {
				throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			}
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) return frames;
		}
		throw new Error("the streamed reply never cleared within 200 frames");
	}

	/**
	 * The model stated before a session exists, and the one in effect after a
	 * real turn has run, with every frame the prompt produced. Nothing here
	 * resolves a model of its own: both readings come off the wire.
	 */
	async function statedThenRan(config?: string): Promise<{
		stated: ModelRef | null;
		ran: ModelRef | null;
		turnFrames: RequestFrame[];
	}> {
		await authStorage.set(PROVIDER, { type: "api_key", key: SECRET });
		const connected = await start(config);
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("Hello from engine!"));
		const stated = modelsFrom((await connected.request(1, "RefreshModels")).frames).current;
		const session = await createSession(connected, 2);
		const submitted = await connected.request(3, {
			SubmitPrompt: { session, text: "Hello assistant", attachments: [] },
		});
		const turnFrames = [...submitted.frames, ...(await drainTurn(connected))];
		const ran = modelsFrom((await connected.request(4, "RefreshModels")).frames).current;
		return { stated, ran, turnFrames };
	}

	test("the model stated before a turn is the model the turn runs on", async () => {
		const { stated, ran } = await statedThenRan();
		expect(named(ran)).not.toBe("none");
		expect(named(stated)).toBe(named(ran));
	});

	test("a default role whose provider holds no credential states the substitute", async () => {
		const { stated, ran } = await statedThenRan(`modelRoles:\n  default: ${UNAUTHENTICATED}/gpt-4o-mini\n`);
		expect(ran?.provider).toBe(PROVIDER);
		expect(named(stated)).toBe(named(ran));
	});

	test("a configured default role is the model stated and the model run", async () => {
		const role = `${PROVIDER}/claude-haiku-4-5`;
		const { stated, ran } = await statedThenRan(`modelRoles:\n  default: ${role}\n`);
		expect(named(ran)).toBe(role);
		expect(named(stated)).toBe(role);
	});

	test("a live session keeps the answer when the scope narrows under it", async () => {
		const { ran } = await statedThenRan();
		const connected = client;
		if (!connected) throw new Error("no client");

		// Narrowing `enabledModels` to something else does not move a running
		// session off the model it resolved: the offered list follows the new
		// scope, and the model in effect is still the session's own.
		const narrowed = `${PROVIDER}/claude-haiku-4-5`;
		expect(narrowed).not.toBe(named(ran));
		const applied = await connected.request(5, { SetSetting: { key: "enabledModels", value: [narrowed] } });
		expect(applied.outcome).toEqual({ RequestSucceeded: { request: 5 } });

		const view = modelsFrom((await connected.request(6, "RefreshModels")).frames);
		expect(view.models.map(model => `${model.provider}/${model.id}`)).toEqual([narrowed]);
		expect(named(view.current)).toBe(named(ran));
	});

	test("the session's model is published without a model request", async () => {
		const { turnFrames, ran } = await statedThenRan();
		const published = snapshotSections<ModelsView>(turnFrames, "Models").map(view => named(view.current));
		expect(published).toContain(named(ran));
	});

	test("enabledModels narrows the offered list to what a turn could run", async () => {
		await authStorage.set(PROVIDER, { type: "api_key", key: SECRET });
		const connected = await start(`enabledModels:\n  - ${PROVIDER}/claude-opus-4-8\n`);
		const view = modelsFrom((await connected.request(1, "RefreshModels")).frames);
		expect(view.models.map(model => `${model.provider}/${model.id}`)).toEqual([`${PROVIDER}/claude-opus-4-8`]);
		expect(named(view.current)).toBe(`${PROVIDER}/claude-opus-4-8`);
	});

	test("SelectModel refuses a model outside the enabledModels scope", async () => {
		await authStorage.set(PROVIDER, { type: "api_key", key: SECRET });
		const connected = await start(`enabledModels:\n  - ${PROVIDER}/claude-opus-4-8\n`);
		const { outcome } = await connected.request(1, {
			SelectModel: { provider: PROVIDER, model: "claude-sonnet-4-5" },
		});
		expect(outcome.RequestFailed?.error.code).toBe("MODEL_NOT_ENABLED");

		// Refused means unchanged: the model in effect is still the allowed one.
		const view = modelsFrom((await connected.request(2, "RefreshModels")).frames);
		expect(named(view.current)).toBe(`${PROVIDER}/claude-opus-4-8`);
	});
});
