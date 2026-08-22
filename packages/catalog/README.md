# @veyyon/catalog

Model catalog for [veyyon](https://github.com/santhreal/veyyon): bundled model database, provider discovery, model identity, classification, and equivalence.

## What's inside

| Module | Purpose |
| --- | --- |
| `models.json` + `models` | Bundled model database (pricing, context windows, modalities, thinking support) |
| `provider-models` | Provider catalog descriptors (`CATALOG_PROVIDERS`), per-provider model resolution rules |
| `discovery` | Runtime model discovery for OpenAI-compatible endpoints, Gemini, Codex, Cursor, Antigravity, Ollama |
| `identity` | Model id parsing and classification (family/version), reference resolution, equivalence, selection priority |
| `model-thinking` | Thinking/reasoning metadata and generated per-model policies |
| `model-manager` / `model-cache` | Runtime model registry with discovery refresh and on-disk caching |
| `variant-collapse` | Collapsing provider-specific variants of the same underlying model |
| `compat` | Request/response compatibility fixups for OpenAI- and Anthropic-shaped APIs |
| `wire` | Wire-level helpers: Codex, Gemini headers, GitHub Copilot |
| `effort` | Reasoning-effort level definitions |

Import from subpaths (`@veyyon/catalog/<module>`) or the root barrel.

## Generating models.json

`src/models.json` is generated from upstream sources (models.dev, provider catalog discovery, OpenCode documentation) via `scripts/generate-models.ts` and resolvers in `src/provider-models/`. Regenerate with:

```sh
bun run gen:models
```

To modify entries, update the sources: resolver overrides in `provider-models/openai-compat.ts`, provider entries in `provider-models/descriptors.ts`, generator rules in `scripts/generate-models.ts`, or thinking policies in `model-thinking.ts`.

## Discovery diagnostics

Discovery functions return `null` on failure and `[]` when an endpoint reports zero models. Pass `onFailure` to receive structured error details:

```ts
const models = await fetchOpenAICompatibleModels({
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    onFailure: failure => {
        // failure.stage is "base-url" | "request" | "status" | "body" | "payload"
        recordProviderDiscoveryError(provider, `${failure.stage}: ${failure.detail}`);
    },
});
```

The `stage` tells you where to look. `request` means the request never completed, so check DNS, the
firewall, and the base URL. `status` means the endpoint answered and refused, so check credentials.
`body` means something in front of the endpoint answered instead, usually an HTML error page. `payload`
means the JSON parsed and held no model list, so the endpoint is probably not OpenAI-compatible.
`base-url` means nothing was requested because the configured URL is unusable.

Without `onFailure` you still get `null`, exactly as before. Nothing is thrown for a discovery failure.

The `DiscoveryFailure` shape is shared across discovery readers (`fetchOpenAICompatibleModels`, `fetchCodexModels`, `fetchCursorUsableModels`, `fetchDevinModels`, `fetchGeminiModels`, `fetchAntigravityDiscoveryModels`, `fetchGitLabDuoWorkflowModels`).

Multi-endpoint readers report every attempt to `onFailure`.
To receive reasons through a model manager instead of calling a reader directly, pass
`onDiscoveryFailure`:

```ts
const manager = createModelManager({
    providerId: "openai",
    fetchDynamicModels: hooks => fetchOpenAICompatibleModels({ ...args, onFailure: hooks?.onFailure }),
    onDiscoveryFailure: failure => recordProviderDiscoveryError("openai", failure),
});
```

The manager invokes `onDiscoveryFailure` when discovery fails or throws.
## Install

Veyyon ships through GitHub only, so `@veyyon/catalog` is not on npm or any other
registry. It depends on its sibling packages with Bun's `workspace:*` and
`catalog:` protocols, which resolve only inside a checkout, so a registry
install could not work even if one were published.

Consume it from a checkout instead:

```sh
git clone https://github.com/santhreal/veyyon.git
cd veyyon
bun install
bun --cwd=packages/catalog link
```

Then, in your own project:

```sh
bun link @veyyon/catalog
```

See [the SDK guide](../../docs/sdk.md#installation) for the same steps in full.

Ships TypeScript source directly (no build step); requires Bun ≥ 1.4.0.

## References

- [Monorepo README](https://github.com/santhreal/veyyon#readme)
- [CHANGELOG](./CHANGELOG.md)
