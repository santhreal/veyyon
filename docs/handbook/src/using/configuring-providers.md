# Configuring providers

Copy-paste setups for bring-your-own-key (BYOK) and local providers. For the day-to-day switching
guide, see [Models and providers](./models.md). For the harness/provider boundary, see
[Model contract](../concepts/model-contract.md).

Custom providers live under `providers:` in `~/.veyyon/agent/models.yml`. Keys are resolved from the
environment, stored auth, OAuth, or a `models.yml` `apiKey` (see [Providers](../models/providers.md)
and `docs/providers.md`).

## Anatomy of a provider entry

```yaml
# ~/.veyyon/agent/models.yml
providers:
  acme:
    baseUrl: https://api.acme.example/v1
    api: openai-completions
    apiKey: ACME_API_KEY        # env-var name if set, else literal text
    models:
      - id: acme-coder
        name: ACME Coder
        contextWindow: 128000
        maxTokens: 8192
```

| Field | Meaning |
| --- | --- |
| `baseUrl` | OpenAI-compatible API root |
| `api` | Request shape, e.g. `openai-completions` |
| `apiKey` | Env-var name **or** literal; prefix with `!` to run a shell command and use its stdout |
| `auth: none` | Mark a keyless local provider |
| `authHeader: true` | Inject the resolved key as `Authorization: Bearer <key>` |
| `models` | List of `{ id, name, contextWindow, maxTokens }` entries |

Notes worth knowing:

- Custom providers are merged **alongside** built-ins; they do not silently replace `openai`.
- A custom `ollama` / `lm-studio` / `llama.cpp` entry replaces that engine's built-in discovery.
- A YAML or schema error makes the registry skip the file loudly — validate with `veyyon models`.

After editing, restart the session.

## OpenAI (API key)

```console
$ export OPENAI_API_KEY=sk-...
$ veyyon --model openai/gpt-5
```

Managed OpenAI sign-in is also available with `/login openai` inside the TUI, so no key is pasted into
the shell. See [Authentication](./authentication.md).

## DeepSeek

```yaml
providers:
  deepseek:
    baseUrl: https://api.deepseek.com
    api: openai-completions
    apiKey: DEEPSEEK_API_KEY
    models:
      - id: deepseek-chat
        name: DeepSeek Chat
        contextWindow: 128000
        maxTokens: 8192
```

```console
$ export DEEPSEEK_API_KEY=sk-...
$ veyyon --model deepseek/deepseek-chat
```

`deepseek` is also a built-in catalog provider; the env var alone is enough if you do not need a custom
endpoint.

## OpenRouter (OpenAI-compatible gateway)

```console
$ export OPENROUTER_API_KEY=...
$ veyyon --model openrouter/anthropic/claude-sonnet-4
```

Model ids are whatever OpenRouter lists; Veyyon discovers them at runtime.

## Anthropic

Anthropic is a built-in provider. Sign in with `/login anthropic` (OAuth) or set `ANTHROPIC_API_KEY`:

```console
$ export ANTHROPIC_API_KEY=sk-ant-...
$ veyyon --model anthropic/claude-sonnet-4-5
```

To reach Anthropic models through a gateway instead, add an OpenAI-compatible custom provider
(OpenRouter, LiteLLM, a team proxy) and select the gateway's model id.

## Other OpenAI-compatible hosts

Any host that speaks Chat Completions works the same way — only `baseUrl`, `api`, and `apiKey` change:

```yaml
providers:
  my-proxy:
    baseUrl: https://llm-proxy.example.com/v1
    api: openai-completions
    apiKey: PROXY_API_KEY
    authHeader: true
    models:
      - id: coder-large
        name: Org Coder Large
        contextWindow: 200000
        maxTokens: 8192
```

```console
$ export PROXY_API_KEY=...
$ veyyon --model my-proxy/coder-large
```

## Amazon Bedrock

Bedrock is a built-in provider. Use the usual AWS credential chain (`AWS_PROFILE`, instance role, or
`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) expected by the AWS SDK on your machine.

## Ollama (local)

Ollama is discovered automatically and is keyless when the daemon is running. Default base URL
`http://127.0.0.1:11434` (override with `OLLAMA_BASE_URL`).

```console
$ ollama serve
$ ollama pull llama3.2
$ veyyon           # then /model and pick an ollama/… entry from discovery
```

## LM Studio (local)

LM Studio (`lm-studio`) is also discovered automatically and keyless by default. Default base URL
`http://127.0.0.1:1234/v1` (override with `LM_STUDIO_BASE_URL`).

```console
$ lms server start
$ veyyon           # then /model and pick an lm-studio/… entry
```

## Pinning models for roles and CI

Set background roles under `modelRoles` in `config.yml`:

```yaml
# ~/.veyyon/agent/config.yml
modelRoles:
  default: openai/gpt-5
  smol: openai/gpt-5-mini
  task: deepseek/deepseek-chat
```

For a hermetic CI run, pass an explicit model and a one-shot config overlay:

```console
$ veyyon --config ./ci-settings.yml --model openai/gpt-5-mini \
    "summarize the staged diff in five bullets"
```

## Verify

```console
$ veyyon models
$ veyyon --model <provider>/<id> "reply with the model name you are"
```

If discovery or auth fails, the error names the provider and the missing key or unreachable base URL —
fix that rather than retrying with a different silent default.

## See also

- [Models and providers](./models.md)
- [Model contract](../concepts/model-contract.md)
- [Provider stack](../models/providers.md)
- [Authentication](./authentication.md)
- [Configuration](./configuration.md)
