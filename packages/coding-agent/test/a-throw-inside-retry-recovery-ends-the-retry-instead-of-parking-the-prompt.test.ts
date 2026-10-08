/**
 * WHY: retry recovery opens the retry gate `prompt()` waits on before it rotates a credential,
 * resolves a fallback model or records the model switch. Every one of those steps reaches a store
 * outside the process (the SQLite auth store, a credential source, the session file), and a throw
 * from any of them escaped with the gate still open, so the prompt that hit one rate limit never
 * settled and the session reported `isRetrying` forever.
 *
 * Class closed: a throw from any step of retry recovery, exercised at each external boundary it
 * calls. The invariant is asserted at the one entry every recovery passes through: the prompt
 * settles within a stated bound, `auto_retry_end` reports the failure with the thrown text, the
 * gate is closed, and the next failure retries from attempt 1 and recovers.
 *
 * Gap: the boundaries below are the ones recovery calls today. A new boundary added to recovery is
 * covered by the same entry-point handling but is not exercised here until it gets a row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function bundled(provider: string, id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
	return model as Model;
}

const primary = bundled("anthropic", "claude-sonnet-4-5");
const fallback = bundled("openai", "gpt-4o-mini");
const primarySelector = `${primary.provider}/${primary.id}`;
const fallbackSelector = `${fallback.provider}/${fallback.id}`;

/**
 * Upper bound on one failed turn plus its recovery. Recovery sleeps at most 5 ms and every
 * request is a mock, so a settled turn takes tens of milliseconds; one still open is parked.
 */
const TURN_SETTLE_BOUND_MS = 2_000;

interface Boundary {
	/** The provider failure that sends the turn into this recovery step. */
	providerError: string;
	/** Chains that make recovery reach the step; undefined leaves chains unset. */
	fallbackChains?: Record<string, string[]>;
	/** Makes the boundary fail the way it does in production. */
	breakIt(session: AgentSession, registry: ModelRegistry): void;
	/** Text of the thrown failure, which `auto_retry_end` must report. */
	failure: string;
}

/** Each external boundary retry recovery calls, broken the way it breaks in production. */
const BOUNDARIES: Record<string, Boundary> = {
	"the auth store rejects a usage-limit park": {
		providerError: "429 usage_limit_reached",
		breakIt: (_session, registry) => {
			vi.spyOn(registry.authStorage, "markUsageLimitReached").mockRejectedValue(new Error("database is locked"));
		},
		failure: "database is locked",
	},
	"the fallback model's credential lookup rejects": {
		providerError: "rate limit exceeded retry-after-ms=5",
		fallbackChains: { default: [fallbackSelector] },
		breakIt: (_session, registry) => {
			const getApiKey = registry.getApiKey.bind(registry);
			vi.spyOn(registry, "getApiKey").mockImplementation((model, sessionId) =>
				model.provider === fallback.provider
					? Promise.reject(new Error("credential helper exited with status 1"))
					: getApiKey(model, sessionId),
			);
		},
		failure: "credential helper exited with status 1",
	},
	"the session file rejects the model switch": {
		providerError: "rate limit exceeded retry-after-ms=5",
		fallbackChains: { default: [fallbackSelector] },
		breakIt: session => {
			vi.spyOn(session.sessionManager, "appendModelChange").mockImplementation(() => {
				throw new Error("ENOSPC: no space left on device, write");
			});
		},
		failure: "ENOSPC: no space left on device, write",
	},
};

let tempDir: TempDir;
let authStorage: AuthStorage;
let registry: ModelRegistry;

beforeAll(async () => {
	tempDir = TempDir.createSync("@retry-recovery-throw-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	registry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Prompt and wait for idle, failing with a named error when the turn does not settle in the bound. */
async function settle(session: AgentSession, text: string): Promise<void> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error(`turn did not settle within ${TURN_SETTLE_BOUND_MS} ms`)),
		TURN_SETTLE_BOUND_MS,
	);
	try {
		await Promise.race([
			(async () => {
				await session.prompt(text);
				await session.waitForIdle();
			})(),
			deadline.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

describe("a throw inside retry recovery ends the retry instead of parking the prompt", () => {
	for (const [name, boundary] of Object.entries(BOUNDARIES)) {
		it(name, async () => {
			const mock = createMockModel();
			// The first request of each prompt fails with this error; every later request succeeds.
			let nextError: string | undefined = boundary.providerError;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: (model, context, options) => {
					if (nextError) {
						mock.push({ throw: nextError });
						nextError = undefined;
					} else {
						mock.push({ content: ["ok"] });
					}
					return mock.stream(model, context, options);
				},
			});
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				...(boundary.fallbackChains ? { "retry.fallbackChains": boundary.fallbackChains } : {}),
			});
			settings.setModelRole("default", primarySelector);
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: registry,
			});
			const retryStarts: AutoRetryStartEvent[] = [];
			const retryEnds: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStarts.push(event);
				if (event.type === "auto_retry_end") retryEnds.push(event);
			});
			boundary.breakIt(session, registry);

			try {
				await settle(session, "go");

				expect(session.isRetrying).toBe(false);
				expect(retryEnds).toHaveLength(1);
				expect(retryEnds[0].success).toBe(false);
				expect(retryEnds[0].finalError).toContain(boundary.failure);

				// Once the boundary recovers, the next failure retries on a fresh budget and succeeds.
				vi.restoreAllMocks();
				nextError = "rate limit exceeded retry-after-ms=5";
				await settle(session, "again");
				expect(retryStarts.map(event => event.attempt)).toEqual([1]);
				expect(retryEnds.map(event => event.success)).toEqual([false, true]);
				const last = session.messages.at(-1);
				expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
			} finally {
				session.abortRetry();
				await session.dispose();
			}
		});
	}
});
