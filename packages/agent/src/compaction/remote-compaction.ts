/**
 * Provider server-side ("remote") compaction, engine side.
 *
 * The session layer calls {@link compactWithProvider} instead of `compact()`
 * when the remote-compaction setting is on and the SESSION model resolves a
 * transport (`resolveServerCompactionTransport`, keyed on the model's compat
 * data, not its provider name). The compaction model chain never runs for
 * such a compaction: the provider compacts server-side, so a configured local
 * compaction model does not apply to it.
 *
 * One provider call is not the whole job, though. The provider's window is
 * opaque and provider-bound, so this function ALWAYS pairs it with the
 * ordinary local summary of the same span, generated on the session model by
 * `compact()` itself. The entry therefore dual-writes: real readable summary
 * text (what local rebuild, fork, cross-provider resume, the display
 * transcript, and the next compaction's `previousSummary` all read) plus the
 * provider window under `preserveData` (what a Responses-family provider
 * replays natively on the next turn). The full contract lives in
 * `remote-compaction-entry.ts`; the failure mode this avoids is the removed
 * provider-native path's placeholder summary, which discarded real turns on
 * every rebuild.
 */

import type { ApiKey, Model } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { resolveServerCompactionTransport } from "@veyyon/ai/providers/openai-compaction";
import { compact, type CompactionPreparation, type CompactionResult, type SummaryOptions } from "./compaction";
import { defaultConvertToLlm } from "./messages";
import {
	chainableRemoteCompactionWindow,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type RemoteCompactionPreserveData,
} from "./remote-compaction-entry";
import { REMOTE_COMPACTION_TIMEOUT_MS } from "./remote-summarizer";

export * from "./remote-compaction-entry";

// The capability surface the session layer gates on. Support is data on the
// model row; resolution lives with the provider implementations in pi-ai.
export { resolveServerCompactionTransport } from "@veyyon/ai/providers/openai-compaction";
export type {
	ServerCompactionRequest,
	ServerCompactionResult,
	ServerCompactionTransport,
} from "@veyyon/ai/providers/openai-compaction";

/**
 * Compact the prepared span on the session model's provider AND locally,
 * returning the dual-written result.
 *
 * Throws when the model resolves no transport (callers gate on
 * `resolveServerCompactionTransport` first) and propagates any transport or
 * summarization failure unchanged: the session layer catches, warns once, and
 * falls back to the ordinary local compaction path, so a failed remote pass
 * never leaves the session uncompacted.
 */
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

	// Chain the previous window when the last compaction on this branch was
	// also remote AND ran on this same host: per the guide, the latest
	// compaction item carries the context, so the new call compacts
	// [previous window, new span]. A window from a different provider or api
	// is dropped rather than chained — it is an opaque blob only its minting
	// host can decrypt, so sending it would buy a rejected request instead of
	// a compaction (see chainableRemoteCompactionWindow).
	const previousWindow = chainableRemoteCompactionWindow(preparation.previousPreserveData, model);
	const convertToLlm = options?.convertToLlm ?? defaultConvertToLlm;
	// In a split turn the discarded span is messagesToSummarize followed by
	// turnPrefixMessages; concatenated they are the chronological window.
	const llmMessages = convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]);

	const [remote, local] = await Promise.all([
		withAuth(
			apiKey,
			key =>
				transport.compact({
					model,
					messages: llmMessages,
					previousWindow,
					instructions: options?.remoteInstructions,
					apiKey: key,
					signal,
					fetch: options?.fetch,
					timeoutMs: REMOTE_COMPACTION_TIMEOUT_MS,
					sanitizeErrorText: text => options?.obfuscateProviderText?.(text) ?? text,
				}),
			{ signal, missingKeyMessage: "Server-side compaction credentials unavailable" },
		),
		// The readable half, on the session model. compact() owns the summary
		// prompts, the split-turn merge, file-op upserts, and the carry-forward
		// strip of any previous remote window.
		compact(preparation, model, apiKey, customInstructions, signal, options),
	]);

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
	return {
		...local,
		preserveData: { ...local.preserveData, [REMOTE_COMPACTION_PRESERVE_KEY]: data },
	};
}
