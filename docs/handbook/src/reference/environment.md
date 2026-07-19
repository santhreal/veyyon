# Environment variables

This page covers the common operator surface: identity/profile selection, provider auth, and the
handful of `VEYYON_*` variables that are actually read by the runtime today. Veyyon also reads a large
number of `VEYYON_*` debug/behavior-toggle variables (timing, startup tracing, TUI flags, eval-runtime
toggles, and more) that are less common configuration. For the complete, code-grounded reference,
including every provider credential var, precedence chains, and internal toggles, see
[`docs/environment-variables.md`](../../../environment-variables.md).

## Location and identity

There is no `VEYYON_HOME`. The config directory **name** (not a full path) is overridable, and the
active profile is selected by its own variable:

| Variable | Purpose |
| --- | --- |
| `VEYYON_CONFIG_DIR` | Overrides the config directory **name** under `$HOME` (default `.veyyon`). Does not accept a full path. |
| `VEYYON_CODING_AGENT_DIR` | Full override for the agent directory (default `~/<config-dir-name>/profiles/<active-or-default>/agent`). |
| `VEYYON_PROFILE` | Selects the active named profile (`~/.veyyon/profiles/<name>/agent`). |
| `VEYYON_PACKAGE_DIR` | Override package directory for bundled assets (Nix/Guix). |
| `VEYYON_NO_PTY` | Set to `1` to disable PTY-based interactive bash. |
| `VEYYON_NO_TITLE` | Set to disable auto terminal-title updates. |
| `VEYYON_WORKTREE_DIR` | Absolute path for agent-managed git worktrees (default profile path `~/.veyyon/profiles/<name>/wt`; also settable via the `worktree.base` setting). `~` is expanded; a relative value is ignored. |
| `VEYYON_GITHUB_CACHE_DB` | Full path override for the GitHub view cache database (default `~/.veyyon/cache/github-cache.db`). |

