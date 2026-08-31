/**
 * Which environment variable holds a provider's API key, for every provider the catalog cannot describe.
 *
 * WHY THIS IS ITS OWN MODULE. `env-api-key.ts` answers "which variable holds provider X's key" and it is
 * imported for exactly that, by eighteen web-search providers in `@veyyon/coding-agent`, by
 * `web/parallel.ts`, and through that by `tools/fetch.ts` and `tools/read.ts`. Its own doc records why it
 * was split out of `stream.ts`: asking a one-line question should not cost the streaming engine.
 *
 * It kept costing 158 modules anyway, because the OVERRIDES lived on the provider DEFINITIONS. A definition
 * is heavy by design (login flows, transports, model lists, OAuth callbacks), and reading one field off all
 * of them meant importing `./registry`, which is 121 modules and was 95 MARGINAL on this lookup. So the
 * table that says `AWS_PROFILE or AWS_ACCESS_KEY_ID counts as authenticated` dragged the whole provider
 * registry into every web-search provider in the product.
 *
 * The rule is small and self-contained; the definition it used to hang on is not. Both facts belong
 * somewhere, and this is the somewhere for the first one. `registry/types.ts` no longer declares an
 * `envKeys` field, so there is exactly one place a provider's env-key rule can be written and exactly one
 * module that reads it. `packages/ai/test/provider-env-keys.test.ts` fails if a definition grows the field
 * back, which is the failure mode that matters: a field nothing reads looks like configuration and does
 * nothing.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT. `@veyyon/catalog`'s `envVars` is the source for a plain provider
 * env-var name and stays the source: this table is only for what a variable name cannot express, which is
 * three probes (Bedrock's credential chain, Vertex ADC, Anthropic under Foundry) plus the ids the catalog
 * does not model at all (search tools and local servers). A provider whose key is one ordinary variable
 * belongs in the catalog, not here, and adding it here as well is the duplicate this module exists to end.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $pickenv } from "@veyyon/utils/env";
import { isFoundryEnabled } from "./utils/foundry";

/**
 * API-key environment fallback: either a single env var name (`"OPENAI_API_KEY"`) or a resolver that
 * inspects several variables or probes the host.
 *
 * ONE declaration. It was written out twice, identically, in `registry/types.ts` and in `env-api-key.ts`,
 * which is the same-name duplicate that drifts: the reader of either copy has no way to know the other
 * exists. `registry/types.ts` re-exports this one so its public name is unchanged.
 */
export type KeyResolver = string | (() => string | undefined);

/** The sentinel a probe returns when credentials exist but are not a readable string. */
/**
 * Returned in place of a key when the provider is authenticated some other way, an OAuth credential or an
 * ambient cloud identity, so a caller can tell "signed in" from "no credential at all".
 *
 * Exported because it is compared by equality elsewhere: `providers/amazon-bedrock.ts` declared its own copy
 * to recognise it, and a sentinel that two modules spell separately stops being a sentinel the moment one
 * changes. Bedrock treats a match as "use the ambient AWS credential chain", so a miss would send the literal
 * string `<authenticated>` as an API key.
 */
export const AUTHENTICATED_API_KEY_SENTINEL = "<authenticated>";

let cachedVertexAdcCredentialsExists: boolean | null = null;

/**
 * Whether Application Default Credentials are on disk.
 *
 * Cached for the process, because this is called on every key lookup and the answer is a file that does
 * not appear mid-run: `gcloud auth application-default login` is something you do before starting veyyon,
 * not during a turn.
 */
function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = $env.GOOGLE_APPLICATION_CREDENTIALS;
		if (gacPath) {
			cachedVertexAdcCredentialsExists = fs.existsSync(gacPath);
		} else {
			cachedVertexAdcCredentialsExists = fs.existsSync(
				path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

/** Test seam for the ADC probe's process cache, so a suite can assert both answers. */
export function resetVertexAdcProbeForTests(): void {
	cachedVertexAdcCredentialsExists = null;
}

/**
 * Amazon Bedrock accepts bearer tokens, IAM keys, profiles and the ECS/IRSA credential chains, none of
 * which is a single variable holding a key, so the answer is the sentinel rather than a value.
 */
function amazonBedrockEnvKey(): string | undefined {
	const hasEcsCredentials = !!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
	if (
		$env.AWS_PROFILE ||
		($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
		$env.AWS_BEARER_TOKEN_BEDROCK ||
		hasEcsCredentials ||
		hasWebIdentity
	) {
		return AUTHENTICATED_API_KEY_SENTINEL;
	}
	return undefined;
}

/** Vertex AI takes either an explicit API key or Application Default Credentials plus project and location. */
function googleVertexEnvKey(): string | undefined {
	if ($env.GOOGLE_CLOUD_API_KEY) {
		return $env.GOOGLE_CLOUD_API_KEY;
	}
	const hasCredentials = hasVertexAdcCredentials();
	const hasProject = !!($env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT);
	const hasLocation = !!($env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION);
	if (hasCredentials && hasProject && hasLocation) {
		return AUTHENTICATED_API_KEY_SENTINEL;
	}
	return undefined;
}

/** Foundry mode switches Anthropic auth to enterprise gateway credentials, so the variable list changes. */
function anthropicEnvKey(): string | undefined {
	return isFoundryEnabled()
		? $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
		: $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY");
}

/**
 * Every provider whose env-key rule the catalog cannot state, keyed by provider id.
 *
 * These override the catalog's `envVars` for the same id, which is why `anthropic` is here: the catalog
 * says `ANTHROPIC_API_KEY` and that is right for the ordinary case, but under Foundry the gateway variable
 * comes first and no static list can express "first, if Foundry is on".
 *
 * The plain strings below are ids the catalog does not model: search tools and a local server, none of
 * which is a model provider with a descriptor entry. A provider that IS in the catalog and whose key is
 * one ordinary variable must not appear here; `gitlab-duo-agent` did, restating the catalog's own
 * `GITLAB_TOKEN` under a different name for the same fact, and the test suite now fails on that.
 */
export const PROVIDER_ENV_KEY_OVERRIDES: Readonly<Record<string, KeyResolver>> = {
	anthropic: anthropicEnvKey,
	"amazon-bedrock": amazonBedrockEnvKey,
	"google-vertex": googleVertexEnvKey,
	// Search tools and API-name keys that were never modelled as provider definitions.
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	brave: "BRAVE_API_KEY",
	exa: "EXA_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
	jina: "JINA_API_KEY",
	kagi: "KAGI_API_KEY",
	"llama.cpp": "LLAMA_CPP_API_KEY",
	parallel: "PARALLEL_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	tavily: "TAVILY_API_KEY",
	tinyfish: "TINYFISH_API_KEY",
};
