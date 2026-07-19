# Models and providers

You choose an endpoint and a model id. Veyyon then calls that provider's API directly with your credentials. The endpoint can be a local server, a hosted API, or any OpenAI-compatible gateway.

- Contract (what the harness owns vs the provider): [Model contract](../concepts/model-contract.md)
- Copy-paste provider setups: [Configuring providers](./configuring-providers.md)
- Built-in provider stack internals: [Provider stack and BYOK](../models/providers.md)

## API keys (BYOK)

BYOK means bring your own key. For a provider you configure yourself, Veyyon sends your key straight to that provider's endpoint. There is no hosted proxy in between.

Set the key one of three ways:

- The provider's environment variable (see [Providers](../models/providers.md) for the full map), or
- `/login` inside the TUI, which stores the credential in the auth store, or
- A `models.yml` `apiKey` on a custom provider (env-var name or literal).

See [Signing in](./authentication.md) for storage modes and [Configuring providers](./configuring-providers.md)
for full `models.yml` examples.

### Minimal BYOK shape

```yaml
# ~/.veyyon/profiles/default/agent/models.yml
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

## Built-in providers

Veyyon ships a large built-in catalog (Anthropic, OpenAI, Google, Groq, OpenRouter, Mistral, xAI,
Bedrock, and many hosted gateways) plus three auto-discovered local engines. A provider becomes
selectable when it is not in `disabledProviders` **and** it is keyless or has resolvable credentials.

| Provider id | Notes |
| --- | --- |
| `anthropic`, `openai`, `google`, `groq`, … | Cloud providers; sign in with `/login <id>` or set the env var. |
| `amazon-bedrock` | Uses the AWS credential chain (`AWS_PROFILE`, instance role, …). |
| `ollama`, `lm-studio`, `llama.cpp` | Local engines, discovered automatically and keyless by default. |

Once a provider is available, model ids come from its discovery endpoint, there is no hardcoded BYOK
allowlist. Failed discovery returns an error; it does not invent an empty catalog.

## Local models: Ollama and LM Studio

Both are discovered automatically once the engine is running; no `models.yml` entry and no key are
required.

```console
$ ollama serve
$ ollama pull llama3.2
$ veyyon                # then /model and choose an ollama/… entry
```

```console
$ lms server start
$ veyyon                # then /model and choose an lm-studio/… entry
```

Override the base URL with `OLLAMA_BASE_URL` / `LM_STUDIO_BASE_URL` if a daemon listens elsewhere. An
explicit `models.yml` entry for one of these ids replaces its built-in discovery.

## Mid-session model switch

| Action | What it changes | What it does **not** change |
| --- | --- | --- |
| `/model` (or restart with `--model`) | The **interactive** model for subsequent turns | The subagent and compaction models |

Switching the interactive model mid-session never blends through a fallback chain into the subagent or
compaction model. `/status` shows all effective models. `veyyon plugin doctor` warns about missing
external binaries and keys.

```console
$ veyyon --model openai/gpt-5
# later, inside the TUI:
/model deepseek/deepseek-chat
/status
```

## Model selection

| Piece | Purpose | Config |
| --- | --- | --- |
| **Interactive model** | Main conversation | `/model`, `--model`; persisted as `modelRoles.default` |
| **Roles** | Named assignments (`smol`, `slow`, `plan`, `task`, `advisor`, …) | `modelRoles` / settings → Model → Roles |
| **Subagent override** | Task subagents | `subagent.model` (overrides `modelRoles.task` when set; else inherit interactive) |
| **Compaction override** | Compaction / handoff | `compaction.model` (else inherit interactive) |

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
modelRoles:
  default: openai/gpt-5          # interactive (persisted default)
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  plan: anthropic/claude-sonnet-5
  task: deepseek/deepseek-chat
subagent:
  model: deepseek/deepseek-chat  # optional hard override for task agents
compaction:
  model: openai/gpt-5-mini
```

Ctrl+P (default binding) cycles roles listed in `cycleOrder` (schema default `smol`, `slow`, not `default`). Full role list and aliases: [Models, roles, and profiles](./roles-and-profiles.md).

## Per-model harness settings

Prompt order, repair enablement, and tool exposure can be set per model id through **harness profiles**
and model roles. See [Execution-order prompts](../models/prompts.md) and
[Model contract](../concepts/model-contract.md).

### Harness profiles

Optional overrides in `config.yml` or `~/.veyyon/profiles/default/agent/harness-profiles.yml`:

```yaml
harness:
  profiles:
    "openai/gpt-4.1":
      repair: true
      tools: ["read", "edit", "grep", "bash", "write"]
      promptSectionOrder: ["tool-policy", "delivery-contract"]
```

Keys: exact `provider/model-id` or `provider/*`. See [Per-model repair posture](../repair/per-model.md).

## Switching providers

Set credentials for the new provider and select a model id from that catalog. Tool surface and `tools.approvalMode` are independent of provider id.

```console
$ export OPENROUTER_API_KEY=...
$ veyyon --model openrouter/anthropic/claude-sonnet-4
```

## Model selection notes

| Constraint | Typical choice |
| --- | --- |
| Tool-heavy refactors | Hosted model with tool calling |
| Long sessions / subagents | Cheaper id on `subagent.model` / `compaction.model` |
| Low latency | Local or flash-tier cloud |
| Offline / private code | Ollama, LM Studio, llama.cpp |
| CI | Pin exact `provider/id` with `--model` |

Pin models in CI and shared profiles (`--model`, `modelRoles`). Floating “latest” aliases change under you.

## Where to go next

- [Configuring providers](./configuring-providers.md): full copy-paste setups.
- [Model contract](../concepts/model-contract.md): harness vs provider boundary.
- [Getting started](./getting-started.md): first key and first task.
- [Configuration](./configuration.md): model defaults and overrides.
- [Authentication](./authentication.md): login, logout, secret storage.
