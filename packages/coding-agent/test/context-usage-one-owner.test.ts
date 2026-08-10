/**
 * Contract: the context total the operator SEES is the total that decides compaction.
 *
 * WHY THIS SUITE EXISTS. `getContextBreakdown` reported the provider-anchored prompt
 * tokens, while every compaction decision floors that number by a local estimate of
 * what the session actually holds (`compactionContextTokens`, called from the
 * pre-prompt check, the post-turn threshold check, the residual-fit checks and the
 * recovery band). A provider that reports a prompt smaller than the stored
 * conversation therefore produced a footline reading "90% left" while auto-compaction
 * fired on every turn, because the number on the screen and the number in the
 * predicate were different numbers. An operator cannot debug that: nothing visible
 * disagrees with anything else visible.
 *
 * The floor is a FLOOR, so the second test pins the other direction: a provider that
 * reports more than the local estimate still owns the total, and the estimate cannot
 * talk the gauge down.
 *
 * What this does NOT cover: whether the local estimate is accurate for a given
 * provider's billing (it is a heuristic and only ever raises the number), the collab
 * guest path (its usage arrives in the host's state frames instead of being computed),
 * and the `/context` panel's category split, which has its own producer.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { resolveThresholdTokens, shouldCompact } from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { computeNonMessageTokens, computeStoredMessagesTokens } from "@veyyon/coding-agent/session/context-usage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { assistantMsg, userMsg } from "./helpers/e2e-session";

/** The tokens a provider claims it billed for the prompt, as one assistant anchor. */
function anchorWithPromptTokens(text: string, promptTokens: number) {
	const base = assistantMsg(text);
	return {
		...base,
		usage: {
			input: promptTokens,
			output: 8,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens + 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("the context total has one owner", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	const model = getBundledModel("openai-codex", "gpt-5.4-mini");
	if (!model) throw new Error("Expected the bundled test model to exist");

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-context-total-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir.removeSync();
	});

	/** Append to both the runtime state and the branch, the way a real turn does. */
	function appendTurn(user: ReturnType<typeof userMsg>, assistant: ReturnType<typeof anchorWithPromptTokens>) {
		session.agent.appendMessage(user);
		session.sessionManager.appendMessage(user);
		session.agent.appendMessage(assistant);
		session.sessionManager.appendMessage(assistant);
	}

	it("reports the total that trips compaction, not the smaller total the provider claimed", () => {
		const PROVIDER_PROMPT_TOKENS = 1_000;
		appendTurn(
			userMsg("the quick brown fox jumps over the lazy dog. ".repeat(1_200)),
			anchorWithPromptTokens("acknowledged", PROVIDER_PROMPT_TOKENS),
		);

		const storedEstimate =
			computeNonMessageTokens(session) + computeStoredMessagesTokens(session, { excludeEncryptedReasoning: true });
		// A window sized so the stored conversation is over the trigger and the
		// provider's own number is comfortably under it. Without this the test could
		// pass with both numbers on the same side of the threshold, which is the
		// green-by-luck shape: it would never have caught the defect.
		const contextWindow = Math.floor(storedEstimate * 1.1);
		const compactionSettings = session.settings.getGroup("compaction");
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		expect(PROVIDER_PROMPT_TOKENS).toBeLessThan(thresholdTokens);
		expect(storedEstimate).toBeGreaterThan(thresholdTokens);

		const breakdown = session.getContextBreakdown({ contextWindow });

		expect(breakdown?.usedTokens).toBe(storedEstimate);
		// The gauge denominates against this same number, so a screen reading
		// "90% left" while compaction fires is no longer expressible.
		expect(shouldCompact(breakdown?.usedTokens ?? 0, contextWindow, compactionSettings)).toBe(true);
		expect(shouldCompact(PROVIDER_PROMPT_TOKENS, contextWindow, compactionSettings)).toBe(false);
		expect(session.getContextUsage({ contextWindow })?.tokens).toBe(storedEstimate);
	});

	it("keeps the provider's total when it is larger, because the estimate is only a floor", () => {
		const PROVIDER_PROMPT_TOKENS = 90_000;
		appendTurn(userMsg("short question"), anchorWithPromptTokens("short answer", PROVIDER_PROMPT_TOKENS));

		const storedEstimate =
			computeNonMessageTokens(session) + computeStoredMessagesTokens(session, { excludeEncryptedReasoning: true });
		expect(storedEstimate).toBeLessThan(PROVIDER_PROMPT_TOKENS);

		const breakdown = session.getContextBreakdown({ contextWindow: 200_000 });

		expect(breakdown?.usedTokens).toBe(PROVIDER_PROMPT_TOKENS);
	});
});
