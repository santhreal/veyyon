/**
 * The reported defect, end to end: `/compact` answered "Nothing to compact
 * (session too small)" to an operator whose context gauge read no room left.
 *
 * The recent-history budget compaction must preserve was a flat 20000 tokens
 * and was never measured against the model. Once the prefix (system prompt,
 * tool schemas, skills) takes enough of a modest window, the conversation's own
 * share is smaller than that budget while the window is full, so the cut-point
 * search finds nothing to cut and reports a session too small to compact.
 *
 * Contract: on a full window, `/compact` compacts. The small-session case below
 * is what keeps that about the budget rather than about deleting a refusal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

/**
 * A small declared window keeps the fixture cheap and, more importantly, makes
 * the defect's shape easy to hit: with a 32768-token window the compaction
 * threshold is 16384, well under the flat 20000-token recent budget, so the
 * whole conversation fits inside the budget while the window is full.
 */
const MODEL_PROVIDER = "azure";
const MODEL_ID = "gpt-4-32k";

/** Above the compaction threshold for that window, so the gauge reads full. */
const FULL_PROMPT_TOKENS = 30_000;

/**
 * Roughly 12k tokens of prefix. The prefix is what puts the conversation's own
 * share under the recent budget while the window as a whole is full, which is
 * the state the report came from.
 */
const PREFIX_SYSTEM_PROMPT = "instruction word ".repeat(2_800);

/**
 * Turns whose local estimate is close to what the provider charges for them,
 * which is the ordinary case. An estimate wildly under the charge scales the
 * recent budget down on its own and hides the defect, so a fixture with a
 * five-token conversation inside a full window proves nothing.
 */
const SEED_PROMPTS = Array.from({ length: 4 }, (_, i) => `turn ${i} ${"discussion of the change ".repeat(750)}`);

function assistantResponse(promptTokens: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "done" }],
		timestamp: Date.now(),
		provider: MODEL_PROVIDER,
		model: MODEL_ID,
		api: "openai-completions" as const,
		usage: {
			input: promptTokens,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens + 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
	};
}

describe("a session with a full context window is never told it is too small to compact", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compact-full-window-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/**
	 * One short exchange, so the conversation is far too small to cut, reported
	 * at `promptTokens` so the gauge says whatever the case needs. That pairing
	 * is the defect's whole shape: a tiny conversation inside a full window.
	 */
	async function sessionReporting(
		promptTokens: number,
		systemPrompt = "Test",
		seedPrompts: string[] = ["hello"],
	): Promise<AgentSession> {
		const model = getBundledModel(MODEL_PROVIDER, MODEL_ID);
		if (!model) throw new Error(`Expected ${MODEL_PROVIDER}/${MODEL_ID} model to exist`);
		// The summary itself is not under test: stub it so a compaction that does
		// find a cut completes without a network call.
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey(MODEL_PROVIDER, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			// Manual `/compact` only: an auto pass firing during the seed prompt
			// would abort the explicit one under test.
			"compaction.enabled": false,
			"compaction.strategy": "context-full",
			"todo.enabled": false,
			"todo.reminders": false,
		});

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: [systemPrompt], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: () => {
				const response = assistantResponse(promptTokens);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		});
		for (const seed of seedPrompts) await session.prompt(seed);
		// Any auto pass the seed turn scheduled must finish before the explicit
		// one, or `compact()` aborts it and reports that cancellation instead.
		await session.waitForIdle();

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return session;
	}

	/**
	 * What `/compact` did, as one comparable value: the summary succeeded, or the
	 * message it refused with.
	 */
	async function compactOutcome(session: AgentSession): Promise<string> {
		return await session.compact().then(
			() => "compacted",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	}

	it("a full window is never called too small", async () => {
		const session = await sessionReporting(FULL_PROMPT_TOKENS, PREFIX_SYSTEM_PROMPT, SEED_PROMPTS);
		expect(session.getContextUsage()?.tokens).toBeGreaterThanOrEqual(FULL_PROMPT_TOKENS);

		expect(await compactOutcome(session)).toBe("compacted");
	});

	it("still says a small session is small", async () => {
		const session = await sessionReporting(1_200);

		expect(await compactOutcome(session)).toBe("Nothing to compact (session too small)");
	});
});
