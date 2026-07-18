# Model contract

The terminal engine is provider and API agnostic. You choose an endpoint, choose a model when that
endpoint exposes model choice, provide the key, and Veyyon calls that API directly. The endpoint can be
a local server (Ollama, LM Studio), a direct provider API (OpenAI, Anthropic, Google), or any
OpenAI-compatible gateway.

This page is the contract between the harness and the model. For copy-paste provider setup, see
[Configuring providers](../using/configuring-providers.md). For model switching, see
[Models and providers](../using/models.md).

## The three things you bring

A BYOK (bring-your-own-key) run needs three facts:

| Fact | What it is | Where it lives |
| --- | --- | --- |
| **Endpoint** | Base URL and API kind | A built-in provider, or a custom provider under `providers:` in `~/.veyyon/profiles/default/agent/models.yml` |
| **Model** | The model id the endpoint understands | Pinned with `--model` / `/model`, or discovered from the provider |
| **Key** | Credential the endpoint accepts | A provider environment variable, `/login`, or a `models.yml` `apiKey` |

For BYOK providers, Veyyon calls the configured endpoint with your credentials (no hosted proxy required).
Optional OpenTelemetry export is separate and only when `OTEL_EXPORTER_OTLP_*` is set.

### Example shape

```yaml
# ~/.veyyon/profiles/default/agent/models.yml
providers:
  deepseek:
    baseUrl: https://api.deepseek.com
    api: openai-completions
    apiKey: DEEPSEEK_API_KEY   # env-var name or literal
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

## What the harness owns

These behaviors stay constant no matter which endpoint you point at:

- The workflow: read, edit, verify, stop when the work is done.
- Tool dispatch, argument handling, and edit verification through the **hashline** edit engine
  (with `apply_patch` / `patch` / `replace` available via `edit.mode`).
- Approval modes (`tools.approvalMode`) that gate which tool tiers run without asking.
- Context compaction, goal cards, session branching, and rollout persistence.
- Per-model prompt order and tool-form selection once a model (or API kind) is known.

Provider is configuration (endpoint, credentials, model id). Keep the same
commands.

## What the provider owns

The provider owns the wire protocol, auth scheme, model list, rate limits, and the tokens it returns.
Veyyon adapts to that surface through the provider's `api` kind:

- Chat-Completions-style endpoints (`api: openai-completions`) talk `/chat/completions`.
- Responses-style and native provider endpoints use their own request shape.
- Model ids come from the provider's discovery endpoint when discovery runs. There is no hardcoded
  allowlist for BYOK providers, and discovery returns an error; it does not invent an empty catalog on failure.

Everything beyond the built-in catalog is data in `models.yml` — see
[Providers](../models/providers.md) and [`docs/providers.md`](../../../providers.md).

## System prompts and tool schemas

Each turn the harness builds a request that includes:

1. **Base instructions** for the active model or backend (execution order, stop-when-green, format-neutral
   tool guidance). See [Execution-order prompts](../models/prompts.md).
2. **User and project instructions** (`AGENTS.md` / `SYSTEM.md` layers and any session steers).
3. **Tool schemas** the model is allowed to call on this turn (bash, edit/write, web search, MCP tools,
   skills, and so on), filtered by approval mode, `disallowed_tools`, and feature flags.
4. **Conversation context** for the active thread, possibly compacted.

The model is expected to call tools using the schemas it was given. When arguments are almost right but
malformed, hashline returns recovery hints so the model can retry inside the same turn budget.

### Freeform vs Function tools

Veyyon advertises the structured edit tool in one of two shapes. The payload (the patch or edit body) is
the same; only the transport differs.

| Form | How the model calls it | Typical API kind |
| --- | --- | --- |
| **Freeform** | A custom / grammar tool. The raw body is the tool payload (for example a full `*** Begin Patch` envelope). | Responses-style |
| **Function** | A JSON-schema function tool. Arguments are a JSON object (for example `{"input": "<envelope>"}`). | Chat Completions |

Default edit mode is **hashline** (`edit.mode: hashline`). When `edit.mode` is `apply_patch`, the
provider wire form is derived from the API kind by default; an optional catalog override can pin the
tool shape to `function`, `freeform`, or `none`. The Function form keeps structured edits available
on chat-wire endpoints (Ollama, LM Studio, DeepSeek, and similar). See [The hashline edit engine](../edit/engine.md)
for the default edit wire format.

## Harness vs provider: a clear split

```text
┌──────────────────────── harness (veyyon) ─────────────────────┐
│ session / turn loop                                           │
│ prompts, tool schemas, edit, approvals, compaction            │
└────────────────────────────┬──────────────────────────────────┘
                             │ HTTPS / local HTTP
                             ▼
┌──────────────────────── provider ─────────────────────────────┐
│ endpoint auth + model discovery + completions/responses       │
│ model weights, rate limits, provider-side refusals            │
└───────────────────────────────────────────────────────────────┘
```

If something fails, ask which side owns it:

- Config rejected at load, malformed `models.yml`, missing key → harness / your config.
- HTTP 401 / 429 / empty model list → provider or key.
- Patch applied but tests red → harness did its job; the change still needs work.
- Approval or execpolicy denial → permission model, not the model provider.

## Provider data at load time

For BYOK providers, model and provider entries are data in `models.yml`:

- A YAML or schema error makes the registry skip the custom file with an error message; it does not silently drop
  models.
- Custom providers are merged **alongside** the built-in catalog. A custom entry with the same id as an
  implicit local engine (`ollama`, `lm-studio`, `llama.cpp`) replaces that engine's discovery.
- Provider availability requires the id not be in `disabledProviders` **and** the provider be keyless or
  have resolvable credentials.

Malformed provider data fails at load. Silent fallback to a weaker provider is treated as a bug.

## Per-role models

The conversation model (`/model` or `--model`) is separate from background roles. Roles are configured
under `modelRoles`:

- `modelRoles.task` — default for spawned subagents unless an agent definition pins its own model.
- `modelRoles.tiny` (or `smol`) — lightweight background work (titles, memory, auto-thinking).

Precedence for subagents is explicit: an agent definition's own model pattern wins, otherwise
`modelRoles.task`, otherwise the conversation model. There is no silent blend. `/status` and
`veyyon plugin doctor` report the effective values. See
[Models and providers](../using/models.md#roles-optional).

## Automation note

For non-interactive runs, pass the prompt and pick an approval mode that matches your trust boundary:

```console
$ veyyon --approval-mode auto-edit "run the unit tests and fix failures"
```

Use `--yolo` (auto-approve everything) only in trusted automation, ideally in an externally isolated environment (Docker, a VM, a CI jail), since Veyyon does not sandbox the commands it runs.

## What stays constant

- Workflow shape: read, edit, verify, stop when done.
- Edit verification, approvals, and context handling are harness behavior.
- Provider is configuration: endpoint, credentials, and model id.

## Next

- [Configuring providers](../using/configuring-providers.md) — Ollama, LM Studio, Anthropic, and custom
  OpenAI-compatible endpoints.
- [Models and providers](../using/models.md) — choosing and switching models in a session.
- [Safety](../using/safety.md) — boundaries around tool use and model output.
- [Permission model](./permission-model.md) — the approval modes.
- [Signing in](../using/authentication.md) — interactive and env-var auth paths.
