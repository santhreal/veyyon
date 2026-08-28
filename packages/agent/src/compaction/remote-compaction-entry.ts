import type { ProviderPayload } from "@veyyon/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";

export const REMOTE_COMPACTION_PRESERVE_KEY = "remoteCompaction";

export interface RemoteCompactionPreserveData {
	version: 1;
	provider: string;
	api: string;
	model: string;
	window: Array<Record<string, unknown>>;
	inputTokens?: number;
	outputTokens?: number;
	compactedAt: string;
}

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

export function chainableRemoteCompactionWindow(
	preserveData: Record<string, unknown> | undefined,
	model: { provider: string; api: string },
): Array<Record<string, unknown>> | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	if (!data) return undefined;
	if (data.provider !== model.provider || data.api !== model.api) return undefined;
	return data.window;
}

const REMOTE_COMPACTION_REPLAY_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
};

export function remoteCompactionProviderPayload(
	preserveData: Record<string, unknown> | undefined,
): ProviderPayload | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	if (!data) return undefined;
	if (!REMOTE_COMPACTION_REPLAY_APIS[data.api]) return undefined;
	return createOpenAIResponsesHistoryPayload(data.provider, data.window);
}

export function remoteCompactionAttribution(preserveData: Record<string, unknown> | undefined): string | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	return data ? `${data.provider}/${data.model}` : undefined;
}

export function stripRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) return preserveData;
	const { [REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}
