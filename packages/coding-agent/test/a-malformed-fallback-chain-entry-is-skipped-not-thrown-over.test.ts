/**
 * WHY: `retry.fallbackChains` is user-written config, and a chain entry that is not a string
 * (`[123, "openai/gpt-4o-mini"]`) reached the selector parser, which called `.endsWith` on it.
 * The TypeError escaped the retry path after it had opened the retry gate `prompt()` waits on,
 * so a typo in config turned one rate limit into a prompt that never settled.
 *
 * Class closed: every non-string JSON value (number, boolean, null, object, array) as a chain
 * entry, under every chain key kind (role, exact model, `provider/*` wildcard), plus a chain
 * that is not an array and a value that is not a mapping. In each case the turn settles within
 * a stated bound, the well-formed entries still apply, and the configured shape is reported as a
 * warning.
 *
 * Gap: this drives the session's retry path only. The model hub reads the same sanitizer and is
 * covered by its own suite; a new reader of the raw setting that bypasses
 * `sanitizeRetryFallbackChains` is not caught here, and neither is a throw from a retry step
 * other than chain resolution.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

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
 * Upper bound on one failing-then-recovering turn. The recovery sleeps 5 ms and every request is
 * a mock, so a settled turn takes tens of milliseconds; a turn still open at the bound is parked.
 */
const TURN_SETTLE_BOUND_MS = 2_000;

/** Every JSON value kind other than a string: what a hand-edited config can put in a chain. */
const NON_STRING_ENTRIES: Record<string, unknown> = {
	number: 123,
	boolean: true,
	null: null,
	object: { model: fallbackSelector },
	array: [fallbackSelector],
};

/** Every chain key kind that resolves to the failing primary model. */
const CHAIN_KEYS: Record<string, { key: string; kind: "role" | "model" }> = {
	role: { key: "default", kind: "role" },
	model: { key: primarySelector, kind: "model" },
	wildcard: { key: `${primary.provider}/*`, kind: "model" },
};

interface TurnOutcome {
	requested: string[];
	thrown: unknown;
	warnings: string[];
	stopReason: string | undefined;
}

let tempDir: TempDir;
let authStorage: AuthStorage;
let registry: ModelRegistry;

beforeAll(async () => {
	tempDir = TempDir.createSync("@malformed-chain-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	authStorage.setRuntimeApiKey("openai", "openai-test-key");
	registry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

/** One prompt whose first request to the primary fails with a rate limit; every later request succeeds. */
async function runFailingTurn(fallbackChains: unknown): Promise<TurnOutcome> {
	const requested: string[] = [];
	const mock = createMockModel();
	let failed = false;
	const agent = new Agent({
		getApiKey: model => `${model.provider}-test-key`,
		initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (model, context, options) => {
			requested.push(`${model.provider}/${model.id}`);
			if (!failed && model.id === primary.id) {
				failed = true;
				mock.push({ throw: "rate limit exceeded retry-after-ms=5" });
			} else {
				mock.push({ content: ["ok"] });
			}
			return mock.stream(model, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 5,
		"retry.fallbackChains": fallbackChains,
	});
	settings.setModelRole("default", primarySelector);
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: registry,
	});
	let thrown: unknown;
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error(`turn did not settle within ${TURN_SETTLE_BOUND_MS} ms`)),
		TURN_SETTLE_BOUND_MS,
	);
	try {
		await Promise.race([
			(async () => {
				await session.prompt("go");
				await session.waitForIdle();
			})(),
			deadline.promise,
		]);
	} catch (error) {
		thrown = error;
	} finally {
		clearTimeout(timer);
	}
	if (thrown) session.abortRetry();
	const last = session.messages.at(-1);
	const outcome: TurnOutcome = {
		requested,
		thrown,
		warnings: [...session.configWarnings],
		stopReason: last?.role === "assistant" ? last.stopReason : undefined,
	};
	await session.dispose();
	return outcome;
}

describe("a non-string fallback chain entry is skipped and the next entry is tried", () => {
	for (const [keyName, { key, kind }] of Object.entries(CHAIN_KEYS)) {
		for (const [entryName, entry] of Object.entries(NON_STRING_ENTRIES)) {
			it(`${entryName} entry in a ${keyName}-keyed chain`, async () => {
				const outcome = await runFailingTurn({ [key]: [entry, fallbackSelector] });

				expect(outcome.thrown).toBeUndefined();
				expect(outcome.requested).toEqual([primarySelector, fallbackSelector]);
				expect(outcome.stopReason).toBe("stop");
				expect(outcome.warnings).toEqual([`Fallback chain for ${kind} '${key}' contains a non-string selector.`]);
			});
		}
	}
});

describe("a chain or chains value of the wrong shape is reported and ignored", () => {
	it("a chain that is not an array", async () => {
		const outcome = await runFailingTurn({ default: fallbackSelector });

		expect(outcome.thrown).toBeUndefined();
		// No usable chain, so the failed primary is retried in place.
		expect(outcome.requested).toEqual([primarySelector, primarySelector]);
		expect(outcome.stopReason).toBe("stop");
		expect(outcome.warnings).toEqual(["Fallback chain for role 'default' must be an array of selector strings."]);
	});

	for (const [name, value] of Object.entries({ array: [fallbackSelector], string: fallbackSelector, number: 1 })) {
		it(`a chains value that is a ${name}, not a mapping`, async () => {
			const outcome = await runFailingTurn(value);

			expect(outcome.thrown).toBeUndefined();
			expect(outcome.requested).toEqual([primarySelector, primarySelector]);
			expect(outcome.stopReason).toBe("stop");
			expect(outcome.warnings).toEqual([
				"retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.",
			]);
		});
	}
});
