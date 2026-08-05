# File locations

Everything Veyyon stores lives under the config home, `~/.veyyon` by default on every platform.
Override the directory name with `VEYYON_CONFIG_DIR`;
on Linux/macOS the XDG layout is available after `veyyon config init-xdg`.

## The config home (`~/.veyyon/`)

The root itself holds only **global, cross-profile** state. Everything else is per-profile:

| Path | Contents |
| --- | --- |
| `config.yml` | **Global** settings that apply across profiles: `defaultProfile` (which profile a bare `veyyon` launches), `profileSharing`, and the auth-broker keys `authBrokerUrl` / `authBrokerToken`. Not to be confused with a profile's own `config.yml` (below). |
| `shared-auth/` | Shared credential store, used when `profileSharing` is on: `agent.db` (SQLite OAuth/API-key storage shared across profiles). |
| `AGENTS.md` | **Global** instructions loaded into every profile's session. Veyyon creates it on first run with a stripped-before-load guidance header. Keep profile-specific rules in the profile's own `AGENTS.md` (below). See [Instruction layers](../features/skills.md#instruction-layers). |
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
| `AGENTS.md` | Profile-specific context appended to the assembled prompt. |
| `RULES.md` | Sticky profile rules reattached near each turn. |
| `TITLE_SYSTEM.md` | Optional system prompt for automatic session-title calls. |
| `PROMPT_SECTIONS/` | Persistent replacements or additions for named assembled-prompt sections. |
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
| `AGENTS.md` / `CLAUDE.md` | Project instructions Veyyon auto-loads. These are the only configuration-shaped files a repository contributes. See [AGENTS.md](../using/extending.md). |
| `.veyyon/` | Project-scoped data that follows the working directory: prompt templates (`prompts/`), personalities (`personalities/`), the project secret vault, and project-scope plugin installs. Settings, MCP servers, rules, hooks, tools, commands, skills, and agents are never read from it, because a checked-in file must not configure the agent. |
