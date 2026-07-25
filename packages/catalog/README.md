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

## models.json is generated

Never edit `src/models.json` by hand — it is produced from upstream sources (models.dev, provider catalog discovery, OpenCode docs) by `scripts/generate-models.ts` and the resolvers in `src/provider-models/`. Regenerate with:

```sh
bun run gen:models
```

To change an entry, fix the source: resolver overrides in `provider-models/openai-compat.ts`, provider entries in `provider-models/descriptors.ts`, generator fixups in `scripts/generate-models.ts`, or thinking policies in `model-thinking.ts`.

## Failures travel back, they are not logged

No source file in this package logs. It is a data library: it answers questions about models and it does
not own a console, a log file, or a user. When something fails, the reason goes back to the caller as a
value, and the caller decides what to say about it.

Discovery is where this matters. `fetchOpenAICompatibleModels` returns `null` when it could not produce a
catalog and `[]` when the endpoint answered with no models, and those two mean different things: `[]` is
an answer, `null` is a failure. Pass `onFailure` to learn which failure it was:

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

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/santhreal/veyyon#readme)
- [CHANGELOG](./CHANGELOG.md)
