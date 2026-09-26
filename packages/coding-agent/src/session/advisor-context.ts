/**
 * Advisor context maintenance: what runs when an advisor's next update would overflow its model.
 *
 * An advisor's transcript lives only in memory, with no session entries behind it. When the
 * incoming update plus the transcript trips the compaction threshold, the advisor first moves to a
 * larger model through context promotion, then summarizes its own transcript with an LLM summary,
 * whatever compaction strategy the primary session is configured with. A `true` result asks the
 * caller to re-prime the advisor instead.
 */

import {
	type Agent,
	type AgentMessage,
	type CompactionSummaryMessage,
	resolveTelemetry,
	ThinkingLevel,
} from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	createCompactionSummaryMessage,
	estimateTokens,
	prepareCompaction,
	renderTailElisionArtifact,
	renderTailElisionMarker,
	type SessionMessageEntry,
	shouldCompact,
} from "@veyyon/agent-core/compaction";
import type { Message, Model, ProviderSessionState } from "@veyyon/ai";
import { createCodexCompactionContext } from "@veyyon/kernel/session/agent-session-compaction-policy";
import type { CompactionEntry, SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, logger } from "@veyyon/utils";
import { isCompactionStrategyOff, toAgentCompactionSettings } from "../config/compaction-strategy";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import { compactionModelCandidates } from "./agent-session-model-targets";

/** What advisor context maintenance reads from the session it runs in. */
export interface AdvisorContextEnv {
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	/** The session's provider session map, shared so the advisor's summary reuses its transports. */
	readonly providerSessionState: Map<string, ProviderSessionState>;
	/** The session's side-request completion, carrying its watchdogs and in-flight cap. */
	readonly sideComplete: SideCompleteImpl;
	/** The primary loop's pinned provider cache key, which advisor turns route on when set. */
	primaryPromptCacheKey(): string | undefined;
	/** The model context promotion moves to from `model`, or `undefined` when none is configured. */
	resolveContextPromotionTarget(model: Model, contextWindow: number): Promise<Model | undefined>;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	/** Non-message tokens and declared context window of the primary session. */
	primaryContextBudget(): { nonMessageTokens: number; contextWindow: number | undefined };
	/** Save `content` as a session artifact; its id, or `undefined` when the session keeps none. */
	saveArtifact(content: string, toolType: string): Promise<string | undefined>;
}

/** The advisor a maintenance pass runs against. */
export interface MaintainedAdvisor {
	readonly name: string;
	readonly agent: Agent;
	/** The advisor's configured thinking level, kept across a promotion. */
	readonly thinkingLevel: ThinkingLevel;
}

async function promoteAdvisorContextModel(
	advisor: MaintainedAdvisor,
	currentModel: Model,
	env: AdvisorContextEnv,
): Promise<boolean> {
	const promotionSettings = env.settings.getGroup("contextPromotion");
	if (!promotionSettings.enabled) return false;
	const contextWindow = currentModel.contextWindow ?? 0;
	if (contextWindow <= 0) return false;
	const targetModel = await env.resolveContextPromotionTarget(currentModel, contextWindow);
	if (!targetModel) return false;

	// Preserve this advisor's own thinking level (a configured `model:...:high`
	// keeps its suffix across a promotion); only the model changes.
	const advisorThinkingLevel = advisor.thinkingLevel;
	try {
		advisor.agent.setModel(targetModel);
		advisor.agent.setThinkingLevel(toReasoningEffort(advisorThinkingLevel));
		advisor.agent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
		advisor.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Advisor context promotion switched model on overflow", {
			advisor: advisor.name,
			from: `${currentModel.provider}/${currentModel.id}`,
			to: `${targetModel.provider}/${targetModel.id}`,
		});
		return true;
	} catch (error) {
		logger.warn("Advisor context promotion failed", {
			advisor: advisor.name,
			from: `${currentModel.provider}/${currentModel.id}`,
			to: `${targetModel.provider}/${targetModel.id}`,
			error: errorMessage(error),
		});
		return false;
	}
}

/**
 * Keep `advisor`'s transcript within its model before an update of `incomingTokens` is sent.
 * `providerSessionId` resolves the advisor's provider session identity, which its summary request
 * uses; it is read only when a summary is attempted.
 *
 * @returns true when the caller must re-prime the advisor because no summary could be made.
 */
