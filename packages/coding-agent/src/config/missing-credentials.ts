/** The one message every "this provider has no credentials" failure uses. `goals/guided-setup.ts` and the slash-command registry threw the same */
import { getEnvApiKeyName } from "@veyyon/ai/env-api-key";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { ModelsConfigFile } from "./models-config";

/** Bound on the composed message. Every part is a provider id, a model id, an env-var name or a path, and none of those is attacker-controlled at length in */
const MAX_MESSAGE_LENGTH = 600;

/** Bound on an interpolated identifier, so one absurd model id cannot crowd out the remedy. */
const MAX_IDENTIFIER_LENGTH = 120;

function boundIdentifier(value: string): string {
	return value.length <= MAX_IDENTIFIER_LENGTH ? value : `${value.slice(0, MAX_IDENTIFIER_LENGTH)}…`;
}

/** Every environment variable that would satisfy `provider`, most-preferred first. */
function envVarNames(provider: string): readonly string[] {
	// The cast mirrors `@veyyon/ai/env-api-key`: `CATALOG_PROVIDERS` is a `readonly` tuple of per-provider literal shapes, so `envVars` is absent from the union
	const catalogEntry = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).find(entry => entry.id === provider);
	if (catalogEntry?.envVars && catalogEntry.envVars.length > 0) return catalogEntry.envVars;
	const single = getEnvApiKeyName(provider);
	return single ? [single] : [];
}

/** The remedy clauses for `provider`, in the order an operator should try them: the environment variable first (no state, no flow), then the sign-in command, */
function remedies(provider: string): string[] {
	const clauses: string[] = [];
	const envVars = envVarNames(provider);
	if (envVars.length > 0) clauses.push(`set ${envVars.join(" or ")} in the environment`);
	if (getOAuthProviders().some(entry => entry.id === provider)) {
		clauses.push(
			`run \`veyyon auth-broker login ${provider}\` to sign in (\`/login ${provider}\` in an interactive veyyon session)`,
		);
	}
	clauses.push(`set providers.${provider}.apiKey in ${ModelsConfigFile.path()}`);
	return clauses;
}

/** Join remedy clauses so the last one reads as an alternative. A bare `join(", ")` reads as a checklist of steps to perform in sequence, which is the */
function joinRemedies(clauses: readonly string[]): string {
	if (clauses.length === 1) return clauses[0];
	return `${clauses.slice(0, -1).join(", ")}, or ${clauses[clauses.length - 1]}`;
}

/** The remedy sentence alone, for a caller that already stated WHAT failed in its own words (`veyyon token` prints `No active credential found for provider */
export function credentialRemedySentence(provider: string): string {
	return `Fix: ${joinRemedies(remedies(provider))}.`;
}

/** The message for a provider with no usable credentials. @param provider Provider id, e.g. `anthropic`. @param modelId Model id when the failure was for one specific model. Omitted when the whole provider is the subject, which is what the two */
export function missingCredentialsMessage(provider: string, modelId?: string, what?: string): string {
	const target = modelId ? `${boundIdentifier(provider)}/${boundIdentifier(modelId)}` : boundIdentifier(provider);
	const subject = what ? `No API key for ${boundIdentifier(what)} (${target})` : `No API key for ${target}`;
	const message = `${subject}. Fix: ${joinRemedies(remedies(provider))}.`;
	return message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
