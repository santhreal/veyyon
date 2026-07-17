# Feature flags

> **Spec — not shipped:** a standalone `veyyon features` subcommand, the `--enable-feature` /
> `--disable-feature` launch flags, and a `[features]` config table. Today feature listing is a
> **`plugin`** subcommand — `veyyon plugin features` — experimental toggles are driven from
> `/experimental` in the TUI, and persistent toggles live in the `features` map of `config.yml`.

Veyyon gates optional and in-progress capabilities behind named feature flags. A flag lets
you turn a capability on or off without a new build, and it lets the project ship a
capability in stages before it becomes a default. Each flag has a stage that tells you how
finished it is.

| Stage | Meaning |
| --- | --- |
| `under development` | Incomplete; on only for development. |
| `experimental` | Usable but may change; off by default. |
| `stable` | Finished and on by default (unless noted). |
| `deprecated` | Still works but slated for removal. |
| `removed` | No longer available; the flag is inert. |

## Listing and toggling

`veyyon plugin features` prints every known feature with its stage and whether it is
currently enabled for your configuration. That list is **broader than the product surface**:
many entries are internal switches used for migrations, protocol experiments, or staged
rollout. Treat most of them as engineering cruft unless this page (or `/experimental`)
presents them as user-facing.

```console
$ veyyon plugin features
```

Persistent toggles write the `features` config map:

```yaml
features:
  memories: true
  prevent_idle_sleep: true
```

For a single run, override the config value with `-c features.<name>=true|false`:

```console
$ veyyon -c features.memories=true "summarize prior decisions in this repo"
```

Inside the cockpit, `/experimental` opens a view for experimental toggles on the running
session. Persistent changes belong in the `features` config map.

Unknown feature keys are rejected rather than silently accepted.

## User-facing toggles

Documented here: flags operators and end users actually turn for product behavior. Omit
the long tail of internal keys (`item_ids`, `deferred_executor`, removed protocol shims,
sandbox migration leftovers, and similar). If `veyyon plugin features` shows a name that is
not below, assume it is internal unless a release note says otherwise.

### Session intelligence

| Key | Stage | Default | What it does |
| --- | --- | --- | --- |
| `memories` | experimental | off | Generate and reuse cross-session memories (`/memories`, `[memories]`). |
| `goals` | stable | on | Long-running goal tracking (`/goal`, goal tools). |
| `workspace_dependencies` | stable | on | Scan Cargo/Rust workspace roots for extra project context. |
| `personality` | stable | on | Personality / tone controls in the product UI. |
| `fast_mode` | stable | on | Fast-mode collaboration preset. |
| `mentions_v2` | stable | on | Updated @-mention behavior in the cockpit. |

### Automation and tools

| Key | Stage | Default | What it does |
| --- | --- | --- | --- |
| `hooks` | stable | on | Lifecycle hooks (`[hooks]` / `hooks.json`). |
| `unified_exec` | stable | on (non-Windows) | Unified exec path for shell tool runs. |
| `shell_tool` | stable | on | Expose the shell tool surface. |
| `skill_mcp_dependency_install` | stable | on | Assist installing MCP dependencies declared by skills. |
| `tool_suggest` | stable | on | Suggest tools when the model may need them. |
| `sleep_tool` | under development | off | Model-callable `sleep` (input-interruptible). |

> **Spec — not shipped:** there is no `guardian_approval` flag and no guardian / auto-review
> approval path in the shipped flag registry or config schema. See
> [Auto-review guardian (Spec — not shipped)](./review.md#auto-review-guardian-spec--not-shipped).

### Apps, plugins, and collaboration

| Key | Stage | Default | What it does |
| --- | --- | --- | --- |
| `apps` | stable | on | Apps / connectors surface. |
| `plugins` | stable | on | Plugin loading and management. |
| `plugin_sharing` | stable | on | Share / distribute plugins. |
| `multi_agent` | stable | on | Multi-agent collaboration runtime. |
| `multi_agent_v2` | under development | off | Next multi-agent runtime and role-model overrides. |
| `enable_mcp_apps` | under development | off | MCP-backed apps path. |

### Browser, media, and realtime

| Key | Stage | Default | What it does |
| --- | --- | --- | --- |
| `in_app_browser` | stable | on | In-app browser surface (requirements may still apply). |
| `browser_use` | stable | on | Browser-use tool path. |
| `browser_use_external` | stable | on | External browser-use variant. |
| `computer_use` | stable | on | Computer-use tool path. |
| `image_generation` | stable | on | Image generation tools. |
| `realtime_conversation` | under development | off | Experimental realtime voice conversation in the TUI. |
| `prevent_idle_sleep` | experimental (platform-gated) | off | Keep the machine awake while a thread runs (`/experimental`). |

### Network and auth storage

| Key | Stage | Default | What it does |
| --- | --- | --- | --- |
| `network_proxy` | experimental | off | Extra network proxy restrictions for sandboxed sessions that already have network; enable from `/experimental` and restart. |
| `secret_auth_storage` | stable | on for Windows | Prefer secret/auth storage backend wiring for credentials. |
| `enable_request_compression` | stable | on | Compress outbound provider requests when supported. |
| `tool_call_mcp_elicitation` | stable | on | MCP elicitation during tool calls. |

### Deprecated (still toggles, avoid new dependence)

| Key | Notes |
| --- | --- |
| `web_search_request` / `web_search_cached` | Deprecated web-search wiring; prefer current search docs. |
| `use_legacy_landlock` | Deprecated Linux sandbox path; leave off unless you are debugging a migration. |

## What not to document as a product feature

`veyyon plugin features` also surfaces removed or under-development keys that are not product
features: protocol experiments (`responses_websockets*`, `item_ids`),
removed sandboxes (`experimental_windows_sandbox`, `use_linux_sandbox_bwrap`), dead tool
search shims, and similar. Enabling them will not give you a supported workflow. Prefer
this page, `/experimental`, and release notes over raw enum archaeology.

See also: [Configuration](../using/configuration.md) for the `features` config map and
[Slash commands](../reference/slash-commands.md).
