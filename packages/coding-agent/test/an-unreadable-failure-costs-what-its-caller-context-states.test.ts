/**
 * WHY: what an unreadable failure costs had two owners. `calculateRateLimitBackoffMs` answered
 * `UNKNOWN` with the thirty-minute quota park, and the retry-fallback cooldown in `AgentSession`
 * overrode that answer with a literal five minutes in a ternary at its call site. Either value could
 * move without the other, and nothing stated which caller wanted which.
 *
 * The class closed here is a caller that prices an unreadable failure itself instead of passing its
 * context to the one function that prices it. One unreadable usage-limit failure is driven through a
 * real `AgentSession`, real `AuthStorage` and real `ModelRegistry`, which reaches both call sites in
 * the same turn: the credential park (the wait the session schedules before the retry) and the
 * selector suppression (the window the model registry skips the failing selector for). Each bound
 * is asserted from the observable state it produces, so a call site that stops passing its context,
 * or passes the other one, turns this red.
 *
 * Not caught: a third call site that prices an unreadable failure with its own constant. The unit
 * suite in `packages/ai/test/rate-limit-utils.test.ts` pins the cost of every declared context by
 * exact equality; a caller that bypasses the function is outside both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { parseRateLimitReason } from "@veyyon/ai/error/rate-limit";
import { createMockModel } from "@veyyon/ai/providers/mock";
import * as aiStream from "@veyyon/ai/stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

const MINUTE_MS = 60_000;
/** A usage-limit failure the rate-limit reason rules cannot read: flagged a wall, priced as `UNKNOWN`. */
const UNREADABLE_USAGE_LIMIT = "429 usage_limit_reached";

describe("an unreadable failure costs what its caller context states", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-unreadable-failure-cost-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		// A stored credential, not a runtime key: the park is recorded against a stored row.
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		await authStorage.set("anthropic", [{ type: "api_key", key: "anthropic-key-1" }]);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	it("parks the credential for the quota window and suppresses the selector for five minutes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		// The premise: the failure is one the reason rules cannot read.
		expect(parseRateLimitReason(UNREADABLE_USAGE_LIMIT)).toBe("UNKNOWN");

		const mock = createMockModel();
		let attempts = 0;
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, agent.sessionId),
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => {
				attempts += 1;
				mock.push(attempts === 1 ? { throw: UNREADABLE_USAGE_LIMIT } : { content: ["recovered"] });
				return mock.stream(requested, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			// Above the thirty-minute park, so the scheduled wait is observable instead of failing fast.
			"retry.maxDelayMs": 120 * MINUTE_MS,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStarts: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
		});

		const startedAt = Date.now();
		await session.prompt("Trigger an unreadable usage limit");
		await session.waitForIdle();
		const finishedAt = Date.now();

		// Credential park: the session waits out the parked credential's window before retrying.
		expect(retryStarts.map(event => event.delayMs)).toEqual([30 * MINUTE_MS]);

		// Selector suppression: the failing selector is skipped for five minutes, not the park window.
		const selector = `${model.provider}/${model.id}`;
		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValue(startedAt + 5 * MINUTE_MS - 1);
		expect(modelRegistry.isSelectorSuppressed(selector)).toBe(true);
		clock.mockReturnValue(finishedAt + 5 * MINUTE_MS);
		expect(modelRegistry.isSelectorSuppressed(selector)).toBe(false);
	});
});
