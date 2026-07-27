import type { ProviderDefinition } from "./types";

export const googleVertexProvider = {
	id: "google-vertex",
	name: "Google Vertex AI",
	// The env-key rule lives in `../provider-env-keys.ts`, which is the one place a provider's credential
	// probe is written and the one module `getEnvApiKey` reads. It is not here because a definition costs 121
	// modules and answering "which variable holds the key" should not.
} as const satisfies ProviderDefinition;
