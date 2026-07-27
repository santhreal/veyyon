# Adding a provider

A provider is described in two halves:

- **Catalog half** (`packages/catalog`): one entry in the `CATALOG_PROVIDERS`
  table (`packages/catalog/src/provider-models/descriptors.ts`) carrying the
  `id`, `defaultModel`, runtime model-discovery factory, and catalog-generation
  wiring. `KnownProvider`, `PROVIDER_DESCRIPTORS`, and
  `DEFAULT_MODEL_PER_PROVIDER` are derived from this table.
- **Auth half** (`packages/ai`): one declarative `ProviderDefinition` in the
  registry carrying env-key fallbacks and login/refresh flows. The
  `OAuthProvider` union, the env-key map, the `/login` provider list, the
  `refreshOAuthToken` / `AuthStorage.login` dispatch, and the coding-agent
  callback maps are derived from the registry.

**Scope.** This is for a provider that reuses an existing wire API
(`openai-completions`, `anthropic-messages`, `google-generative-ai`, …), the
common case for gateways and API-key providers, since stream dispatch keys on
`model.api`, not `model.provider`. Adding a *new wire protocol* (a new
`KnownApi`) is a separate task that also touches `stream.ts` dispatch,
`api-registry.ts`, and the catalog `types.ts`.

## Shape

For the common case, a provider is **one catalog entry + one def file + one registry line**:

1. **Add an entry to `CATALOG_PROVIDERS`** in
   `packages/catalog/src/provider-models/descriptors.ts` with the `id`,
   `defaultModel`, the plain API-key env var(s) as `envVars`, and (usually) a
   `createModelManagerOptions` factory. For a
   simple OpenAI-compatible gateway, build the factory in
   `packages/catalog/src/provider-models/openai-compat.ts` or inline with the
   exported `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)`.
2. **Create `packages/ai/src/registry/<id>.ts`** exporting one
   `export const <camelId>Provider = { … } as const satisfies ProviderDefinition;`
   with the auth fields (`login`, …). Plain env-var names live in the catalog
   entry's `envVars`. A definition carries no env-key field: if the provider needs
   a computed resolver (a Foundry/ADC/Bedrock-style probe) or has no catalog entry
   at all, add it to `PROVIDER_ENV_KEY_OVERRIDES` in
   `packages/ai/src/provider-env-keys.ts`, which is the one place such a rule is
   written and the one module `getEnvApiKey` reads. Do not restate a catalog
   `envVars` value there: a string override that repeats the catalog for the same
   id is one fact in two places, and `packages/ai/test/provider-env-keys.test.ts`
   fails on it.

   A base URL works the same way. Read it from the catalog entry, from
   configuration, or from a discovery response. If the provider needs a host
   the code decides, meaning the one a request goes to when nobody configured
   anything, add it to `packages/catalog/src/provider-endpoints.ts` and import
   it. That module has no imports, so taking a host from it costs one module.
   Do not write the URL as a literal in your provider: the Google Cloud Code
   host was retyped in six modules under four names before the owner existed,
   and `packages/catalog/test/provider-endpoints.test.ts` now fails if a host
   literal appears anywhere else.

   If your provider's OAuth flow redirects back to the default loopback path,
   omit `callbackPath` or import `DEFAULT_CALLBACK_PATH` from
   `packages/ai/src/registry/oauth/callback-server.ts`. Write a path literal
   only when the provider has registered a different redirect URI, as
   `openai-codex`, `google-antigravity` and `google-gemini-cli` each have.
3. **Add it to the `ALL` array** in `packages/ai/src/registry/registry.ts`
   (one import + one array entry). `ALL` order is the `/login` list order for
   loginable providers.

That is the full change for:
- env-key-only providers,
- providers with a simple inline API-key login flow,
- most OpenAI-compatible gateways.

For a **non-trivial provider-local OAuth flow**, put the implementation in
`packages/ai/src/registry/oauth/<vendor>.ts` and lazy-import it from the def
file. The shared OAuth flow infrastructure it builds on lives in the same
`registry/oauth/` directory.

