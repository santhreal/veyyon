# The provider stack and bring-your-own-key

> **Status: Built.** The harness owns the model registry and provider auth.

A **provider** is the API namespace (`anthropic`, `openai`, `google`, custom gateways, local
`ollama`, …). A **model** is `provider/model-id`. Veyyon assembles the selectable catalog from:

1. Bundled pi-catalog models
2. `~/.veyyon/agent/models.yml` custom providers and models
3. Runtime discovery (Ollama, LM Studio, discovery-enabled gateways)
4. Extension-registered providers

A model is **available** when its provider is not disabled and credentials resolve (or the provider
is keyless/local).

## Credentials

Resolution order (first match wins):

1. CLI `--api-key` (ephemeral)
2. `models.yml` `apiKey` on a custom provider
3. Stored API key / OAuth in the agent auth store (`~/.veyyon/agent/agent.db`)
4. Provider environment variables (see [`docs/providers.md`](../../../providers.md))
5. Custom fallback resolvers in `models.yml`

Use `/login`, `/logout`, or `veyyon` OAuth flows in setup. Provider-scoped logins do not cross
providers.

## Custom providers

Add OpenAI- or Anthropic-compatible endpoints as data:

```yaml
# ~/.veyyon/agent/models.yml
providers:
  my-gateway:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

Validate with `veyyon models list` and `/model`.

## Local engines

`ollama`, `llama.cpp`, and `lm-studio` are treated as keyless when the engine responds. Each has its
own discovery variable, not a shared `VEYYON_OSS_*` pair: `OLLAMA_BASE_URL` (or `OLLAMA_HOST`),
`LLAMA_CPP_BASE_URL`, `LM_STUDIO_BASE_URL` — see [Environment variables](../reference/environment.md#local-and-self-hosted-providers).

User guides: [Models](../using/models.md), [Configuring providers](../using/configuring-providers.md).

There is no separate `backends.toml` catalog subsystem; Veyyon uses `models.yml` plus the bundled
catalog.
