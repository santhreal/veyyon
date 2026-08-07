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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import {
	assertValidCompactionResult,
	type CompactionPreparation,
	REMOTE_COMPACTION_PRESERVE_KEY,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
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

	beforeEach(async () => {
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
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.remote": true, "compaction.keepRecentTokens": 200 }),
			modelRegistry,
		});
	});

	afterEach(async () => {
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
