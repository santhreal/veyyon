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

- Provider metadata — a provider's auth mode and endpoint configuration.
- Model info — per-model capabilities such as context window and vision support.
- Auth material — resolved from API keys, access tokens, or OAuth credentials.

See [Models and providers](../using/models.md) and
[Provider stack and bring-your-own-key](../models/providers.md) for how to add
your own keys and choose models.
