import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage } from "@veyyon/utils";
import type { Api, Model } from "../types";

export function createProviderErrorMessage(model: Model<Api>, err: unknown) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: errorMessage(err) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error" as const,
		timestamp: Date.now(),
	};
}
