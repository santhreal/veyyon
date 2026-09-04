import { getNousResearchApiKey, loginNousResearch, refreshNousResearchToken } from "./oauth/nous-research";
import type { ProviderDefinition } from "./types";

export const nousResearchProvider = {
	id: "nous-research",
	name: "Nous Research",
	login: loginNousResearch,
	credential: "oauth",
	refreshToken: refreshNousResearchToken,
	getApiKey: getNousResearchApiKey,
} as const satisfies ProviderDefinition;
