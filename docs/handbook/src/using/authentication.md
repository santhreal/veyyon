# Signing in

Veyyon authenticates to whichever provider you point it at and calls provider APIs directly with keys
you supply. Optional OpenTelemetry export runs only when `OTEL_EXPORTER_OTLP_*` is configured. Logins
are **provider-scoped**: authenticating `anthropic` does not authenticate `openai`, and each provider
tracks its own credentials.

## Sign in from the TUI

Use the interactive slash commands inside a session:

- `/login`: opens the OAuth/key selector.
- `/login <provider>`: jumps straight to one provider, e.g. `/login anthropic`, `/login openai`.
- `/login <redirect-url>`: completes an OAuth flow that needs a pasted callback URL.
- `/logout`: opens the provider selector to remove stored credentials.

On first run, the first-run setup (`veyyon setup`, or `/setup` / `/providers` later) walks the same flow.

## Headless and remote hosts

For CI, servers, or a shared team credential store, use the auth broker from the shell:

```console
$ veyyon auth-broker login <provider>
$ veyyon auth-broker status
$ veyyon auth-broker list
$ veyyon auth-broker logout
```

`import` and `migrate` are also available. See [Providers](../models/providers.md) and `docs/secrets.md`
for the broker model.

## Using an environment variable instead

Every provider reads one or more environment variables, so a key already exported in your shell (or in
a `.env` file) is used without an interactive sign-in.

| Provider | Environment variable |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` (or `ANTHROPIC_OAUTH_TOKEN`) |
| `google` | `GEMINI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |

The full provider → variable map lives in [Providers](../models/providers.md). `.env` files are loaded
from `<cwd>/.env`, `~/.veyyon/profiles/default/agent/.env`, `~/.veyyon/.env`, and `~/.env`, with earlier sources winning.

## How keys are resolved

When a provider needs a key, Veyyon resolves it in order (first match wins):

1. A runtime `--api-key` for the current process (never persisted).
2. A `models.yml` `apiKey` on a custom provider.
3. A stored API key in the auth store.
4. A stored OAuth credential (refreshed as needed).
5. The provider's environment variable (including `.env`).

Stored credentials live in the auth store at `~/.veyyon/profiles/default/agent/agent.db` (or the configured auth-broker
snapshot in broker mode). `VEYYON_CODING_AGENT_DIR` relocates the agent base, and the auth store moves with
it.

## Provider data is data-driven

Provider identity (display name, env var, OAuth parameters) and endpoints (base URL, API kind) come
from the bundled model catalog plus your `~/.veyyon/profiles/default/agent/models.yml`. A new BYOK provider becomes
selectable by adding a `providers:` entry, not by changing code. See
[Configuring providers](./configuring-providers.md) and `docs/providers.md`.

See also: [Models and providers](./models.md) and the [CLI reference](../reference/cli.md).
