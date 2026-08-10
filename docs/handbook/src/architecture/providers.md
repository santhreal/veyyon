# Providers

The providers subsystem connects Veyyon to model APIs and normalizes their
auth, request, and response formats.

## Responsibility

- Maintain the catalog of supported model providers and their capabilities.
- Resolve a model slug to a provider and its `ModelInfo`.
- Authenticate requests with API keys, access tokens, or OAuth credentials.
- Translate between the provider-specific wire format and the engine's
  protocol types.

## Implementation

The provider stack lives in the `@veyyon/ai` package.

| Component | Role |
| --- | --- |
| Provider adapters | Per-provider connection and wire-format adapters |
| API client registry | OpenAI-compatible API client registry |
| Provider details | Provider metadata, auth mode, and endpoints |
| Model catalog | Model catalog and per-model capabilities |
| Model registry | Slug resolution to provider + model info |

## Key concepts

- Provider metadata: a provider's auth mode and endpoint configuration.
- Model info: per-model capabilities such as context window and vision support.
- Auth material: resolved from API keys, access tokens, or OAuth credentials.

See [Models and providers](../using/models.md) and
[Provider stack and bring-your-own-key](../models/providers.md) for how to add
your own keys and choose models.

## Prompt caching

Each provider adapter also decides where the request's cache markers go, and the shapes differ:
Anthropic places up to four `cache_control` breakpoints, Bedrock interleaves `cachePoint` blocks,
the OpenAI Responses path sends an explicit `prompt_cache_breakpoint`, and everything else caches
implicitly or not at all. Two settings under **Settings → Context → Prompt Cache** report and
optionally block on a cache the provider demonstrably did not use. The full per-provider account,
including the breakpoint budget and what invalidates what, is
[`docs/internal/prompt-caching.md`](../../../internal/prompt-caching.md).
