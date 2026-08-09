/**
 * The one message every "this provider has no credentials" failure uses.
 *
 * WHY THIS EXISTS. Nine sites across `main.ts`, `session/agent-session.ts`,
 * `goals/guided-setup.ts` and the slash-command registry threw the same
 * sentence: `No API key for anthropic/claude-opus-4-8`. That names WHAT failed
 * and WHERE, and it names no remedy at all, so the operator's next move is a
 * search rather than a fix. It is also the single most frequent hard stop a new
 * install hits: a provider without a key cannot start a turn, switch a model,
 * run a handoff, or arm a prewalk.
 *
 * WHY THE REMEDY IS COMPUTED AND NOT WRITTEN DOWN. Which environment variable
 * satisfies a provider is a per-provider fact the catalog already holds
 * (`getEnvApiKeyName`), and which providers can be signed into is
 * `getOAuthProviders()`. A hardcoded "set PROVIDER_API_KEY" sentence would be
 * wrong for `github-copilot` (`COPILOT_GITHUB_TOKEN`), silent for Bedrock and
 * Vertex (whose credentials are a chain, not a variable), and would drift the
 * first time a provider is added. Reading the tables means the message cannot
 * name a variable that does not exist.
 *
 * WHY IT NAMES `veyyon auth-broker login` AND NOT `/login`. `/login` is
 * TUI-only: it opens the account manager card via `showLogin`, which an ACP client, `-p`, `veyyon
 * commit` and a subagent's tool result cannot reach. Six of the nine throw
 * sites are reachable headlessly, and a message that names a remedy its reader
 * cannot perform costs more than one that names none. `veyyon auth-broker
 * login <provider>` drives the same OAuth flow over readline and persists into
 * the same store, so it works in every channel including the TUI. `/login` is
 * mentioned only as the interactive shortcut, and it uses the exact phrase
 * `in an interactive veyyon session`, which is the qualifier
 * `test/slash-commands/client-surface-parity.test.ts` recognizes: that gate
 * fails any slash-command output naming a TUI-only command without saying which
 * surface it lives on, and the slash-command registry calls this function.
 */
import { getEnvApiKeyName } from "@veyyon/ai/env-api-key";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { ModelsConfigFile } from "./models-config";

/**
 * Bound on the composed message. Every part is a provider id, a model id, an
 * env-var name or a path, and none of those is attacker-controlled at length in
 * practice; the cap exists because per-part bounds do not compose into a
 * whole-message bound, and this string lands in a transcript and a tool result.
 */
const MAX_MESSAGE_LENGTH = 600;

/** Bound on an interpolated identifier, so one absurd model id cannot crowd out the remedy. */
const MAX_IDENTIFIER_LENGTH = 120;

function boundIdentifier(value: string): string {
	return value.length <= MAX_IDENTIFIER_LENGTH ? value : `${value.slice(0, MAX_IDENTIFIER_LENGTH)}…`;
}

/**
 * Every environment variable that would satisfy `provider`, most-preferred
 * first.
 *
 * `getEnvApiKeyName` alone is not enough and the gap hits the most common
 * provider there is: it returns a name only when the provider maps to ONE
 * static variable, and `anthropic` maps to a resolver (`$pickenv` over the
 * Foundry, OAuth and plain variables), so it returned undefined and the message
 * for the single most frequently configured provider named no variable at all.
 * The catalog's `envVars` is the list those resolvers pick from, so it answers
 * for the computed cases too. Providers whose credentials are a CHAIN rather
 * than a variable (Bedrock, Vertex ADC) have no entry in either, and get no env
 * clause rather than a fabricated one.
 */
function envVarNames(provider: string): readonly string[] {
	// The cast mirrors `@veyyon/ai/env-api-key`: `CATALOG_PROVIDERS` is a `readonly`
	// tuple of per-provider literal shapes, so `envVars` is absent from the union
	// members that do not declare it and the property read does not type without
	// widening to the declared entry interface.
	const catalogEntry = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).find(entry => entry.id === provider);
	if (catalogEntry?.envVars && catalogEntry.envVars.length > 0) return catalogEntry.envVars;
	const single = getEnvApiKeyName(provider);
	return single ? [single] : [];
}

/**
 * The remedy clauses for `provider`, in the order an operator should try them:
 * the environment variable first (no state, no flow), then the sign-in command,
 * then the config file that survives a shell.
 */
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

/**
 * Join remedy clauses so the last one reads as an alternative. A bare `join(",
 * ")` reads as a checklist of steps to perform in sequence, which is the
 * opposite of what these are, and prefixing every clause with `or` produced
 * `Fix: or set …` whenever only the config-file clause survived.
 */
function joinRemedies(clauses: readonly string[]): string {
	if (clauses.length === 1) return clauses[0];
	return `${clauses.slice(0, -1).join(", ")}, or ${clauses[clauses.length - 1]}`;
}

/**
 * The remedy sentence alone, for a caller that already stated WHAT failed in its
 * own words (`veyyon token` prints `No active credential found for provider
 * "x".` first, and appending a second `No API key for x` would be noise).
 */
export function credentialRemedySentence(provider: string): string {
	return `Fix: ${joinRemedies(remedies(provider))}.`;
}

/**
 * The message for a provider with no usable credentials.
 *
 * @param provider Provider id, e.g. `anthropic`.
 * @param modelId Model id when the failure was for one specific model. Omitted
 *   when the whole provider is the subject, which is what the two
 *   `No API key for ${model.provider}` sites meant.
 * @param what Names the operation that could not start, when the caller is not
 *   an ordinary turn (`retry fallback google/gemini-3.1-pro`). Without it the
 *   reader cannot tell a failed model switch from a failed handoff. Bounded like
 *   an identifier: one caller passes a raw model SELECTOR, which comes from
 *   config or a `--model` argument and has no length of its own.
 */
export function missingCredentialsMessage(provider: string, modelId?: string, what?: string): string {
	const target = modelId ? `${boundIdentifier(provider)}/${boundIdentifier(modelId)}` : boundIdentifier(provider);
	const subject = what ? `No API key for ${boundIdentifier(what)} (${target})` : `No API key for ${target}`;
	const message = `${subject}. Fix: ${joinRemedies(remedies(provider))}.`;
	return message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
