# Environment variables

These are the environment variables you would set day to day. Veyyon also reads many internal
`VEYYON_*` variables for testing, CI, packaging, sandbox injection, and eval harnesses; those are
not part of the supported surface and are not listed here.

## Location and identity

| Variable | Purpose |
| --- | --- |
| `VEYYON_HOME` | Config and state home. Defaults to `~/.veyyon` on Unix and the Veyyon application directory on Windows. Holds `config.yml`, `auth.json`, sessions, logs, and the encrypted secrets store. |
| `VEYYON_SQLITE_HOME` | Directory for the SQLite state database. When set, Veyyon stores the SQLite state DB here instead of under `VEYYON_HOME`. This is the environment-side override for the `sqlite_home` config key. |

## Authentication

Provider BYOK uses provider-native key variables. There is no Veyyon-branded API key
(`VEYYON_API_KEY` was a legacy alias and has been removed).

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Primary provider BYOK key for OpenAI-compatible sign-in. When set, it is used without interactive login and wins over a stored key. |
| `OPENAI_ACCESS_TOKEN` | Provider access token (ChatGPT / PAT path). Prefer this name for new shells. |
| `VEYYON_ACCESS_TOKEN` | Legacy alias for the same access-token path as `OPENAI_ACCESS_TOKEN`. Still accepted; prefer the provider-native name. |

Pipe keys into login rather than putting them on the argv:

```shell
printenv OPENAI_API_KEY | veyyon login --with-api-key
printenv OPENAI_ACCESS_TOKEN | veyyon login --with-access-token
```

## Provider keys

Each model provider reads its own standard key variable (or the name in
`[model_providers.<id>].env_key`). When set, it is used without an interactive sign-in and wins over
a stored key.

| Provider | Variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |
| Z.AI | `ZAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google | `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |

A custom provider uses whatever variable its `[model_providers.<id>].env_key` names. See
[Configuration](../using/configuration.md).

## Catalog and local providers

| Variable | Purpose |
| --- | --- |
| `VEYYON_OSS_BASE_URL` | Base URL for local OSS providers (`ollama`, `lmstudio`). |
| `VEYYON_OSS_PORT` | Port when base URL unset. |
| `PI_EDIT_VARIANT` | Force edit tool variant: `hashline`, `apply_patch`, `patch`, `replace`. |

## TLS and certificates

| Variable | Purpose |
| --- | --- |
| `VEYYON_CA_CERTIFICATE` | Path to a PEM or DER file with one or more certificate blocks used as custom trust roots. Takes precedence over `SSL_CERT_FILE`. |
| `SSL_CERT_FILE` | Standard fallback custom-CA path when `VEYYON_CA_CERTIFICATE` is unset. |

`veyyon doctor` checks that these paths are readable certificate data; point them at a real file or unset
them to use system roots. See [Diagnostics and health](../features/doctor.md).

## ChatGPT auth overrides

These exist for the ChatGPT / OpenAI account login path (PAT whoami). They point at OpenAI AuthAPI
hosts, not a Veyyon-hosted cloud.

| Variable | Purpose |
| --- | --- |
| `VEYYON_AUTHAPI_BASE_URL` | Override for the ChatGPT AuthAPI base used by personal-access-token whoami. Defaults to `https://auth.openai.com/api/accounts`. |

## Install and updates

| Variable | Purpose |
| --- | --- |
| `VEYYON_NON_INTERACTIVE` | Set to `1`, `true`, or `yes` when running the install scripts so they skip prompts (used by the update-available install command). |

`VEYYON_INSTALL_URL` is an optional no-default HTTPS override for the unix auto-updater install script.
When unset the updater stays inert (it never phones a hard-coded host).
It is not a day-to-day interactive-TUI variable.

## MCP and connectors

| Variable | Purpose |
| --- | --- |
| `VEYYON_GITHUB_PERSONAL_ACCESS_TOKEN` | Conventional name for a GitHub personal access token when configuring GitHub MCP via `bearer_token_env_var` in `config.yml` (GitHub MCP does not support OAuth). |
| `VEYYON_CONNECTORS_TOKEN` | Bearer token env for the built-in apps/connectors MCP path when that integration is enabled. |

Any MCP server can name a different secret via `[mcp_servers.<name>].bearer_token_env_var`.

## Repair overrides (Spec — not shipped)

These variables are reserved for the planned schema-repair bridge. Unset in current Veyyon builds.

| Variable | Purpose |
| --- | --- |
| `VEYYON_REPAIR_DISABLE` | Disable repair when implemented |
| `VEYYON_REPAIR_LOG` | Repair telemetry log path |

Details: [Repair overview](../repair/overview.md).

## Terminal behavior

| Variable | Purpose |
| --- | --- |
| `NO_COLOR` | When set (to any value), Veyyon renders without color; the interface preserves hierarchy through emphasis, spacing, and glyphs. |
| `TERM` / `COLORTERM` | Read to detect terminal capabilities (truecolor, ANSI-256, ANSI-16) and pick the matching palette mapping. |
| `VEYYON_TUI_DISABLE_KEYBOARD_ENHANCEMENT` | Truthy disables crossterm keyboard-enhancement flags (useful on broken terminal stacks; also auto-detected for some WSL + VS Code setups). |
| `VEYYON_TUI_RECORD_SESSION` | Truthy enables TUI session input recording for debugging. |
| `VEYYON_TUI_SESSION_LOG_PATH` | Optional path for the session recording log when recording is enabled. |

## Descoped or non-day-to-day

| Name | Status |
| --- | --- |
| `VEYYON_API_KEY` | **Removed.** Legacy Veyyon-branded API-key alias; auth is provider-native keys only (`OPENAI_API_KEY`, and each provider's `env_key`). |
| `VEYYON_APP_SERVER_LOGIN_ISSUER` | Debug-only login-issuer override. Not a supported day-to-day variable. |
| `VEYYON_INSTALL_URL` | Optional auto-updater install-script override only (see Install and updates). |
| Packaging markers (`VEYYON_MANAGED_BY_NPM`, `VEYYON_MANAGED_BY_BUN`, `VEYYON_MANAGED_PACKAGE_ROOT`) | Set by installers; not something you normally export by hand. |
| Sandbox-injected vars (`VEYYON_SANDBOX`, `VEYYON_SANDBOX_NETWORK_DISABLED`, `VEYYON_THREAD_ID`, …) | Written by the runtime into sandboxed child processes; not user configuration. |

Config values can also be overridden per run with `-c key=value`, which is usually clearer than an
environment variable; see the [CLI reference](./cli.md).
