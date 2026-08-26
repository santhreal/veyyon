/**
 * Default base URLs the code decides, for providers whose host is not catalog data. What lands here is the
 * host a request goes to when nobody configured one. `hosts.ts` answers the different question of classifying
 * an arbitrary base URL. No imports — taking a host from here costs one module, which is why duplicates don't
 * come back. `ANTIGRAVITY_ENDPOINTS` order is part of the contract (daily first, sandbox second).
 */

/**
 * Cloud Code Assist, which serves Gemini CLI credentials, the `v1internal` model and onboarding calls, and
 * Gemini usage reporting.
 */
export const CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";

/** Antigravity's production host, tried first. */
export const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

/** Antigravity's sandbox host, tried after the primary one and used alone when a caller asks for sandbox. */
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

/**
 * Every Antigravity host to try, in order, when no base URL is configured.
 *
 * Callers spread this into a mutable array rather than mutating it, because a caller that narrows to one
 * host (sandbox only, say) must not narrow the list every later caller reads.
 */
export const ANTIGRAVITY_ENDPOINTS = [ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT] as const;

/**
 * GitLab's SaaS instance, the default when no self-managed instance URL is configured.
 *
 * Used for the OAuth authorize and token endpoints and for the Duo API, all of which live on whichever
 * instance a user actually has. Five modules each kept their own copy of this fallback under three
 * different names, so a change would have moved some requests to a new host and left others on the old one.
 */
export const GITLAB_SAAS_URL = "https://gitlab.com";

/**
 * Devin's three hosts, which are three different services and must never share one name.
 *
 * They were spread across three modules and two packages, and two of the declarations used the SAME name for
 * DIFFERENT hosts: `ai/src/providers/devin.ts` exported `DEVIN_API_URL = "https://server.codeium.com"` while its
 * sibling `ai/src/registry/oauth/devin.ts` declared `DEVIN_API_URL = "https://api.devin.ai"`. One of those was
 * exported, so anything reaching for "the Devin API URL" to authenticate would have got the chat host and failed
 * against an endpoint that does not serve tokens. `catalog/src/discovery/devin.ts` held a third declaration of the
 * chat host under a third name, `DEVIN_DEFAULT_BASE_URL`.
 *
 * The names here say which service each host is, so the question "which one do I want" has an answer you can read.
 */

/**
 * Cascade chat API, the Connect-protocol host that serves streaming completions and the model catalog.
 *
 * Still a `codeium.com` host because Devin is Cognition's rebrand of Codeium's Cascade backend. That surprise is
 * exactly why it needs a name: `server.codeium.com` in a Devin code path reads like a mistake until you know.
 */
export const DEVIN_CASCADE_ENDPOINT = "https://server.codeium.com";

/** Token API, which serves the CLI OAuth exchange at `/auth/cli/token`. Not the chat host. */
export const DEVIN_AUTH_ENDPOINT = "https://api.devin.ai";

/** Web app, which hosts the page a user is sent to in order to approve a CLI login. Not an API at all. */
export const DEVIN_WEBAPP_URL = "https://app.devin.ai";

/**
 * The Gemini developer API, the endpoint an ordinary API key talks to.
 *
 * The `/v1beta` segment is part of the value rather than something a caller appends, because every consumer
 * needs the same version and three separate spellings of it is how one of them gets left behind. Distinct from
 * Cloud Code Assist above, which serves OAuth credentials and the internal model surface.
 */
export const GEMINI_DEVELOPER_API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Anthropic's official API host.
 *
 * Read for two different jobs, which is why it has to be one string: it is the base URL a request falls back
 * to when nothing is configured, and it is what `compat/anthropic.ts` compares a configured base URL against
 * to decide whether it is talking to Anthropic itself. That comparison is exact, and deliberately not a
 * prefix test, so a lookalike host cannot pass it.
 */
export const ANTHROPIC_API_ENDPOINT = "https://api.anthropic.com";

/** Cursor's API host, the fallback when no Cursor endpoint is configured. */
export const CURSOR_API_ENDPOINT = "https://api2.cursor.sh";

/**
 * OpenRouter's API base, the fallback when no endpoint is configured.
 *
 * Four modules spelled it: `mnemopi/config.ts` as `DEFAULT_EMBEDDING_API_URL`, `mnemopi/core/embeddings.ts`
 * and `mnemopi/core/extraction/client.ts` inline inside an env-variable fallback chain, and
 * `coding-agent/web/search/providers/perplexity-auth.ts` as `OPENROUTER_BASE_URL`. That last name is also the
 * name of the ENVIRONMENT VARIABLE those chains read, so a reader could not tell from the name whether they
 * were looking at the configured value or the default it falls back to.
 *
 * The `/v1` segment is part of the value, since every consumer appends a path to it.
 */
export const OPENROUTER_API_ENDPOINT = "https://openrouter.ai/api/v1";
