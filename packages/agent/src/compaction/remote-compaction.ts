/** Provider server-side ("remote") compaction, engine side. */

import type { ApiKey, Model } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { createOpenAICodexCompactionRequestContext } from "@veyyon/ai/providers/openai-codex-responses";
import { resolveServerCompactionTransport } from "@veyyon/ai/providers/openai-compaction";
import type { CompactionPreparation, CompactionResult, SummaryOptions } from "./compaction";
import { defaultConvertToLlm } from "./messages";
import {
	chainableRemoteCompactionWindow,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type RemoteCompactionPreserveData,
} from "./remote-compaction-entry";
import { REMOTE_COMPACTION_TIMEOUT_MS } from "./remote-summarizer";

export type {
	ServerCompactionRequest,
	ServerCompactionResult,
	ServerCompactionTransport,
} from "@veyyon/ai/providers/openai-compaction";

// The capability surface the session layer gates on. Support is data on the
// model row; resolution lives with the provider implementations in pi-ai.
export { resolveServerCompactionTransport } from "@veyyon/ai/providers/openai-compaction";
export * from "./remote-compaction-entry";

/** Compact the prepared span on the session model's provider and return the */
export async function compactWithProvider(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const transport = resolveServerCompactionTransport(model);
	if (!transport) {
		throw new Error(
			`Server-side compaction is not available for ${model.provider}/${model.id}; the caller must gate on resolveServerCompactionTransport.`,
		);
	}

	// Chain the previous window when the branch already holds one this host can
	// read: per the guide, the latest compaction item carries the context, so the
	// new call compacts [previous window, span since it]. `prepareCompaction`
	// hands that narrower span over on `remoteChain`; it cannot come from
	// `previousPreserveData`, because a server-side entry carries no summary a
	// local pass can build on and the preparation therefore looks straight past
	// it and re-expands everything behind it. That re-expansion is right for a
	// local pass and wrong here: sending it would pay for a span the window
	// already holds and make every compaction larger than the one before it.
	//
	// All or nothing. A window from a different provider or api is an opaque
	// blob only its minting host can decrypt, so it is dropped rather than
	// chained (see chainableRemoteCompactionWindow) and the full re-expanded
	// span is sent instead, which is exactly what that span is for.
	const chain = preparation.remoteChain;
	const previousWindow = chainableRemoteCompactionWindow(chain?.previousPreserveData, model);
	const span = previousWindow && chain ? chain : preparation;
	const convertToLlm = options?.convertToLlm ?? defaultConvertToLlm;
	// In a split turn the discarded span is messagesToSummarize followed by
	// turnPrefixMessages; concatenated they are the chronological window.
	const llmMessages = convertToLlm(span.messagesToSummarize.concat(span.turnPrefixMessages));

	// The operator's compaction instructions used to reach only the local
	// summary. That summary is gone, so they must ride the provider call or
	// they would be silently dropped, which is the one thing a configured
	// instruction may never do.
	const instructions = [options?.remoteInstructions, customInstructions].filter(Boolean).join("\n\n");
	const remote = await withAuth(
		apiKey,
		key =>
			transport.compact({
				model,
				messages: llmMessages,
				previousWindow,
				instructions: instructions.length > 0 ? instructions : undefined,
				// Codex keys request identity to the live conversation; the
				// official and Azure routes ignore all three.
				sessionId: options?.sessionId,
				providerSessionState: options?.providerSessionState,
				codexCompaction: createOpenAICodexCompactionRequestContext({
					context: options?.codexCompaction,
					implementation: "responses_compact",
				}),
				apiKey: key,
				signal,
				fetch: options?.fetch,
				timeoutMs: REMOTE_COMPACTION_TIMEOUT_MS,
				sanitizeErrorText: text => options?.obfuscateProviderText?.(text) ?? text,
			}),
		{ signal, missingKeyMessage: "Server-side compaction credentials unavailable" },
	);

	const data: RemoteCompactionPreserveData = {
		version: 1,
		provider: model.provider,
		api: model.api,
		model: model.id,
		window: remote.window,
		inputTokens: remote.usage?.inputTokens,
		outputTokens: remote.usage?.outputTokens,
		compactedAt: new Date().toISOString(),
	};
	// Structural fields come from the preparation, not from an LLM: compact()
	// was never the owner of these, it only carried them through.
	return {
		summary: "",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: data },
	};
}
