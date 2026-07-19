# File locations

Everything Veyyon stores lives under the config home, `~/.veyyon` by default on every platform.
Override the directory name with `VEYYON_CONFIG_DIR`;
on Linux/macOS the XDG layout is available after `veyyon config init-xdg`.

## The config home (`~/.veyyon/`)

The root itself holds only **global, cross-profile** state. Everything else is per-profile:

| Path | Contents |
| --- | --- |
| `config.yml` | **Global** settings that apply across profiles, today `defaultProfile` (which profile a bare `vey` launches). Not to be confused with a profile's own `config.yml` (below). |
| `install-id` | Persistent per-install UUID. Shared by every profile. |
| `profiles/` | One directory per profile, including `profiles/default/`, see below. |

## Profiles (`~/.veyyon/profiles/<name>/`)

Every profile, including `default`, is a directory under `profiles/` with the same shape.
A profile owns two layers:

**Profile root** (`profiles/<name>/`), operational state:

| Path | Contents |
| --- | --- |
| `logs/` | Log files (`veyyon.YYYY-MM-DD.log`). |
| `plugins/` | Installed plugins (`node_modules/`, manifest, lockfile). |
| `wt/` | Agent-managed git worktrees (PR checkouts, task isolation). |
| `cache/` | Caches: GitHub view cache, fastembed models, auth-broker snapshot. |
| `natives/`, `puppeteer/`, `python-env/` | Downloaded native binaries, Puppeteer browser cache, managed Python venv. |
| `stats.db`, `autoqa.db`, `gpu_cache.json` | Usage stats, auto-QA state, GPU probe cache. |
| `reports/`, `remote/`, `remote-host/`, `ssh-control/`, `autoresearch/` | Reports, remote mounts, SSH control sockets, autoresearch state. |

**Agent dir** (`profiles/<name>/agent/`), identity and conversation state:

| Path | Contents |
| --- | --- |
| `config.yml` | This profile's settings (`config.yaml` also accepted). See [Configuration](../using/configuration.md). |
| `agent.db` | Settings + auth storage (SQLite). |
| `sessions/` | Saved session transcripts, one per thread. |
| `blobs/` | Content-addressed attachment/blob store. |
| `history.db`, `models.db` | Composer history, model cache. |
| `skills/`, `commands/`, `prompts/`, `tools/`, `themes/`, `modules/` | Skills, slash commands, prompt templates, custom tools, themes, Python modules. |
| `mcp.json`, `ssh.json` | MCP server and SSH target config. |
| `keybindings.yml` | This profile's keybindings (`keybindings.yaml` accepted; legacy `keybindings.json` migrates on load). |
| `SYSTEM.md`, `RULES.md`, `AGENTS.md` | User-level instruction files. |
| `memories/`, `terminal-sessions/` | Memory store, terminal session state. |
| `cache/` | Agent-scoped caches (tiny title models, document conversions). |

Overriding the agent dir directly (`VEYYON_CODING_AGENT_DIR`) applies to the default profile only;
a named profile always derives its own agent dir.

### Which profile launches

Resolution order for every `veyyon` / `vey` invocation:

1. `--profile <name>` on the command line.
2. `VEYYON_PROFILE`. An explicitly **empty**
   `VEYYON_PROFILE=` forces the `default` profile, bypassing step 3.
3. `defaultProfile` in the **global** `~/.veyyon/config.yml`: set it with
   `veyyon profile default <name>`.
4. The `default` profile.

The name `default` always addresses `profiles/default/` and cannot be removed.

### Legacy layout migration

Before this layout, the default profile lived bare in the config root (`~/.veyyon/agent/`,
`~/.veyyon/logs/`, …). On first launch Veyyon migrates that state into `profiles/default/`
once, and refuses to guess if both layouts are present, the error names the exact
directories to reconcile.

## Credential storage

Auth tokens live in the profile's `agent.db` (or the OS keyring, depending on the configured
credential store). BYOK provider keys never land in plaintext `config.yml`; see
[Signing in](../using/authentication.md).

## Project-local files

Alongside your project (not under the config home):

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Project instructions Veyyon auto-loads. See [AGENTS.md](../using/extending.md). |
| `.veyyon/` | Optional per-project overrides and data (`mcp.json`, `ssh.json`, `modules/`, `prompts/`). Follows the working directory, never profile-scoped. |
