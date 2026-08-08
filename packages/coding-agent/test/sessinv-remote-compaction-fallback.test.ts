/**
 * WHY: `compaction.remote: true` with a failing compact endpoint must fall
 * back to the local summarizer, and the failure must cost exactly what the
 * design says it costs: ONE provider compact request and ONE local summary —
 * never two summaries for one span, never a discarded provider window beside
 * a local one, and the session must still compact. Commit f6f2d26c0 ("let
 * OpenAI compact once instead of paying twice") established the cost
 * contract; remote-compaction-write-path.test.ts covers the SUCCESS round
 * trip end to end, but no suite drove the failure branch of
 * `#tryServerSideCompaction` — the `catch` that logs, announces, and returns
 * undefined so the local pass runs. A regression there (rethrow, double
 * local pass, window persisted beside the summary) shipped silent: the
 * operator pays for the remote call AND still compacts locally, or worse,
 * compaction dies whenever the provider hiccups.
 *
 * The endpoint answers 400, not 500: a client error is non-retryable, so the
 * single-request assertion pins the compaction driver's accounting without
 * entangling the transport's legitimate retry policy for transient 5xx.
 *
 * The harness mirrors remote-compaction-write-path.test.ts deliberately: same
 * real AgentSession, same real OpenAI Responses model pointed at a local
 * server, same sideStreamFn seam — so the ONLY difference from the green
 * path is the endpoint's status code.
 *
 * Mutation gate (traced): rethrow instead of falling back → compact()
 * rejects and the result assertions never run; any extra local pass → the
 * summarizer-call assertions fail; persist the window beside the local
 * summary → the preserveData assertions fail; skip trimming after fallback →
 * "discarded turn 0" reappears in the rebuilt context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import { REMOTE_COMPACTION_PRESERVE_KEY, resolveServerCompactionTransport } from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { CompactionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

interface CompactServer {
	baseUrl: string;
	requests: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

/** A compact endpoint that is up and reachable but refuses every request. */
async function startRefusingCompactServer(): Promise<CompactServer> {
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
			requests.push(JSON.parse(body || "{}") as Record<string, unknown>);
			res.writeHead(400, { "content-type": "application/json" }).end(
				JSON.stringify({
					error: { message: "compact endpoint disabled in this test", type: "invalid_request_error" },
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

describe("compaction.remote on, endpoint failing: one compact request, one local summary, history still trimmed", () => {
	let tempDir: TempDir;
	let compactServer: CompactServer;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let summarizerModelIds: string[];

	beforeEach(async () => {
		summarizerModelIds = [];
		tempDir = TempDir.createSync("@pi-sessinv-remote-fallback-");
		compactServer = await startRefusingCompactServer();

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("openai", "gpt-5.1");
		if (!bundled) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		// Same gate as the green-path suite: the transport resolves, so the
		// setting really is what drives the remote attempt.
		const model = { ...bundled, baseUrl: compactServer.baseUrl, contextWindow: 200_000, maxTokens: 64_000 };
		expect(resolveServerCompactionTransport(model)).toBeDefined();

		// Enough branch history that prepareCompaction has a span to cut.
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

		// The local fallback summarizer runs through #sideStreamFn; every pass
		// is observed here, with the model it was asked to use.
		const sideStreamFn: StreamFn = requestModel => {
			summarizerModelIds.push(requestModel.id);
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "LOCAL-FALLBACK-SUMMARY: the eight discarded turns condensed" }],
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
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
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

	it("falls back to exactly one local summary and never stores a provider window beside it", async () => {
		const result = await session.compact();

		// The remote attempt really happened and was billed once.
		expect(compactServer.requests).toHaveLength(1);
		// The fallback ran the local summarizer on the session model (no
		// compaction.model configured). The fixture's cut is a split turn, so
		// exactly two passes run — history plus turn-prefix — both on the same
		// model, never more (the paying-twice class).
		expect(summarizerModelIds).toEqual(["gpt-5.1", "gpt-5.1"]);

		// The result is a standard local artifact: composed summary text, and
		// NO provider window riding beside it.
		expect(result.summary).toContain("LOCAL-FALLBACK-SUMMARY");
		expect(result.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY]).toBeUndefined();
		const compactionEntry = sessionManager.getBranch().find(e => e.type === "compaction") as
			| CompactionEntry
			| undefined;
		expect(compactionEntry).toBeDefined();
		expect(compactionEntry?.summary).toBe(result.summary);
		expect(compactionEntry?.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY]).toBeUndefined();

		// History IS trimmed: the discarded span is gone from the rebuilt context.
		const rebuilt = session.agent.state.messages;
		expect(JSON.stringify(rebuilt)).not.toContain("discarded turn 0");
	});
});
