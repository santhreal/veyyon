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

export { resolveServerCompactionTransport } from "@veyyon/ai/providers/openai-compaction";
export * from "./remote-compaction-entry";

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

	const chain = preparation.remoteChain;
	const previousWindow = chainableRemoteCompactionWindow(chain?.previousPreserveData, model);
	const span = previousWindow && chain ? chain : preparation;
	const convertToLlm = options?.convertToLlm ?? defaultConvertToLlm;
	const llmMessages = convertToLlm(span.messagesToSummarize.concat(span.turnPrefixMessages));

	const instructions = [options?.remoteInstructions, customInstructions].filter(Boolean).join("\n\n");
	const remote = await withAuth(
		apiKey,
		key =>
			transport.compact({
				model,
				messages: llmMessages,
				previousWindow,
				instructions: instructions.length > 0 ? instructions : undefined,
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
	return {
		summary: "",
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: data },
	};
}
