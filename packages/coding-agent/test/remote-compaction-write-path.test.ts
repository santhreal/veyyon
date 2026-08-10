/**
 * The DRIVER write path for a server-side compaction.
 *
 * `compactWithProvider` returns `summary: ""` plus the provider window under
 * `REMOTE_COMPACTION_PRESERVE_KEY`, because remote compaction is
 * single-window: the window IS the compacted artifact. Every existing test
 * stopped at that boundary. The engine was covered, the read-side replay was
 * covered, and nothing drove the result through `AgentSession.compact()`,
 * which is where the result is validated, appended, and swapped into the live
 * context. So a successful `POST /responses/compact` round trip was billed,
 * the window was discarded, and the driver threw "Compaction failed: the
 * generated summary is empty; history was left unchanged." on every remote
 * compaction. History was never trimmed. The gap between the two covered ends
 * is exactly the gap that shipped.
 *
 * This suite closes it end to end: a real `AgentSession`, the real
 * `#tryServerSideCompaction` branch, the real OpenAI Responses transport
 * pointed at a local HTTP server that answers the compact endpoint. It
 * asserts the write path completes, the window is persisted verbatim, and the
 * branch is trimmed at `firstKeptEntryId`.
 *
 * The empty-summary-with-no-window case stays fatal, and is asserted here too:
 * an empty summary is valid ONLY because a window stands in its place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import {
	assertValidCompactionResult,
	type CompactionPreparation,
	REMOTE_COMPACTION_PRESERVE_KEY,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { willCompactRemotely } from "@veyyon/coding-agent/modes/components/compaction-summary-message";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { CompactionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** The compaction item OpenAI returns: opaque, and the whole point of the window. */
const COMPACTION_ITEM = {
	type: "compaction",
	encrypted_content: "opaque-encrypted-window-blob",
} as const;

/** A retained item riding along with the compaction item, as the guide describes. */
const RETAINED_ITEM = {
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text: "retained tail" }],
} as const;

interface CompactServer {
	baseUrl: string;
	requests: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

async function startCompactServer(): Promise<CompactServer> {
	const requests: Array<Record<string, unknown>> = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			if (!req.url?.endsWith("/responses/compact")) {
				res.writeHead(404).end("{}");
				return;
			}
			requests.push(JSON.parse(body || "{}"));
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					id: "resp_compact_1",
					object: "response.compaction",
					created_at: 1,
					output: [RETAINED_ITEM, COMPACTION_ITEM],
					usage: { input_tokens: 1234, output_tokens: 56 },
				}),
			);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const port = (server.address() as AddressInfo).port;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		async close() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

