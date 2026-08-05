/**
 * Provider prompt-cache routing identity: stability across turns, distinctness
 * across conversations, and survival of the session transitions that keep the
 * cached prefix valid.
 *
 * Every OpenAI-family transport routes its `prompt_cache_key` on
 * `promptCacheKey ?? sessionId` (`getOpenAIPromptCacheKey` in
 * `packages/ai/src/providers/openai-shared.ts`). A key that rotates when the
 * prefix did not is the most expensive failure the harness can have and is
 * invisible in the UI: the request still succeeds, it just pays a full uncached
 * prefill of the whole transcript instead of a cache read. These tests assert
 * the exact wire value, not shape.
 *
 * Bugs locked out:
 *  - `SessionManager.createBranchedSession` minted a new session id and left
 *    `providerPromptCacheKey` unset, unlike `fork()`/`createFromFile`. Every
 *    `/branch` rewind and every `/btw` therefore cold-missed the retained
 *    prefix, which for `/btw` is the entire conversation byte-for-byte.
 *  - `AgentSession.branch` / `branchFromBtw` never adopted the branch header's
 *    inherited cache identity, so even a seeded header would have been ignored.
 *  - Side requests (`runEphemeralTurn`, driving `/btw` and IRC replies) routed
 *    on the session id instead of the agent's pinned `promptCacheKey`, so
 *    fork/tan/shared sessions sent them to a shard the live turns never wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { SimpleStreamOptions } from "@veyyon/ai";
import { createMockModel, type MockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { getOpenAIPromptCacheKey } from "@veyyon/ai/providers/openai-shared";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

// `runEphemeralTurn` dispatches through `streamSimple`, which resolves the
// transport from `model.api` rather than the agent's `streamFn`. Register the
// mock transport so side-channel turns are observable on `mock.calls`.
registerMockApi();

describe("provider prompt-cache key across session transitions", () => {
	let tempDir: string;
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-cache-key-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		vi.restoreAllMocks();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	async function createSession(options?: {
		persist?: boolean;
		providerPromptCacheKey?: string;
	}): Promise<{ session: AgentSession; mock: MockModel; sessionManager: SessionManager }> {
		const mock = createMockModel({ handler: { content: ["ok"], stopReason: "stop" } });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test system prompt"], tools: [] },
			streamFn: mock.stream,
			promptCacheKey: options?.providerPromptCacheKey,
		});
		const sessionManager =
			options?.persist === true ? SessionManager.create(tempDir, tempDir) : SessionManager.inMemory(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("mock", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false, "compaction.keepRecentTokens": 1 }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, `models-${Snowflake.next()}.yml`)),
			...(options?.providerPromptCacheKey === undefined ? {} : { providerPromptCacheKeySource: "fork" as const }),
		});
		session.subscribe(() => {});
		sessions.push(session);
		return { session, mock, sessionManager };
	}

	/**
	 * The baseline the whole cache economy rests on. If this ever fails, every
	 * turn after the first is a full uncached prefill of the entire transcript.
	 */
	it("sends the identical key on every turn of one session", async () => {
		const { session, mock, sessionManager } = await createSession();

		await session.prompt("first turn");
		await session.waitForIdle();
		await session.prompt("second turn");
		await session.waitForIdle();
		await session.prompt("third turn");
		await session.waitForIdle();

		expect(mock.calls.length).toBe(3);
		const keys = mock.calls.map(call => getOpenAIPromptCacheKey(call.options));
		expect(keys).toEqual([sessionManager.getSessionId(), sessionManager.getSessionId(), sessionManager.getSessionId()]);
	});

	/**
	 * Distinctness. Two unrelated conversations sharing a key would route to one
	 * shard and contend over the same prefix tree.
	 */
	it("sends a different key for a second, unrelated session", async () => {
		const a = await createSession();
		const b = await createSession();

		await a.session.prompt("conversation A");
		await a.session.waitForIdle();
		await b.session.prompt("conversation B");
		await b.session.waitForIdle();

		const keyA = getOpenAIPromptCacheKey(a.mock.calls[0]?.options);
		const keyB = getOpenAIPromptCacheKey(b.mock.calls[0]?.options);
		expect(keyA).toBe(a.sessionManager.getSessionId());
		expect(keyB).toBe(b.sessionManager.getSessionId());
		expect(keyA).not.toBe(keyB);
	});

	/**
	 * `createBranchedSession` retains a genuine prefix of the source transcript,
	 * so the source's cache identity is still valid for it. Before the fix the
	 * header carried no `providerPromptCacheKey` at all and the reminted session
	 * id became the key.
	 */
	it("carries the source cache identity onto a branched session header", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		const sourceSessionId = sessionManager.getSessionId();
		expect(sessionManager.getHeader()?.providerPromptCacheKey).toBeUndefined();

		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: Date.now() });
		const leafId = sessionManager.getEntries().at(-1)?.id;
		if (leafId === undefined) throw new Error("expected an appended entry");

		sessionManager.createBranchedSession(leafId);

		expect(sessionManager.getSessionId()).not.toBe(sourceSessionId);
		expect(sessionManager.getHeader()?.providerPromptCacheKey).toBe(sourceSessionId);
	});

	/** A branch of a branch keeps pointing at the ORIGINAL cache identity rather
	 * than re-pinning to the intermediate session id, so a chain of rewinds still
	 * reads the one prefix that was actually written. */
	it("keeps the original cache identity across a chain of branches", async () => {
		const sessionManager = SessionManager.inMemory(tempDir);
		const rootSessionId = sessionManager.getSessionId();

		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: Date.now() });
		const firstLeaf = sessionManager.getEntries().at(-1)?.id;
		if (firstLeaf === undefined) throw new Error("expected an appended entry");
		sessionManager.createBranchedSession(firstLeaf);
		const intermediateSessionId = sessionManager.getSessionId();

		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "two" }], timestamp: Date.now() });
		const secondLeaf = sessionManager.getEntries().at(-1)?.id;
		if (secondLeaf === undefined) throw new Error("expected a second appended entry");
		sessionManager.createBranchedSession(secondLeaf);

		expect(sessionManager.getSessionId()).not.toBe(intermediateSessionId);
		expect(sessionManager.getHeader()?.providerPromptCacheKey).toBe(rootSessionId);
	});

	/**
	 * End to end for `/branch`: the turn issued after a rewind must route under
	 * the pre-branch key. Before the fix it routed under the freshly minted
	 * session id and re-prefilled everything the branch retained.
	 */
	it("routes post-branch turns under the pre-branch key", async () => {
		const { session, mock, sessionManager } = await createSession({ persist: true });
		const originalSessionId = sessionManager.getSessionId();

		await session.prompt("first turn");
		await session.waitForIdle();
		await session.prompt("second turn");
		await session.waitForIdle();
		expect(getOpenAIPromptCacheKey(mock.calls[0]?.options)).toBe(originalSessionId);

		const branchable = session.getUserMessagesForBranching();
		const target = branchable.at(-1);
		if (target === undefined) throw new Error("expected a branchable user message");
		const result = await session.branch(target.entryId);
		expect(result.cancelled).toBe(false);
		expect(sessionManager.getSessionId()).not.toBe(originalSessionId);

		await session.prompt("post-branch turn");
		await session.waitForIdle();

		const postBranch = mock.calls.at(-1);
		expect(getOpenAIPromptCacheKey(postBranch?.options)).toBe(originalSessionId);
		expect(postBranch?.options?.sessionId).toBe(sessionManager.getSessionId());
		// A branch preserves the cache identity, so it must not be recorded as a
		// discard: that record is the session's re-prefill cost evidence.
		expect(session.providerCacheKeyDiscards()).toEqual([]);
	});

	/**
	 * `/btw` branches at the live leaf, so its retained prefix is byte-identical
	 * to what the session just cached — the single worst place to rotate the key.
	 */
	it("routes turns after /btw under the pre-btw key", async () => {
		const { session, mock, sessionManager } = await createSession({ persist: true });
		const originalSessionId = sessionManager.getSessionId();

		await session.prompt("first turn");
		await session.waitForIdle();

		const btw = await session.branchFromBtw("aside question", {
			role: "assistant",
			content: [{ type: "text", text: "aside answer" }],
			api: "mock",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		expect(btw.cancelled).toBe(false);
		expect(sessionManager.getSessionId()).not.toBe(originalSessionId);

		await session.prompt("turn after btw");
		await session.waitForIdle();

		expect(getOpenAIPromptCacheKey(mock.calls.at(-1)?.options)).toBe(originalSessionId);
	});

	/**
	 * Fork affinity: an explicitly pinned key must win over the session id on
	 * every turn, and must not drift as turns accumulate.
	 */
	it("keeps an explicitly pinned fork key on every turn", async () => {
		const { session, mock, sessionManager } = await createSession({ providerPromptCacheKey: "parent-cache-shard" });
		expect(sessionManager.getSessionId()).not.toBe("parent-cache-shard");

		await session.prompt("first turn");
		await session.waitForIdle();
		await session.prompt("second turn");
		await session.waitForIdle();

		expect(mock.calls.map(call => getOpenAIPromptCacheKey(call.options))).toEqual(["parent-cache-shard", "parent-cache-shard"]);
	});

	/**
	 * Side requests (`/btw` render, IRC replies) reuse the live prefix, so they
	 * must reuse the live key. Before the fix they used the session id, which for
	 * a fork/tan/shared session is a shard nothing ever wrote — a guaranteed miss
	 * on a request that carries the entire transcript.
	 */
	it("routes ephemeral side turns under the pinned key, not the session id", async () => {
		const { session, mock, sessionManager } = await createSession({ providerPromptCacheKey: "parent-cache-shard" });

		await session.runEphemeralTurn({ promptText: "side channel question" });

		const call = mock.calls.at(-1);
		expect(getOpenAIPromptCacheKey(call?.options)).toBe("parent-cache-shard");
		// Request lineage stays distinct so append-only provider state never mixes
		// with the main turn; only the cache identity is shared.
		expect(call?.options?.sessionId).toStartWith(`${sessionManager.getSessionId()}:side:`);
	});

	/**
	 * Boundary: with no pinned key, the ephemeral turn still routes under the
	 * session id rather than the unique side lineage, so IRC/`/btw` traffic in an
	 * ordinary session shares the main prefix.
	 */
	it("falls back to the session id for ephemeral turns with no pinned key", async () => {
		const { session, mock, sessionManager } = await createSession();

		await session.runEphemeralTurn({ promptText: "side channel question" });

		const call = mock.calls.at(-1);
		expect(getOpenAIPromptCacheKey(call?.options)).toBe(sessionManager.getSessionId());
		expect(call?.options?.sessionId).not.toBe(sessionManager.getSessionId());
	});

	/**
	 * Compaction summarizes the live transcript, so it is the single biggest side
	 * request the session issues. Before the fix it routed on the session id and
	 * a fork/tan session paid a full uncached prefill of everything it summarized.
	 */
	it("routes compaction under the pinned key, not the session id", async () => {
		const { session, sessionManager } = await createSession({ providerPromptCacheKey: "parent-cache-shard" });

		await session.prompt("first turn ".repeat(80));
		await session.waitForIdle();
		await session.prompt("second turn ".repeat(80));
		await session.waitForIdle();
		await session.prompt("third turn ".repeat(80));
		await session.waitForIdle();

		const lastEntryId = sessionManager.getBranch().at(-1)?.id;
		if (lastEntryId === undefined) throw new Error("expected a persisted entry to compact from");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const options = compactSpy.mock.calls[0]?.[5];
		expect(options?.promptCacheKey).toBe("parent-cache-shard");
		expect(options?.sessionId).toBe(sessionManager.getSessionId());
	});

	/** Boundary: with no pinned key compaction still rides the session's own key
	 * rather than dropping it, which would make every compaction a cold prefill. */
	it("routes compaction under the session id when no key is pinned", async () => {
		const { session, sessionManager } = await createSession();

		await session.prompt("first turn ".repeat(80));
		await session.waitForIdle();
		await session.prompt("second turn ".repeat(80));
		await session.waitForIdle();
		await session.prompt("third turn ".repeat(80));
		await session.waitForIdle();

		const lastEntryId = sessionManager.getBranch().at(-1)?.id;
		if (lastEntryId === undefined) throw new Error("expected a persisted entry to compact from");
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		expect(compactSpy.mock.calls[0]?.[5]?.promptCacheKey).toBe(sessionManager.getSessionId());
	});
});