export async function maintainAdvisorContext(
	advisor: MaintainedAdvisor,
	providerSessionId: () => string | undefined,
	incomingTokens: number,
	env: AdvisorContextEnv,
): Promise<boolean> {
	const agent = advisor.agent;

	const compactionSettings = env.settings.getGroup("compaction");
	if (isCompactionStrategyOff(compactionSettings.strategy as string)) return false;
	if (!compactionSettings.enabled) return false;

	const advisorModel = agent.state.model;
	const contextWindow = advisorModel.contextWindow ?? 0;
	if (contextWindow <= 0) return false;

	const messages = agent.state.messages;
	let contextTokens = incomingTokens;
	for (const message of messages) {
		contextTokens += estimateTokens(message);
	}

	if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
		return false;
	}

	// 1. Try promotion first
	if (await promoteAdvisorContextModel(advisor, advisorModel, env)) {
		// Promotion succeeded, check if new model has enough space
		const newModel = agent.state.model;
		const newWindow = newModel.contextWindow ?? 0;
		if (newWindow > 0) {
			const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
			if (!stillNeedsCompaction) return false;
		}
	}

	// 2. Run compaction on advisor messages
	const pathEntries: SessionEntry[] = messages.map((message, i) => {
		const id = `msg-${i}`;
		const parentId = i > 0 ? `msg-${i - 1}` : null;
		const timestamp = String(message.timestamp || Date.now());

		if (message.role === "compactionSummary") {
			return {
				type: "compaction",
				id,
				parentId,
				timestamp,
				summary: message.summary,
				shortSummary: message.shortSummary,
				firstKeptEntryId:
					(message as CompactionSummaryMessage & { firstKeptEntryId?: string }).firstKeptEntryId || `msg-${i + 1}`,
				tokensBefore: message.tokensBefore,
			} satisfies CompactionEntry;
		}

		return {
			type: "message",
			id,
			parentId,
			timestamp,
			message,
		} satisfies SessionMessageEntry;
	});

	const availableModels = env.modelRegistry.getAvailable();
	const candidates = compactionModelCandidates(env.settings, advisorModel, availableModels);
	if (candidates.length === 0) {
		// No compaction candidates, fallback to re-prime
		return true;
	}
	const sessionId = providerSessionId();
	const preparation = prepareCompaction(
		pathEntries,
		toAgentCompactionSettings(compactionSettings),
		env.primaryContextBudget(),
	);
	if (!preparation) {
		// Cannot prepare compaction, fallback to re-prime
		return true;
	}

	const advisorCompactionThinkingLevel: ThinkingLevel | undefined = agent.state.disableReasoning
		? ThinkingLevel.Off
		: agent.state.thinkingLevel;

	let compactResult: CompactionResult | undefined;
	let lastError: unknown;
	// Instrument the advisor's overflow-compaction one-shot like the primary
	// compaction path so the advisor model's maintenance call also emits spans.
	const telemetry = resolveTelemetry(agent.telemetry, sessionId);

	const codexCompaction = createCodexCompactionContext({
		trigger: "auto",
		reason: "context_limit",
		phase: "pre_turn",
	});

	for (const candidate of candidates) {
		const apiKey = await env.modelRegistry.getApiKey(candidate, sessionId);
		if (!apiKey) continue;

		try {
			compactResult = await compact(
				preparation,
				candidate,
				env.modelRegistry.resolver(candidate, sessionId),
				undefined,
				undefined,
				{
					thinkingLevel: advisorCompactionThinkingLevel,
					convertToLlm: messages => env.convertToLlmForSideRequest(messages),
					telemetry,
					tools: agent.state.tools,
					sessionId,
					// The advisor's live turns route on the primary's pinned cache key when
					// there is one, else on the advisor's provider session id. Use the same
					// expression so its overflow summary reads the prefix those turns cached.
					promptCacheKey: env.primaryPromptCacheKey() ?? sessionId,
					providerSessionState: env.providerSessionState,
					codexCompaction,
					completeImpl: env.sideComplete,
					// The advisor resolves its own tier (tier.advisor, which may
					// inherit the session's), so its overflow summary asks the
					// advisor agent rather than the primary session.
					serviceTier: agent.serviceTierResolver?.(candidate),
				},
			);
			break;
		} catch (error) {
			lastError = error;
		}
	}

	if (!compactResult) {
		logger.warn("Advisor compaction failed, falling back to re-prime", { error: errorMessage(lastError) });
		return true;
	}

	const summaryMessage = {
		...createCompactionSummaryMessage(
			compactResult.summary,
			compactResult.tokensBefore,
			new Date().toISOString(),
			compactResult.shortSummary,
		),
		firstKeptEntryId: compactResult.firstKeptEntryId,
	} as CompactionSummaryMessage & { firstKeptEntryId?: string };

	// Tail elisions ride the preparation as pointerless markers; close them
	// out (recovery pointer, or undo) before they enter advisor memory.
	const recentMessages = await resolveAdvisorTailElisions(preparation, env);
	agent.replaceMessages([summaryMessage, ...recentMessages]);
	return false;
}

/**
 * Close out a successful advisor compaction's tail elisions before they
 * enter advisor memory. `prepareCompaction` swaps over-budget tool results
 * in the kept tail for pointerless markers as a side effect, and the
 * advisor's retained tail comes from `preparation.recentMessages`, so
 * feeding it unchanged would strand the original bytes behind a marker
 * that names no recovery: advisor memory is in-memory and nothing else
 * retains the pre-elision copy. The advisor's read tool resolves
 * `artifact://` against THIS session's artifacts dir, so the offload lands
 * on the same store the primary compaction paths use and the pointer
 * stays live for later advisor turns. A failed offload puts the original
 * message back instead — the next maintenance pass re-elides if the tail
 * is still heavy, which beats a dead marker no turn can ever resolve.
 * The replacement is always a NEW message object, never an in-place
 * patch: `estimateTokens` caches by message identity, and the pointerless
 * marker's estimate may already be primed from mid-pass reads.
 */
async function resolveAdvisorTailElisions(
	preparation: CompactionPreparation,
	env: AdvisorContextEnv,
): Promise<AgentMessage[]> {
	const elisions = preparation.tailElisions ?? [];
	if (elisions.length === 0) return preparation.recentMessages;
	let artifactId: string | undefined;
	try {
		artifactId = await env.saveArtifact(renderTailElisionArtifact(elisions), "compaction-tail");
	} catch (error) {
		logger.warn("Failed to persist compaction tail elision artifact", {
			error: errorMessage(error),
			elisionCount: elisions.length,
		});
		artifactId = undefined;
	}
	const resolved = new Map<AgentMessage, AgentMessage>();
	for (const elision of elisions) {
		resolved.set(
			elision.message,
			artifactId
				? {
						...elision.message,
						content: [
							{ type: "text", text: renderTailElisionMarker(elision.toolName, elision.tokens, artifactId) },
						],
					}
				: elision.originalMessage,
		);
	}
	return preparation.recentMessages.map(message => resolved.get(message) ?? message);
}
