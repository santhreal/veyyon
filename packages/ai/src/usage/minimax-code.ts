import type { UsageFetchContext, UsageFetchParams, UsageProvider, UsageReport } from "../usage";

async function fetchMiniMaxCodeUsage(params: UsageFetchParams, _ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== "minimax-code" && params.provider !== "minimax-code-cn") {
		return null;
	}

	return null;
}

export const minimaxCodeUsageProvider: UsageProvider = {
	id: "minimax-code",
	fetchUsage: fetchMiniMaxCodeUsage,
	supports: (params: UsageFetchParams) =>
		(params.provider === "minimax-code" || params.provider === "minimax-code-cn") &&
		params.credential.type === "api_key",
};