describe("a remote compaction result reaching the driver write path", () => {
	let tempDir: TempDir;
	let compactServer: CompactServer;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let firstKeptEntryId: string;
	let sideStreamCalls: number;

	beforeEach(async () => {
		sideStreamCalls = 0;
		tempDir = TempDir.createSync("@pi-remote-compaction-write-");
		compactServer = await startCompactServer();

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("openai", "gpt-5.1");
		if (!bundled) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		// The transport gate is capability DATA plus the Responses api family, so
		// the only edit needed is the host: point it at the local compact server.
		const model = { ...bundled, baseUrl: compactServer.baseUrl, contextWindow: 200_000, maxTokens: 64_000 };
		// The driver gates on this exact call, so assert it rather than the flag:
		// a fixture that stopped resolving a transport would silently take the
		// local path and this suite would pass while covering nothing.
		expect(resolveServerCompactionTransport(model)).toBeDefined();

		// Enough branch history that prepareCompaction has a span to cut.
		for (let i = 0; i < 8; i++) {
			const id = sessionManager.appendMessage({
				role: "user",
				content: `discarded turn ${i}`,
				timestamp: Date.now(),
			});
			if (i === 0) firstKeptEntryId = id;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `discarded reply ${i}` }],
				api: "openai-responses",
				provider: "openai",
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		// The session's local summarizer runs through #sideStreamFn (installed as
		// completeImpl), never through the completeSimple barrel export, so the
		// no-dual-write guard has to watch THIS seam to mean anything.
		const sideStreamFn: StreamFn = () => {
			sideStreamCalls++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "local summary that must never run" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.1",
						stopReason: "stop",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.remote": true, "compaction.keepRecentTokens": 200 }),
			modelRegistry,
			sideStreamFn,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await compactServer?.close();
			await tempDir?.remove();
		}
	});

	it("persists the provider window and trims history instead of rejecting the empty summary", async () => {
		const entriesBefore = sessionManager.getBranch().length;

		const result = await session.compact();

		// The provider really was called: this is the write path for a live
		// round trip, not a synthesized result handed to the validator.
		expect(compactServer.requests).toHaveLength(1);
		// No duplicate compaction: the window the provider returned is the
		// artifact, so the local summarizer must never run for the same span.
		expect(sideStreamCalls).toBe(0);
		expect(willCompactRemotely(session)).toBe(true);

		// Single-window: no summary text, and the window is the artifact.
		expect(result.summary).toBe("");
		const preserved = result.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY] as
			| { provider: string; api: string; window: unknown[] }
			| undefined;
		expect(preserved?.provider).toBe("openai");
		expect(preserved?.api).toBe("openai-responses");
		expect(preserved?.window).toEqual([RETAINED_ITEM, COMPACTION_ITEM]);

		// The entry was appended, carrying the window verbatim.
		const compactionEntry = sessionManager.getBranch().find(e => e.type === "compaction") as
			| CompactionEntry
			| undefined;
		expect(compactionEntry).toBeDefined();
		expect(compactionEntry?.summary).toBe("");
		expect(
			(compactionEntry?.preserveData as Record<string, { window: unknown[] }> | undefined)?.[
				REMOTE_COMPACTION_PRESERVE_KEY
			]?.window,
		).toEqual([RETAINED_ITEM, COMPACTION_ITEM]);

		// History IS trimmed: the live context no longer replays the discarded
		// span, and it is shorter than the branch that produced it.
		const rebuilt = session.agent.state.messages;
		const rendered = JSON.stringify(rebuilt);
		expect(rendered).not.toContain("discarded turn 0");
		expect(rebuilt.length).toBeLessThan(entriesBefore);
	});

	it("still rejects an empty summary that no window stands in for", () => {
		const preparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: "earlier", timestamp: Date.now() }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 1000,
			fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() },
		} as unknown as CompactionPreparation;
		const write = (preserveData: Record<string, unknown> | undefined) =>
			assertValidCompactionResult(preparation, {
				summary: "",
				shortSummary: undefined,
				firstKeptEntryId,
				tokensBefore: 1000,
				details: undefined,
				preserveData,
			});

		expect(() => write(undefined)).toThrow(/no server-side compaction window was stored/);
		// The key alone is not the artifact. A window with no compaction item
		// replays at full size, so accepting it would hide the span behind a
		// blank divider for nothing.
		expect(() =>
			write({
				[REMOTE_COMPACTION_PRESERVE_KEY]: {
					version: 1,
					provider: "openai",
					api: "openai-responses",
					model: "gpt-5.1",
					window: [],
				},
			}),
		).toThrow(/malformed/);
	});
});

describe("compaction.remote off: the local pass runs with the configured compaction model", () => {
	let tempDir: TempDir;
	let compactServer: CompactServer;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let summarizerModels: string[];

	beforeEach(async () => {
		summarizerModels = [];
		tempDir = TempDir.createSync("@pi-remote-compaction-off-");
		compactServer = await startCompactServer();

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("openai", "gpt-5.1");
		if (!bundled) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		// Same model as the remote suite: a transport resolves, so the setting is
		// the ONLY thing keeping the provider's compact endpoint out of this run.
		const model = { ...bundled, baseUrl: compactServer.baseUrl, contextWindow: 200_000, maxTokens: 64_000 };
		expect(resolveServerCompactionTransport(model)).toBeDefined();

		for (let i = 0; i < 8; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: `discarded turn ${i}`,
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `discarded reply ${i}` }],
				api: "openai-responses",
				provider: "openai",
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}

		// The local summarizer runs through the session's side stream seam
		// (#compactWithFallbackModel installs a completeImpl over #sideStreamFn),
		// so the fake answers there and records which model each pass asked for.
		const sideStreamFn: StreamFn = requestModel => {
			summarizerModels.push(requestModel.id);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "local summary text" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					stopReason: "stop",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.remote": false,
				"compaction.keepRecentTokens": 200,
				"compaction.model": "openai/gpt-5-mini",
			}),
			modelRegistry,
			sideStreamFn,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await compactServer?.close();
			await tempDir?.remove();
		}
	});

	it("writes a standard summary produced by the configured model and never calls the provider endpoint", async () => {
		expect(willCompactRemotely(session)).toBe(false);

		const result = await session.compact();

		// The provider's compact endpoint was never called: the setting, not the
		// model's capability data, decided the path.
		expect(compactServer.requests).toHaveLength(0);

		// Every summarizer pass ran on the configured compaction model, not on
		// the session model and not on a fallback the operator did not name.
		expect(summarizerModels.length).toBeGreaterThan(0);
		expect([...new Set(summarizerModels)]).toEqual(["gpt-5-mini"]);

		// A standard local artifact: the engine's composed summary (history plus
		// the split-turn context section), and no provider window beside it.
		expect(result.summary).toContain("local summary text");
		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(result.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY]).toBeUndefined();
		const compactionEntry = sessionManager.getBranch().find(e => e.type === "compaction") as
			| CompactionEntry
			| undefined;
		expect(compactionEntry?.summary).toBe(result.summary);
	});
});