On Linux, `veyyon config init-xdg` migrates state under `$XDG_DATA_HOME`/`$XDG_STATE_HOME`/`$XDG_CACHE_HOME`
when those are set; unmigrated installs stay under `~/.veyyon`. See
[`packages/utils/src/dirs.ts`](https://github.com/santhreal/veyyon/blob/main/packages/utils/src/dirs.ts).

There is no separate SQLite-state-directory override; state lives under the resolved agent directory
above.

## Authentication

Provider BYOK uses each provider's native key variable, there is no Veyyon-branded API key or access
token (a `VEYYON_API_KEY`/`VEYYON_ACCESS_TOKEN` legacy alias does not exist in the current runtime).
When a provider's key variable is set, it is used without an interactive sign-in. For providers with
OAuth (Anthropic, xAI, Qwen, Cursor, and others), the OAuth token variable takes precedence over the
plain API key, see the provider tables below and
[`docs/environment-variables.md`](../../../environment-variables.md#1-modelprovider-authentication).

OAuth sign-in itself is interactive: run `/login` inside the TUI (or `--provider <id>` at startup) to
open the OAuth selector. There is no `veyyon login --with-api-key`/`--with-access-token` CLI subcommand;
piping a key into a login command is not part of the shipped CLI surface.

## Provider keys

Each model provider reads its own standard key variable (or the name in
`[model_providers.<id>].env_key` for a custom provider). When set, it is used without an interactive
sign-in and wins over a stored key.

| Provider | Variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` (or `ANTHROPIC_OAUTH_TOKEN`, which takes precedence) |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |
| Z.AI | `ZAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| xAI | `XAI_API_KEY` (or `XAI_OAUTH_TOKEN`, which takes precedence for `xai-oauth`) |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Cursor | `CURSOR_ACCESS_TOKEN` |

A custom provider uses whatever variable its `[model_providers.<id>].env_key` names. See
[Configuration](../using/configuration.md) and the full provider table in
[`docs/environment-variables.md`](../../../environment-variables.md#1-modelprovider-authentication)
(30+ providers, cloud auth chains for Bedrock/Vertex/Azure, and web-search provider keys).

## Local and self-hosted providers

| Variable | Purpose |
| --- | --- |
| `OLLAMA_BASE_URL` / `OLLAMA_HOST` | Ollama discovery base URL (defaults to `http://127.0.0.1:11434`). |
| `LM_STUDIO_BASE_URL` | LM Studio discovery base URL (defaults to `http://127.0.0.1:1234/v1`). |
| `LLAMA_CPP_BASE_URL` | llama.cpp discovery base URL (defaults to `http://127.0.0.1:8080`). |
| `LITELLM_BASE_URL` | LiteLLM proxy base URL fallback (defaults to `http://localhost:4000/v1`). |
| `VEYYON_EDIT_VARIANT` | Force edit tool variant: `hashline`, `apply_patch`, `patch`, `replace`. |

There is no `VEYYON_OSS_BASE_URL`/`VEYYON_OSS_PORT`; each local backend has its own discovery variable
above.

## TLS and certificates

| Variable | Purpose |
| --- | --- |
| `NODE_EXTRA_CA_CERTS` | Extra CA bundle (path or inline PEM) merged into the trust root for every provider fetch (OpenAI-compatible, Codex, Ollama, Azure Responses, Google, Anthropic). |
| `CLAUDE_CODE_CLIENT_CERT` / `CLAUDE_CODE_CLIENT_KEY` | mTLS client certificate/key, used in Anthropic Foundry gateway mode (`CLAUDE_CODE_USE_FOUNDRY=1`). |

There is no `VEYYON_CA_CERTIFICATE` or `SSL_CERT_FILE` support; `NODE_EXTRA_CA_CERTS` is the real
override, honored across providers because Bun's `fetch` does not read it natively (Veyyon merges it
into `RequestInit.tls.ca` itself).

## Install and updates

| Variable | Purpose |
| --- | --- |
| `VEYYON_INSTALL_DIR` | Overrides the install script's target directory (default `~/.local/bin` on Unix, `%LOCALAPPDATA%\veyyon` on Windows). |

There is no `VEYYON_NON_INTERACTIVE` or `VEYYON_INSTALL_URL`; the install scripts (`scripts/install.sh`,
`scripts/install.ps1`) do not read those names today.

## MCP

Any MCP server names its own bearer-token secret via `[mcp_servers.<name>].bearer_token_env_var` in
`config.yml`, this points at *any* env var you choose (for example plain `GITHUB_PERSONAL_ACCESS_TOKEN`),
not a fixed `VEYYON_*` name. There is no `VEYYON_GITHUB_PERSONAL_ACCESS_TOKEN` or `VEYYON_CONNECTORS_TOKEN`
convention in the current runtime.

| Variable | Purpose |
| --- | --- |
| `VEYYON_MCP_TIMEOUT_MS` | Overrides the MCP client request timeout (ms) for every server; `0` disables client-side timeouts. Default `30000`. |

See [Configuration](../using/configuration.md) for `bearer_token_env_var` examples.

## Remote auth broker (optional)

Real, shipped `VEYYON_*` variables that switch credential resolution from local SQLite to a remote
broker host:

| Variable | Purpose |
| --- | --- |
| `VEYYON_AUTH_BROKER_URL` | Base URL of the remote auth-broker; selects broker mode. |
| `VEYYON_AUTH_BROKER_TOKEN` | Bearer token sent to the broker. |
| `VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS` | Freshness window (ms) for the encrypted local snapshot cache; default `3600000`. |
| `VEYYON_AUTH_BROKER_SNAPSHOT_CACHE` | Path to the encrypted local snapshot cache. |

Most installs never set these. Details: `docs/internal/auth-broker-gateway.md`.

## Repair

| Variable | Purpose |
| --- | --- |
| `VEYYON_REPAIR_DISABLE` | Truthy disables the shipped tool-call schema repair (see [Repair overview](../repair/overview.md)) at the tool-dispatch seam. |

There is no `VEYYON_REPAIR_LOG`, and Veyyon does not emit per-`(model,tool,shape)` repair telemetry.

## Terminal behavior

| Variable | Purpose |
| --- | --- |
| `NO_COLOR` | When set (to any value), Veyyon renders without color; hierarchy comes through emphasis, spacing, and glyphs instead. |
| `TERM` / `COLORTERM` | Read to detect terminal capabilities (truecolor, ANSI-256, ANSI-16) and pick the matching palette mapping. |
| `VEYYON_HARDWARE_CURSOR` | Truthy enables hardware cursor mode. |
| `VEYYON_TUI_WRITE_LOG` | When set, logs TUI writes to the given file (debugging). |

There is no `VEYYON_TUI_DISABLE_KEYBOARD_ENHANCEMENT`, `VEYYON_TUI_RECORD_SESSION`, or
`VEYYON_TUI_SESSION_LOG_PATH`; see
[`docs/environment-variables.md`](../../../environment-variables.md#9-tui-runtime-flags-shared-package-affects-coding-agent-ux)
for the real `VEYYON_*`-prefixed TUI flags.

## Removed / does not exist

| Name | Status |
| --- | --- |
| `VEYYON_HOME` | Never existed. Config location is `VEYYON_CONFIG_DIR` (dirname override) + optional XDG migration, not a single home-path variable. |
| `VEYYON_SQLITE_HOME` | Never existed. No separate SQLite-state override; state lives under the resolved agent directory. |
| `VEYYON_API_KEY` / `VEYYON_ACCESS_TOKEN` | Never existed as a Veyyon-branded credential; use each provider's native key variable. |
| `VEYYON_AUTHAPI_BASE_URL` | Never existed. The ChatGPT AuthAPI host used by personal-access-token whoami is not overridable via env today. |
| `VEYYON_APP_SERVER_LOGIN_ISSUER` | Belonged to the removed app-server daemon; no equivalent exists in this runtime. |
| `VEYYON_MANAGED_BY_NPM` / `VEYYON_MANAGED_BY_BUN` / `VEYYON_MANAGED_PACKAGE_ROOT` | Never existed. |
| `VEYYON_SANDBOX` / `VEYYON_SANDBOX_NETWORK_DISABLED` / `VEYYON_THREAD_ID` | Never existed under these names. |

Config values can also be overridden per run with `-c key=value`, which is usually clearer than an
environment variable; see the [CLI reference](./cli.md).
