/**
 * WHY: every request routes under a provider session id and prompt cache key, and reuses the
 * transport state (a Responses websocket, a Codex session, a completions backend's cached
 * decisions) kept for its provider. One collaborator, `ProviderSessions`, holds all three, and the
 * defects at that boundary share one shape: a request reuses provider state that describes a
 * different transcript or a different backend. A model switch that leaves the old backend's session
 * open replays history the new backend never saw; a switch that closes an unrelated provider's
 * session costs a full re-prefill for nothing; a cache key kept across a transcript change reads the
 * wrong cache, and one dropped without a record is a re-prefill nobody can attribute; a session id
 * that ignores `/fresh` or the configured id routes the request into the wrong provider session.
 *
 * The class this closes is provider state reused after the transcript or backend it describes
 * changed, or discarded when it did not. The model-switch sweep takes one model per API from the
 * bundled catalog at run time, so a new API is swept the moment the catalog ships it. Each case
 * drives the real collaborator against a real `Agent`.
 *
 * What it does not catch: which session paths call each method (the session suites
 * `prompt-cache-key-survives-session-transitions`, `session-fork-prompt-cache-key`,
 * `agent-session-fresh` and `agent-session-openai-completions-model-switch` drive `/new`, `/fork`,
 * `/fresh`, a session switch and a model switch through `AgentSession`).
 */
import { describe, expect, it } from "bun:test";
import { Agent, AppendOnlyContextManager } from "@veyyon/agent-core";
import type { Api, Model, ProviderSessionState } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { ProviderSessions } from "@veyyon/coding-agent/session/runtime/provider-sessions";

interface HarnessOptions {
	configuredId?: string;
	inheritedCacheKey?: string;
	headerKey?: string;
	accountId?: () => string | undefined;
}

function harness(options: HarnessOptions = {}) {
	const agent = new Agent();
	const store = {
		sessionFileId: "file-id",
		headerKey: options.headerKey,
		getSessionId(): string {
			return this.sessionFileId;
		},
		getHeader(): { providerPromptCacheKey?: string } | null {
			return this.headerKey === undefined ? null : { providerPromptCacheKey: this.headerKey };
		},
	};
	const authStorage = { getOAuthAccountId: () => options.accountId?.() } as unknown as AuthStorage;
	const sessions = new ProviderSessions(
		{ agent, sessionStore: store, authStorage: () => authStorage },
		{ configuredId: options.configuredId, inheritedCacheKey: options.inheritedCacheKey },
	);
	return { agent, store, sessions };
}

/** A provider session that records its close, optionally failing it. */
function state(closed: string[], key: string, fails = false): ProviderSessionState {
	return {
		close() {
			closed.push(key);
			if (fails) throw new Error(`close failed: ${key}`);
		},
	};
}

function userIdOf(agent: Agent, provider: string): Record<string, string> {
	const metadata = agent.metadataForProvider(provider) as { user_id: string };
	return JSON.parse(metadata.user_id);
}

describe("the provider session id", () => {
	it("is the /fresh id, else the configured id, else the caller's, else the session file's", () => {
		const configured = harness({ configuredId: "configured" });
		configured.sessions.freshId = "fresh";
		expect(configured.sessions.activeId("given")).toBe("fresh");
		configured.sessions.freshId = undefined;
		expect(configured.sessions.activeId("given")).toBe("configured");

		const plain = harness();
		expect(plain.sessions.activeId("given")).toBe("given");
		expect(plain.sessions.activeId()).toBe("file-id");
		plain.store.sessionFileId = "moved";
		expect(plain.sessions.activeId()).toBe("moved");
	});

	it("reaches the agent and every request's metadata on sync", () => {
		const { agent, sessions } = harness({ configuredId: "configured" });
		sessions.sync();
		expect(agent.sessionId).toBe("configured");
		expect(userIdOf(agent, "openai")).toEqual({ session_id: "configured" });

		sessions.freshId = "fresh";
		expect(agent.sessionId).toBe("configured");
		sessions.sync();
		expect(agent.sessionId).toBe("fresh");
		expect(userIdOf(agent, "openai")).toEqual({ session_id: "fresh" });
	});

	it("reads Anthropic credentials per request, so a login after sync needs no resync", () => {
		let account: string | undefined;
		const { agent, sessions } = harness({ accountId: () => account });
		sessions.sync();
		expect(userIdOf(agent, "anthropic")).toEqual({ session_id: "file-id" });
		account = "account-uuid";
		expect(userIdOf(agent, "anthropic").account_uuid).toBe("account-uuid");
		expect(userIdOf(agent, "openai")).toEqual({ session_id: "file-id" });
	});
});

