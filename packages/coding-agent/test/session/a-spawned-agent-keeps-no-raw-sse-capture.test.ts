/**
 * WHY: every session recorded the raw SSE frames of its provider streams into a
 * `RawSseDebugBuffer` of up to 1,000 frames and 512,000 characters. The only readers are the debug
 * viewer and the report bundle, and both read the session the terminal displays, which is always a
 * top-level one. A spawned agent's capture had no reader: it cost a record per stream event while
 * the agent ran and held its frames for as long as the agent stayed live, which is the idle TTL
 * after its last turn. Five turns of four streaming agents held 21 buffers and 8.6 MiB.
 *
 * Class closed: a session whose raw SSE capture no surface can display still captures. Asserted for
 * every session role the factory distinguishes (top-level, spawned by task depth, spawned by
 * parent prefix, both), at the two places capture happens: the observer the main loop hands the
 * provider, and the one `prepareSimpleStreamOptions` hands a side request. A caller's own hook and a
 * caller's own buffer still reach a spawned session.
 *
 * Not caught: a new display surface that reads a spawned agent's session. It would find no buffer
 * and show an empty capture rather than fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model, ProviderResponseMetadata, RawSseEvent, SimpleStreamOptions } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { RawSseDebugBuffer, resolveRawSseDebugBuffer } from "@veyyon/coding-agent/debug/raw-sse-buffer";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@veyyon/coding-agent/session/agent-session-types";
import { type CreateAgentSessionOptions, isSubagentSession } from "@veyyon/coding-agent/session/factory-options";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const FRAME: RawSseEvent = { event: "message_start", data: "{}", raw: ["event: message_start", "data: {}"] };
const RESPONSE: ProviderResponseMetadata = { status: 200, headers: {}, requestId: "req_fake_0001" };

/** Every role the factory distinguishes, by the options that select it. */
const ROLES: Record<string, Partial<CreateAgentSessionOptions>> = {
	"a top-level session": {},
	"an agent spawned by task depth": { taskDepth: 1 },
	"an agent spawned under a parent prefix": { parentTaskPrefix: "0-Main" },
	"an agent spawned with both": { taskDepth: 2, parentTaskPrefix: "0-Main.1-Child" },
};

function bundledModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("missing bundled model anthropic/claude-sonnet-4-5");
	return model as Model;
}

const sessions: AgentSession[] = [];
const tempDirs: string[] = [];
let sharedDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-sse-roles-"));
	authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
});

afterEach(async () => {
	for (const session of sessions.splice(0).reverse()) await session.dispose();
});

afterAll(() => {
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	authStorage.close();
	removeSyncWithRetries(sharedDir);
});

describe("the factory captures raw SSE only for a session a surface can display", () => {
	for (const [role, extra] of Object.entries(ROLES)) {
		it(role, async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `raw-sse-role-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			fs.mkdirSync(cwd, { recursive: true });
			const { session } = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir, "agent"),
				sessionManager: SessionManager.create(cwd, path.join(tempDir, "sessions")),
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
				...extra,
			});
			sessions.push(session);

			const displayable = !isSubagentSession(extra);
			const prepared = await session.prepareSimpleStreamOptions({});
			if (displayable) {
				expect(session.rawSseDebugBuffer).toBeInstanceOf(RawSseDebugBuffer);
				prepared.onSseEvent?.(FRAME, undefined as never);
				expect(session.rawSseDebugBuffer?.snapshot().totalEvents).toBe(1);
				// The viewer reads the same buffer the session records into.
				expect(resolveRawSseDebugBuffer(session)).toBe(session.rawSseDebugBuffer as RawSseDebugBuffer);
			} else {
				expect(session.rawSseDebugBuffer).toBeUndefined();
				// No observer: the provider neither builds a record per event nor names one.
				expect(prepared.onSseEvent).toBeUndefined();
			}
		});
	}
});

describe("the main loop hands the provider a raw SSE observer only when something reads it", () => {
	interface Captured {
		onSseEvent: SimpleStreamOptions["onSseEvent"];
		onResponse: SimpleStreamOptions["onResponse"];
	}

	/** Run one real turn through the session; the stream reports one response and one frame. */
	async function runTurn(config: Partial<AgentSessionConfig>): Promise<{ session: AgentSession; seen: Captured }> {
		const mock = createMockModel();
		let seen: Captured | undefined;
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model: bundledModel(), systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (model, context, options) => {
				seen = { onSseEvent: options?.onSseEvent, onResponse: options?.onResponse };
				await options?.onResponse?.(RESPONSE, model);
				options?.onSseEvent?.(FRAME, model);
				mock.push({ content: ["ok"] });
				return mock.stream(model, context, options);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			...config,
		});
		sessions.push(session);
		await session.prompt("go");
		await session.waitForIdle();
		if (!seen) throw new Error("the turn never reached the provider");
		return { session, seen };
	}

	it("records the response and the frame of a top-level turn", async () => {
		const { session, seen } = await runTurn({});
		expect(seen.onSseEvent).toBeDefined();
		const records = session.rawSseDebugBuffer?.snapshot().records ?? [];
		expect(records.map(record => record.kind)).toEqual(["response", "event"]);
		expect(records[1]?.kind === "event" ? records[1].raw : undefined).toEqual(FRAME.raw);
	});

	it("hands a spawned agent's provider no observer and keeps no buffer", async () => {
		const { session, seen } = await runTurn({ isSpawned: true });
		expect(session.rawSseDebugBuffer).toBeUndefined();
		expect(seen.onSseEvent).toBeUndefined();
		// Response headers still reach the session: usage accounting reads them.
		expect(seen.onResponse).toBeDefined();
	});

	it("still delivers a caller's own hook to a spawned agent's provider", async () => {
		const frames: RawSseEvent[] = [];
		const onSseEvent = (event: RawSseEvent) => {
			frames.push(event);
		};
		const { session, seen } = await runTurn({ isSpawned: true, onSseEvent });
		expect(session.rawSseDebugBuffer).toBeUndefined();
		expect(seen.onSseEvent).toBe(onSseEvent);
		expect(frames).toEqual([FRAME]);
	});

	it("records into a caller's own buffer on a spawned agent", async () => {
		const rawSseDebugBuffer = new RawSseDebugBuffer();
		const { session } = await runTurn({ isSpawned: true, rawSseDebugBuffer });
		expect(session.rawSseDebugBuffer).toBe(rawSseDebugBuffer);
		expect(rawSseDebugBuffer.snapshot().records.map(record => record.kind)).toEqual(["response", "event"]);
	});
});
