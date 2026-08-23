import { getNousResearchApiKey, loginNousResearch, refreshNousResearchToken } from "./oauth/nous-research";
import type { ProviderDefinition } from "./types";

export const nousResearchProvider = {
	id: "nous-research",
	name: "Nous Research",
	login: loginNousResearch,
	refreshToken: refreshNousResearchToken,
	getApiKey: getNousResearchApiKey,
} as const satisfies ProviderDefinition;