describe("the inherited prompt cache key", () => {
	it("is adopted from the header when the agent routes on no key, and never over a key it did not inherit", () => {
		const bare = harness({ headerKey: "header-key" });
		bare.sessions.adoptInheritedCacheKey();
		expect(bare.agent.promptCacheKey).toBe("header-key");
		expect(bare.sessions.inheritedCacheKey).toBe("header-key");

		const own = harness({ headerKey: "header-key" });
		own.agent.promptCacheKey = "own-key";
		own.sessions.adoptInheritedCacheKey();
		expect(own.agent.promptCacheKey).toBe("own-key");
		expect(own.sessions.inheritedCacheKey).toBeUndefined();

		const inherited = harness({ headerKey: "header-key", inheritedCacheKey: "fork-key" });
		inherited.agent.promptCacheKey = "fork-key";
		inherited.sessions.adoptInheritedCacheKey();
		expect(inherited.agent.promptCacheKey).toBe("header-key");
		expect(inherited.sessions.inheritedCacheKey).toBe("header-key");
	});

	it("is left alone when the header names no key", () => {
		const { agent, sessions } = harness({ inheritedCacheKey: "fork-key" });
		agent.promptCacheKey = "fork-key";
		sessions.adoptInheritedCacheKey();
		expect(agent.promptCacheKey).toBe("fork-key");
		expect(sessions.inheritedCacheKey).toBe("fork-key");
	});

	it("records a discard, in order and by reason, only when a key was inherited", () => {
		const { agent, sessions } = harness({ inheritedCacheKey: "fork-key" });
		agent.promptCacheKey = "fork-key";
		sessions.clearInheritedCacheKey("model-change");
		expect(agent.promptCacheKey).toBeUndefined();
		sessions.clearInheritedCacheKey("thinking-level-change");
		expect(sessions.cacheKeyDiscards()).toEqual(["model-change"]);

		agent.promptCacheKey = "own-key";
		sessions.restoreCacheKeys("header-key", "own-key");
		sessions.clearInheritedCacheKey("session-switch");
		// The agent routes on a key the session did not inherit, so the discard leaves it in place.
		expect(agent.promptCacheKey).toBe("own-key");
		expect(sessions.cacheKeyDiscards()).toEqual(["model-change", "session-switch"]);
	});

	it("hands out a record no reader can trim", () => {
		const { sessions } = harness({ inheritedCacheKey: "fork-key" });
		sessions.clearInheritedCacheKey("model-change");
		const record = sessions.cacheKeyDiscards();
		expect(Object.isFrozen(record)).toBe(true);
		expect(() => (record as string[]).pop()).toThrow();
		expect(sessions.cacheKeyDiscards()).toEqual(["model-change"]);
	});

	it("puts back both keys a failed switch found", () => {
		const { agent, sessions } = harness();
		sessions.restoreCacheKeys("source-inherited", "source-wire");
		expect(sessions.inheritedCacheKey).toBe("source-inherited");
		expect(agent.promptCacheKey).toBe("source-wire");
	});
});

