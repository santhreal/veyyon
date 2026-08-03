import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { removeSyncWithRetries } from "@veyyon/utils";
import { CONFIG_ROOT_ENV_KEYS, XDG_BASE_DIRS } from "../../../utils/test/helpers/isolated-config-root";

/**
 * Env vars that redirect the config/agent tree, select a profile, or move a per-category root. A
 * spawned CLI inheriting any of these (or the real HOME) reads — and via the legacy layout
 * migration in runCli, can MUTATE — the developer's real ~/.veyyon.
 *
 * Both lists are imported rather than restated. This helper used to name the three veyyon
 * variables and nothing else, so a developer running with `XDG_STATE_HOME` set handed every child
 * CLI a state root inside their real tree: `logs/`, `sessions/` and `reports/` resolve there in
 * preference to the config root, and HOME being a temp directory does not change that. Keeping a
 * private copy of the list is what let it fall behind.
 */
const CONFIG_ENV_VARS = [...CONFIG_ROOT_ENV_KEYS, ...XDG_BASE_DIRS] as const;

/**
 * Every variable that hands a spawned CLI a provider credential.
 *
 * DERIVED FROM THE CATALOG, for the same reason the two lists above are imported: a private copy
 * is a list that falls behind. `CATALOG_PROVIDERS` is the table a provider is added to, and
 * `envVars` is the field that decides which variable the runtime reads for its key
 * (`@veyyon/ai`'s `getEnvApiKey` derives its own fallbacks from exactly this field), so flattening
 * it here means a provider added tomorrow is scrubbed tomorrow with no edit to this file.
 * `catalogDiscovery.envVars` is folded in too, because a provider may name a different variable
 * for discovery than for chat (`cursor` reads `CURSOR_ACCESS_TOKEN` and discovers with
 * `CURSOR_API_KEY`).
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. A handful of providers resolve their credential through
 * a function rather than a name (Bedrock's IAM/profile/ECS chain, Vertex's Application Default
 * Credentials, Anthropic under Foundry), and `@veyyon/ai`'s `PROVIDER_ENV_KEY_OVERRIDES` holds
 * those as resolvers, not as a list anything can flatten. There is no second source of truth to
 * import, so rather than hand-write their variable names (the exact mistake this comment exists
 * to prevent) they are left alone; the temp HOME already moves the on-disk halves of those chains
 * out of reach.
 */
export const PROVIDER_CREDENTIAL_ENV_VARS: readonly string[] = [
	...new Set(
		(CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => [
			...(provider.envVars ?? []),
			...(provider.catalogDiscovery?.envVars ?? []),
		]),
	),
];

/**
 * A loopback endpoint that is closed by construction.
 *
 * Removing credentials is only half of "the child cannot reach a provider". `ollama`,
 * `llama.cpp` and `lm-studio` are registered as OPTIONAL discoverable providers on every launch
 * with no credential and no config at all (`ModelRegistry.#addImplicitDiscoverableProviders`),
 * each pointed at a fixed loopback default. So a developer with Ollama running gives a brand-new
 * temp HOME a working model, and a suite whose assertion depends on there being no model passes
 * on CI and fails on that desk, the outcome decided by what the machine happens to be running.
 *
 * Port 0 is the answer rather than "some port nothing is on": it is reserved, no socket can bind
 * it, so the connect is refused by the kernel immediately (measured at ~5ms here, against a 200 OK
 * from the real Ollama on the same host) and no run can be salvaged by a listener appearing. A
 * high port picked at random is only PROBABLY closed, and only until something takes it.
 */
const CLOSED_LOOPBACK_AUTHORITY = "127.0.0.1:0";
const CLOSED_LOOPBACK_ORIGIN = `http://${CLOSED_LOOPBACK_AUTHORITY}`;

/**
 * Where each local-provider knob points once discovery is neutralized.
 *
 * The first four are the implicit providers above: `OLLAMA_BASE_URL` and `OLLAMA_HOST` are both
 * set because `getImplicitOllamaBaseUrl` reads them in that order and a child could otherwise be
 * steered by whichever one the developer exports. `LITELLM_BASE_URL` needs an explicit provider
 * config to matter today, and is included so that a config which does name it still cannot reach
 * a proxy on the host. vLLM has the same shape but no env knob at all, since its base URL comes
 * only from config, so there is nothing to set for it here.
 */
export const UNREACHABLE_LOCAL_PROVIDER_ENV: Readonly<Record<string, string>> = {
	OLLAMA_BASE_URL: CLOSED_LOOPBACK_ORIGIN,
	OLLAMA_HOST: CLOSED_LOOPBACK_AUTHORITY,
	LLAMA_CPP_BASE_URL: CLOSED_LOOPBACK_ORIGIN,
	LM_STUDIO_BASE_URL: `${CLOSED_LOOPBACK_ORIGIN}/v1`,
	LITELLM_BASE_URL: `${CLOSED_LOOPBACK_ORIGIN}/v1`,
};

/**
 * Cut a child's environment off from every provider the host can reach, in place.
 *
 * Exported so a harness that builds its child environment some other way (`env -i` plus an
 * allowlist, or a from-scratch three-variable map) gets the same treatment from the same code
 * rather than a second copy of the same list.
 */
export function denyHostProviderAccess(env: Record<string, string | undefined>): void {
	for (const key of PROVIDER_CREDENTIAL_ENV_VARS) {
		delete env[key];
	}
	Object.assign(env, UNREACHABLE_LOCAL_PROVIDER_ENV);
}

export interface HermeticSpawnEnv {
	/** Temp dir used as HOME for the spawned process. */
	home: string;
	/** Env for Bun.spawn: process.env with HOME swapped and config vars removed. */
	env: Record<string, string | undefined>;
	/** Remove the temp HOME. Call in afterAll/afterEach or after the spawn. */
	cleanup: () => void;
}

/** Build a spawn env whose HOME is a fresh temp dir and whose providers are all unreachable, so the
 * child CLI can neither read or migrate the developer's real ~/.veyyon nor borrow their models. */
export function hermeticSpawnEnv(extra?: Record<string, string>): HermeticSpawnEnv {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-hermetic-home-"));
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of CONFIG_ENV_VARS) {
		delete env[key];
	}
	denyHostProviderAccess(env);
	// `extra` last, so a suite that genuinely needs one credential or one reachable endpoint can
	// pass it in and get it. Stripping is the default, not a prohibition.
	Object.assign(env, extra);
	return { home, env, cleanup: () => removeSyncWithRetries(home) };
}
