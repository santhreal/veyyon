/** The transcript-entry contract for provider server-side ("remote") compaction. */

import type { ProviderPayload } from "@veyyon/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";

/** `preserveData` key a server-side compaction entry carries its window under. */
export const REMOTE_COMPACTION_PRESERVE_KEY = "remoteCompaction";

/** What a remote compaction entry stores. `version` lets future readers reject */
export interface RemoteCompactionPreserveData {
	version: 1;
	/** `model.provider` of the compacting model; replay keys on it. */
	provider: string;
	/** `model.api` of the compacting model. */
	api: string;
	/** `model.id` of the compacting model, for display and diagnostics. */
	model: string;
	/** The provider's canonical compacted window, verbatim from the endpoint. */
	window: Array<Record<string, unknown>>;
	/** Token accounting of the compaction call itself, when reported. */
	inputTokens?: number;
	outputTokens?: number;
	/** ISO timestamp of the compaction. */
	compactedAt: string;
}

/** Read and validate the remote-compaction payload of a compaction entry. */
export function getRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): RemoteCompactionPreserveData | undefined {
	const candidate = preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const data = candidate as Partial<RemoteCompactionPreserveData>;
	if (data.version !== 1) return undefined;
	if (typeof data.provider !== "string" || data.provider.length === 0) return undefined;
	if (typeof data.api !== "string" || data.api.length === 0) return undefined;
	if (typeof data.model !== "string" || data.model.length === 0) return undefined;
	if (!Array.isArray(data.window) || data.window.length === 0) return undefined;
	// A window without the opaque compaction item is not a compacted window;
	// replaying it would re-send the full span while claiming it was reduced.
	if (
		!data.window.some(
			item =>
				item &&
				typeof item === "object" &&
				item.type === "compaction" &&
				typeof item.encrypted_content === "string",
		)
	) {
		return undefined;
	}
	if (typeof data.compactedAt !== "string" || data.compactedAt.length === 0) return undefined;
	return data as RemoteCompactionPreserveData;
}

/** The previously stored window a NEW server-side compaction may chain in */
export function chainableRemoteCompactionWindow(
	preserveData: Record<string, unknown> | undefined,
	model: { provider: string; api: string },
): Array<Record<string, unknown>> | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	if (!data) return undefined;
	if (data.provider !== model.provider || data.api !== model.api) return undefined;
	return data.window;
}

/** Responses-family apis whose providers replay a stored window through the native-history seam. */
const REMOTE_COMPACTION_REPLAY_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
};

/** The provider payload a rebuild attaches to the compaction summary message, */
export function remoteCompactionProviderPayload(
	preserveData: Record<string, unknown> | undefined,
): ProviderPayload | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	if (!data) return undefined;
	if (!REMOTE_COMPACTION_REPLAY_APIS[data.api]) return undefined;
	return createOpenAIResponsesHistoryPayload(data.provider, data.window);
}

/** Display attribution for a remote compaction, e.g. `openai/gpt-5.6-sol`. */
export function remoteCompactionAttribution(preserveData: Record<string, unknown> | undefined): string | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	return data ? `${data.provider}/${data.model}` : undefined;
}

/** Drop the remote key from a carried-forward preserveData, returning undefined */
export function stripRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) return preserveData;
	const { [REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}
