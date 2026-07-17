# Models and providers

This page is the day-to-day guide for choosing and switching models. Veyyon is provider/API agnostic:
you choose the endpoint, choose the model when that endpoint exposes model choice, supply the key, and
Veyyon calls that API directly. The endpoint can be a local server, a direct provider API, or a
compatible gateway.

- Contract (what the harness owns vs the provider): [Model contract](../concepts/model-contract.md)
- Copy-paste provider setups: [Configuring providers](./configuring-providers.md)
- Built-in provider stack internals: [Provider stack and BYOK](../models/providers.md)

## Bring your own key

When you use a non-managed BYOK provider, Veyyon does not route your requests through a service of its
own and does not add telemetry egress. It uses your key only to talk to the provider you chose.

Set the key through:

- The provider's environment variable (see [Providers](../models/providers.md) for the full map), or
- `/login` inside the TUI, which stores the credential in the auth store, or
- A `models.yml` `apiKey` on a custom provider (env-var name or literal).

See [Signing in](./authentication.md) for storage modes and [Configuring providers](./configuring-providers.md)
for full `models.yml` examples.

### Minimal BYOK shape

```yaml
# ~/.veyyon/agent/models.yml
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

Once a provider is available, model ids come from its discovery endpoint — there is no hardcoded BYOK
allowlist. Discovery fails loud rather than serving a silent empty list.

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

## Model selection: three explicit slots

Veyyon separates the model you talk to from the models that work in the background. There are three
explicit slots, each set on its own — no `default` model stands in for the others:

- **Interactive model** — the conversation you are in. Chosen with `/model` (or `--model` for a run).
- **Subagent model** — task subagents. Set once in settings (`subagent.model`).
- **Compaction model** — context compaction. Set once in settings (`compaction.model`).

Leave a background slot unset and it uses the interactive model. Switching the interactive model
mid-session never blends through a fallback chain into the background slots. `/status` shows all
effective models.

```yaml
# ~/.veyyon/agent/config.yml
model: openai/gpt-5               # interactive
subagent:
  model: deepseek/deepseek-chat
compaction:
  model: openai/gpt-5-mini
```

### Roles (optional)

If you want named model assignments for specific work types (planning, review, …), configure **roles**
in settings → Models → Roles. Roles are optional, scoped per profile, and live in settings — not the
model picker. `default` is not a role or a model. See
[Models, roles, and profiles](./roles-and-profiles.md).

## The harness adapts to the model

A model does not run in a generic harness. Prompt order, repair enablement, and tool exposure can be
tuned per model via **harness profiles (MVP)** and model roles. You choose the model; Veyyon applies
defaults that match how that model behaves. See [Execution-order prompts](../models/prompts.md) and
[Model contract](../concepts/model-contract.md).

### Per-model harness profiles (MVP)

Optional overrides in `config.yml` or `~/.veyyon/agent/harness-profiles.yml`:

```yaml
harness:
  profiles:
    "openai/gpt-4.1":
      repair: true
      tools: ["read", "edit", "grep", "bash", "write"]
```

Keys: exact `provider/model-id` or `provider/*`. See [Per-model repair posture](../repair/per-model.md).
Full `backends.toml` posture tables remain **Spec**.

## Switching providers

Switching providers does not change how you work. Set the key for the new provider, choose its model,
and continue. Your workflow, tools, sandbox, and approvals stay the same. There is no lock-in, because
there is nothing holding you to one vendor.

```console
$ export OPENROUTER_API_KEY=...
$ veyyon --model openrouter/anthropic/claude-sonnet-4
```

## Comparison guidance: how to choose

Use this as a starting heuristic, not a benchmark claim. Always verify against your own tasks.

| Priority | Prefer | Why |
| --- | --- | --- |
| Strongest agentic coding / tool use | Frontier hosted model you already trust | Best first-attempt edits and planning on hard refactors |
| Cost of long sessions | Cheaper model for the subagent and compaction slots | Keeps interactive quality; shrinks background spend |
| Latency / iteration speed | Fast local or flash-tier cloud model | Tight edit-test loops; hashline recovery still helps weaker models |
| Air-gapped / private code | Ollama or LM Studio | Keys and weights stay on your machine |
| CI automation | Stable mid-tier cloud id pinned with `--model` | Predictable cost; pair with `--approval-mode auto-edit` |
| Mixed team | Strong interactive model + a cheaper subagent model | Reviewer stays strong while workers stay cheap |

Rough capability vs cost/latency trade-off:

```text
capability
    ^
    |  frontier hosted
    |        *
    |              mid-tier hosted
    |                   *
    |                        local 30B+
    |                             *
    |                                  small local / flash
    |                                       *
    +----------------------------------------> cost / latency
         (pay more / wait more)     (cheap / fast)
```

Pin models explicitly in CI and shared profiles (`--model`, `modelRoles`). Floating "latest" aliases
are convenient interactively and risky in automation.

## Where to go next

- [Configuring providers](./configuring-providers.md) — full copy-paste setups.
- [Model contract](../concepts/model-contract.md) — harness vs provider boundary.
- [Getting started](./getting-started.md) — first key and first task.
- [Configuration](./configuration.md) — model defaults and overrides.
- [Authentication](./authentication.md) — login, logout, secret storage.