describe("closing provider sessions", () => {
	it("closes every session on closeAll, past one whose close throws", () => {
		const { sessions } = harness();
		const closed: string[] = [];
		for (const [key, fails] of [
			["a", false],
			["b", true],
			["c", false],
		] as const) {
			sessions.states.set(key, state(closed, key, fails));
		}
		sessions.closeAll("new session");
		expect(closed).toEqual(["a", "b", "c"]);
		expect(sessions.states.size).toBe(0);
	});

	/** One bundled model per API, read from the catalog at run time. */
	function modelPerApi(): Map<Api, Model<Api>> {
		const byApi = new Map<Api, Model<Api>>();
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider)) {
				if (!byApi.has(model.api)) byApi.set(model.api, model);
			}
		}
		return byApi;
	}

	function keysFor(model: Model<Api>): string[] {
		if (model.api === "openai-codex-responses") return ["openai-codex-responses"];
		if (model.api === "openai-responses") return [`openai-responses:${model.provider}`];
		if (model.api === "openai-completions") return [`openai-completions:${model.provider}:resolved:${model.id}`];
		return [];
	}

	it("closes on a model switch exactly the sessions the old and new backends key, and no other", () => {
		const models = [...modelPerApi().values()];
		expect(models.map(model => model.api)).toEqual(
			expect.arrayContaining(["openai-codex-responses", "openai-responses", "openai-completions"]),
		);
		const unrelated = "unrelated-transport";
		for (const current of models) {
			for (const next of models) {
				const { sessions } = harness();
				const closed: string[] = [];
				const all = [...new Set([...models.flatMap(keysFor), unrelated])];
				for (const key of all) sessions.states.set(key, state(closed, key));
				sessions.closeForModelSwitch(current, next);

				const expected = new Set<string>();
				if (current.api === "openai-codex-responses" || next.api === "openai-codex-responses") {
					expected.add("openai-codex-responses");
				}
				for (const model of [current, next]) {
					if (model.api === "openai-responses") expected.add(`openai-responses:${model.provider}`);
				}
				if (current.api === "openai-completions" && current !== next) {
					for (const key of keysFor(current)) expected.add(key);
				}
				const label = `${current.api} -> ${next.api}`;
				expect({ label, closed: closed.toSorted() }).toEqual({ label, closed: [...expected].toSorted() });
				expect({ label, open: [...sessions.states.keys()].toSorted() }).toEqual({
					label,
					open: all.filter(key => !expected.has(key)).toSorted(),
				});
			}
		}
	});

	it("keeps a completions backend's sessions across a switch within the same provider and base URL", () => {
		const completions = modelPerApi().get("openai-completions")!;
		const sibling = { ...completions, id: `${completions.id}-sibling` };
		const moved = { ...completions, baseUrl: `${completions.baseUrl ?? ""}/moved` };
		const { sessions } = harness();
		const closed: string[] = [];
		const prefix = `openai-completions:${completions.provider}:`;
		sessions.states.set(`${prefix}a:one`, state(closed, "one"));
		sessions.states.set(`${prefix}b:two`, state(closed, "two", true));
		sessions.states.set(`openai-completions:other-${completions.provider}:a:three`, state(closed, "three"));

		sessions.closeForModelSwitch(completions, sibling);
		expect(closed).toEqual([]);
		sessions.closeForModelSwitch(completions, moved);
		expect(closed).toEqual(["one", "two"]);
		expect([...sessions.states.keys()]).toEqual([`openai-completions:other-${completions.provider}:a:three`]);
	});

	it("closes the Codex session after a history rewrite only when the model is Codex", () => {
		const models = modelPerApi();
		for (const model of [...models.values(), undefined]) {
			const { sessions } = harness();
			const closed: string[] = [];
			sessions.states.set("openai-codex-responses", state(closed, "codex"));
			sessions.states.set(
				`openai-responses:${models.get("openai-responses")!.provider}`,
				state(closed, "responses"),
			);
			sessions.closeCodexForHistoryRewrite(model);
			expect({ api: model?.api, closed }).toEqual({
				api: model?.api,
				closed: model?.api === "openai-codex-responses" ? ["codex"] : [],
			});
		}
	});

	it("resets a Responses session and its append-only prefix after a stale replay, and nothing else", () => {
		for (const model of [...modelPerApi().values(), undefined]) {
			const { agent, sessions } = harness();
			const manager = new AppendOnlyContextManager();
			agent.setAppendOnlyContext(manager);
			manager.syncMessages([{ role: "user", content: "hello", timestamp: 1 }]);
			const closed: string[] = [];
			for (const key of model ? keysFor(model) : []) sessions.states.set(key, state(closed, key));

			sessions.resetResponses(model, "stale replay");
			const responses = model?.api === "openai-responses" || model?.api === "openai-codex-responses";
			expect({ api: model?.api, closed: closed.length, log: manager.log.length }).toEqual({
				api: model?.api,
				closed: responses ? 1 : 0,
				log: responses ? 0 : 1,
			});
		}
	});
});