Descriptors, the default-model map, env-key map, login list, and refresh
dispatch all update automatically; the `KnownProvider` union gains the new id
from the catalog table and `OAuthProvider` from the registry.

## Field reference

**Catalog table entry** (`ProviderCatalogEntry`, see
`packages/catalog/src/provider-models/descriptor-types.ts` for JSDoc):

| Field | Effect |
|---|---|
| `id` | Required. Member of `KnownProvider`. |
| `defaultModel` | Required. Preferred model when no explicit selection is made. |
| `envVars` | Env var name(s), in order, for the runtime API-key fallback (`getEnvApiKey`). |
| `createModelManagerOptions` | Runtime model-discovery factory. Present (and not `specialModelManager`) ⇒ appears in `PROVIDER_DESCRIPTORS`. |
| `allowUnauthenticated` | Runtime creates a model manager even without a key. |
| `dynamicModelsAuthoritative` | Successful discovery replaces bundled models. |
| `catalogDiscovery` | `{ label, envVars?, oauthProvider?, allowUnauthenticated? }` for offline catalog generation (`generate-models.ts`). `envVars` here overrides the entry-level list when generation uses different credentials (e.g. `cursor`). |
| `specialModelManager` | Bespoke runtime factory (`google-antigravity` / `google-gemini-cli` / `openai-codex`); excluded from `PROVIDER_DESCRIPTORS`. |

**Registry definition** (`ProviderDefinition`, see
`packages/ai/src/registry/types.ts`). Env-key rules are not here: they live in
`packages/ai/src/provider-env-keys.ts`, because a definition costs 121 modules
and answering "which variable holds the key" must not.

| Field | Effect |
|---|---|
| `id`, `name` | Required. `name` shows in the `/login` list. |
| `login` | Interactive login. Present ⇒ member of `OAuthProvider`, shown in `/login`, dispatchable via `AuthStorage.login`. Returns an api-key `string` or `OAuthCredentials`. |
| `refreshToken` | OAuth refresher; omit for static-token providers (the dispatch returns credentials unchanged). |
| `storeCredentialsAs` | Store credentials under a different provider id (e.g. `openai-codex-device` ⇒ `openai-codex`). |
| `callbackPort` | Present ⇒ entry in the auth-broker `CALLBACK_PORTS` map. |
| `pasteCodeFlow` | OAuth flow needs a pasted code/redirect URL ⇒ member of `PASTE_CODE_LOGIN_PROVIDERS`. |

## Conventions

- Use `... as const satisfies ProviderDefinition` so the literal `id` is preserved
  for the union derivation.
- `login` / `refreshToken` for simple API-key or validation-based flows can live
  directly in the provider def file (export the named login function there so
  tests can import it directly).
- `login` / `refreshToken` for heavy provider-local OAuth flows MUST reach the
  adjacent `registry/oauth/*` module via a dynamic-import
  thunk (`const { loginX } = await import("./oauth/x"); return loginX(cb);`),
  keeping those flows out of the eager startup graph.
- All OAuth code lives under `registry/oauth/`: the shared flow infra
  (`callback-server`, `pkce`, `google-oauth-shared`, `types`, the runtime API
  `index`) plus every provider flow, including the `github-copilot` / `kimi` /
  `openai-codex` helpers reused by the streaming and usage layers. The non-OAuth
  API-key helpers (`api-key-login`, `api-key-validation`) sit beside the def
  files in `registry/`, since they back simple paste-an-API-key logins.
- For a simple OpenAI-compatible gateway, build the manager inline with the
  exported `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)`,
  no edits to `openai-compat.ts` required.
- A `ProviderDefinition` may also be registered at runtime by an extension via
  `registerOAuthProvider` (the `AuthStorage.login` dispatcher handles built-ins
  and extensions through the same path).

*Verified against `d3e3db30` on 2026-07-23.*