describe("remote compaction with no resolvable credential", () => {
	let tempDir: TempDir;
	let compactServer: CompactServer;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let sideStreamCalls: number;
	let notices: Array<Extract<AgentSessionEvent, { type: "notice" }>>;

	beforeEach(async () => {
		sideStreamCalls = 0;
		notices = [];
		tempDir = TempDir.createSync("@pi-remote-compaction-nokey-");
		compactServer = await startCompactServer();

		// No key for openai: the admission gate's async half must fail open to a
		// local pass AND say so, because the loader label only mirrors the sync
		// half and would otherwise claim "(openai remote compaction)" while a
		// local summarizer grinds in silence.
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// Only anthropic is keyed: openai (the session model) resolves no credential.
		// A key alone is not a candidate under the shipped `auto` fallback strategy,
		// which refuses to spend an account the operator never named for this
		// session, so the anthropic model is ALSO assigned to the `smol` role below
		// (the remedy the auth error itself names). That keeps the row about the
		// downgrade notice rather than about cross-provider candidate selection.
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("openai", "gpt-5.1");
		if (!bundled) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		const model = { ...bundled, baseUrl: compactServer.baseUrl, contextWindow: 200_000, maxTokens: 64_000 };
		expect(resolveServerCompactionTransport(model)).toBeDefined();

		for (let i = 0; i < 8; i++) {
			sessionManager.appendMessage({ role: "user", content: `turn ${i}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply ${i}` }],
				api: "openai-responses",
				provider: "openai",
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}

		const sideStreamFn: StreamFn = () => {
			sideStreamCalls++;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "local fallback summary" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.1",
						stopReason: "stop",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.remote": true, "compaction.keepRecentTokens": 200 }),
			modelRegistry,
			sideStreamFn,
		});
		const localCandidate = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!localCandidate) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		session.settings.setModelRole("smol", `${localCandidate.provider}/${localCandidate.id}`);
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await compactServer?.close();
			await tempDir?.remove();
		}
	});

	it("falls back to the local summarizer and announces the downgrade once", async () => {
		// The label still resolves remote: the notice is the honesty backstop.
		expect(willCompactRemotely(session)).toBe(true);

		const result = await session.compact();

		expect(compactServer.requests).toHaveLength(0);
		// The local chain ran: at least one candidate was summarization-driven
		// (openai first, then the keyed fallback).
		expect(sideStreamCalls).toBeGreaterThanOrEqual(1);
		expect(result.summary).toContain("local fallback summary");

		const fallbackNotices = notices.filter(
			n => n.level === "warning" && n.message.includes("no API key for openai/gpt-5.1"),
		);
		expect(fallbackNotices).toHaveLength(1);
		expect(fallbackNotices[0]?.message).toContain("falling back to local compaction");

		// The dedupe is per failure: a second pass warns again only for a NEW
		// failure, not the same missing key. Fresh history first so the second
		// pass is legal.
		for (let i = 0; i < 8; i++) {
			session.sessionManager.appendMessage({ role: "user", content: `after turn ${i}`, timestamp: Date.now() });
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `after reply ${i}` }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.1",
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
		await session.compact();
		expect(
			notices.filter(n => n.level === "warning" && n.message.includes("no API key for openai/gpt-5.1")),
		).toHaveLength(1);
	});
});
