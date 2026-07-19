<p align="center">
  <img src="assets/icon.svg" width="72" height="72" alt="Veyyon">
</p>

<p align="center">
  <strong style="font-size: 2.5em; letter-spacing: 0.08em;">Veyyon</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@veyyon/coding-agent"><img src="https://img.shields.io/npm/v/@veyyon/coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/santhreal/veyyon/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/santhreal/veyyon/actions"><img src="https://img.shields.io/github/actions/workflow/status/santhreal/veyyon/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/santhreal/veyyon/blob/main/LICENSE"><img src="https://img.shields.io/github/license/santhreal/veyyon?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  <em>The coding agent that lives in your terminal.</em>
</p>

<p align="center">
  <img src="assets/demo-hero.gif" width="840" alt="Veyyon TUI booting into the ember-sun splash with the composer ready">
</p>

Terminal coding agent (CLI/TUI). Hashline edits, multi-provider catalog, local credentials, Rust natives on hot paths.

Multi-provider catalog · 31 registered built-in tools (plus optional/gated tools) · LSP/DAP · Rust natives (`@veyyon/natives`).

## Install

**npm / Bun (recommended)**

```sh
bun install -g @veyyon/coding-agent
```

First interactive `veyyon` opens the first-run setup (providers, glyphs, theme). Re-run with `veyyon setup`.

**From source**

```sh
bun setup
bun dev
```

`bun setup` installs workspace dependencies and builds `@veyyon/natives`. Re-run `bun run build:native` after changing Rust crates.

Config and state live under `~/.veyyon` by default.

macOS · Linux · Windows · bun ≥ 1.3.14

### Shell completions

`veyyon` generates completion scripts for **bash**, **zsh**, and **fish** from live command/flag metadata. Subcommands, flags, and enum values complete statically; model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog and `--resume` against on-disk sessions.

```sh
# zsh: add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(veyyon completions zsh)"

# bash: add to ~/.bashrc
eval "$(veyyon completions bash)"

# fish
veyyon completions fish > ~/.config/fish/completions/veyyon.fish
```

## Why the harness matters

Same model weights, different harness (edit format, tool surface), different outcomes. Veyyon leans on this: hashline edits instead of `str_replace`, summarized `read`, in-process search, LSP, and per-model prompt assembly all shift how reliably a model lands a change. Details: handbook [Mechanisms](docs/handbook/src/why/innovations.md).

## Features

### 01 · Code execution with tool-calling

Persistent Python and Bun eval kernels can call agent tools (read, grep, task, …) over a loopback bridge in one session.

<p align="center">
  <img src="assets/demo-ask.gif" width="820" alt="Asking about a file: Veyyon calls the read tool and answers grounded in the source">
</p>

### 02 · LSP

Rename and related ops go through the language server (including `workspace/willRenameFiles` where supported) so dependent files update with the edit.

### 03 · Debugger (DAP)

Attach via DAP backends (lldb, dlv, debugpy, and others configured for the project) to step, inspect frames, and evaluate.

### 04 · Time-traveling stream rules (TTSR)

Regex rules can abort a stream mid-token, inject a system reminder, and retry. Injections can survive compaction.

### 05 · Subagents

The `task` tool fans out into optional isolated worktrees; workers use their own tool surface and can return schema-validated results to the parent.

### 06 · Advisor role

A second model (advisor role) can read each main-agent turn and inject notes into the session on its own context.

### 07 · Collab

`/collab` publishes a session on a relay (link/QR). Peers join with `veyyon join` or a browser view. Frames are sealed client-side.

### 08 · web_search and remote read

`web_search` ranks providers; `read` accepts URLs (including PDFs) and returns structured markdown for use like local files.

### 09 · In-process tools

Search/glob/find run in-process via natives; shell uses brush with session continuity. One binary for macOS, Linux, and Windows.

### 10 · `/review`

Interactive code review over branches, commits, or uncommitted work; findings ranked with confidence scores in-session.

### 11 · Hashline

Edits reference content-hash anchors from prior reads instead of retyping surrounding lines. Stale anchors fail verification before write.

<p align="center">
  <img src="assets/demo-edit.gif" width="820" alt="A hashline edit landing: read, anchored diff, and a verified write to src/utils.ts">
</p>

### 12 · Unified read surface

`read` covers filesystem paths and internal/URL resources (including PR-shaped paths where configured) under one tool interface.

### 13 · Memory

Backends such as mnemopi retain and recall project-scoped facts across sessions when enabled.

### 14 · ACP

`veyyon acp` runs as an Agent Client Protocol server for editors (for example Zed) with the same tool loop and approval gates.

### 15 · Foreign-tool discovery

With discovery enabled (default), Veyyon loads context, skills, rules, and MCP from common on-disk layouts (Claude, Codex, Cursor, Gemini, OpenCode, and related paths) without converting them first. Disable with `discovery.importForeignConfig: false`.

### 16 · `veyyon commit`

`veyyon commit` inspects the working tree (`git_overview`, `git_file_diff`, `git_hunk`), groups changes into dependency-ordered atomic commits, and rejects cycles before writing. Lock files are excluded from analysis.

### 17 · Internal URL schemes

FS-shaped tools accept internal schemes such as `pr://`, `issue://`, `agent://`, `skill://`, `rule://`, and `conflict://` with the same call shapes as filesystem paths (for example `read pr://1428`, `agent://<id>/findings.0.path`).

### 18 · Merge conflicts

Conflict hunks are addressable as `conflict://N` (or `conflict://*`). Writing `@theirs`, `@ours`, or `@base` selects a side.

### 19 · `ast_edit` + `resolve`

`ast_edit` stages structural rewrites (ast-grep) and returns a proposed preview. `resolve` accepts or rejects; accepted applies are atomic.

### 20 · Browser

`browser` drives headless Chromium (Puppeteer) or a CDP-attached target. Default settings reduce automation fingerprints.

## Built-in tools

Tools share the agent registry with `read` and `bash`. Restrict the exposed set with `--tools read,edit,bash,…`. Hidden tools remain indexed for `search_tool_bm25` when `tools.discoveryMode` allows discovery.

**Files and search**

- `read`: files, dirs, archives, SQLite, PDFs, notebooks, URLs, internal schemes
- `write`: create or overwrite a file, archive entry, or SQLite row
- `edit`: hashline patches with content-hash anchors
- `ast_edit` / `ast_grep`: structural rewrite preview and queries
- `grep` / `glob`: content regex and path globs

**Runtime**

- `bash`: shell (optional PTY / background jobs)
- `eval`: persistent Python/JS cells
- `ssh`: remote host command

**Code intelligence**

- `lsp`: diagnostics, navigation, symbols, renames, code actions
- `debug`: DAP session control

**Coordination**

- `task`: subagents (optional workspace isolation)
- `irc`: inter-agent messages in-process
- `todo` / `job` / `ask`: list, background jobs, interactive questions

**External and media**

- `browser` / `web_search` / `github`
- `generate_image` / `inspect_image` / `tts`

**Memory and state**

- `checkpoint` / `rewind`
- `retain` / `recall` / `reflect` (Hindsight bank when that backend is active)

**Misc**

- `resolve`: apply or discard a queued preview action.
- `search_tool_bm25`: BM25 over the hidden tool index; activates top matches mid-session.

Setting-gated, off by default: `github`, `inspect_image`, `tts`, `checkpoint`, `rewind`, `search_tool_bm25`, `retain`, `recall`, `reflect`. Flip them on once, scoped per project.

[Tools reference →](packages/coding-agent/README.md)

## Providers and model selection

- **Interactive model:** `/model` or `--model`; persisted as `modelRoles.default`.
- **Roles:** `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor` (plus custom names). Assign in `modelRoles` or settings → Model → Roles. Launch pins: `--smol`, `--slow`, `--plan`.
- **Overrides:** `subagent.model`, `compaction.model` (else inherit interactive).
- **Cycle:** `cycleOrder` (default `smol`, `slow`); keybinding `app.model.cycleForward` (often Ctrl+P).

See [Models, roles, and profiles](docs/handbook/src/using/roles-and-profiles.md).

Auth tags below: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional.

### Hosted APIs

Direct APIs and gateways. Mix providers per role.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Antigravity `oauth` · xAI · Mistral · Groq · Cerebras · Fireworks · Together · Hugging Face · NVIDIA · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless · Perplexity `oauth`

### Coding plans

Subscription-routed. `/login` attaches the session.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal · Z.AI / GLM Coding Plan `plan` · Xiaomi MiMo · Qianfan · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Run it yourself

OpenAI-compatible `/v1/models`. Local instances skip the key.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### Routing settings

- **Custom providers**: OpenAI-compatible and other API kinds in `~/.veyyon/profiles/default/agent/models.yml` (`openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`, …).
- **Fallback chains**: `retry.fallbackChains` (per role or model). On 429/quota failure the next entry continues the turn; primary returns after cooldown.
- **Path-scoped models**: `enabledModels` / `disabledProviders` with a `path:` prefix for repo-local sets.
- **Round-robin credentials**: Multiple API keys per provider with session affinity and per-credential backoff.

Provider and routing settings: `~/.veyyon/profiles/default/agent/models.yml` (see `packages/coding-agent` docs).

## Web search

`web_search` is a built-in tool. Mode `auto` walks the configured provider chain; pin a single provider id when desired. Site-aware extraction turns selected hosts into structured markdown.

### Search providers

Providers (pin one, or `auto`):

| provider     | auth                   |
| ------------ | ---------------------- |
| `auto`       | chain                  |
| `perplexity` | `PERPLEXITY_API_KEY`   |
| `gemini`     | oauth                  |
| `anthropic`  | oauth                  |
| `codex`      | oauth                  |
| `xai`        | `XAI_API_KEY`          |
| `zai`        | `ZAI_API_KEY`          |
| `exa`        | `EXA_API_KEY` (or mcp) |
| `tinyfish`   | `TINYFISH_API_KEY`     |
| `jina`       | `JINA_API_KEY`         |
| `kagi`       | `KAGI_API_KEY`         |
| `tavily`     | `TAVILY_API_KEY`       |
| `firecrawl`  | `FIRECRAWL_API_KEY`    |
| `brave`      | `BRAVE_API_KEY`        |
| `kimi`       | `MOONSHOT_API_KEY`     |
| `parallel`   | `PARALLEL_API_KEY`     |
| `synthetic`  | `SYNTHETIC_API_KEY`    |
| `searxng`    | self-hosted            |
| `duckduckgo` | no key                 |
| `bing`       | no key                 |
| `yahoo`      | no key                 |
| `startpage`  | no key                 |
| `google`     | no key (browser)       |
| `ecosia`     | no key (browser)       |
| `mojeek`     | no key (browser)       |
| `public`     | no key (all of the above, consolidated) |

### Specialized handlers

Host-specific extraction for:

- **Code hosts**: github, gitlab
- **Package registries**: npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research**: arxiv, semantic scholar
- **Forums**: stack overflow, reddit, hn
- **Docs**: mdn, readthedocs, docs.rs

### Security databases

- **NVD**: national vulnerability database
- **OSV**: open source vuln feed
- **CISA KEV**: known exploited vulns

[`web_search` source](packages/coding-agent/src/web/search/index.ts)

## Rust natives (`@veyyon/natives`)

Four crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, image decode, and BPE counting run in-process on the libuv pool.

- Crates: `veyyon-natives`, `veyyon-shell`, `veyyon-ast`, `veyyon-iso`
- Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`

The table below is a per-module breakdown that intentionally omits glue and tests.

| Module     | What it does                                                                         | Powered by                                |  ~LoC |
| ---------- | ------------------------------------------------------------------------------------ | ----------------------------------------- | ----: |
| shell      | Embedded bash · persistent sessions · timeout/abort · custom builtins                | brush-shell (vendored)                    | 3,700 |
| grep       | Regex search · parallel/sequential · glob & type filters · fuzzy find                | grep-regex · grep-searcher                | 1,900 |
| keys       | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup                | phf                                       | 1,490 |
| text       | ANSI-aware width · truncation · column slicing · SGR-preserving wrap                 | unicode-width · segmentation              | 1,450 |
| summary    | Tree-sitter structural source summaries with elision controls                        | tree-sitter · ast-grep-core               | 1,040 |
| ast        | ast-grep pattern matching and structural rewrites                                    | ast-grep-core                             | 1,000 |
| fs_cache   | Mtime-keyed file cache shared by read · grep · lsp                                   | in-tree                                   |   840 |
| highlight  | Syntax highlighting · 11 semantic categories · 30+ aliases                           | syntect                                   |   470 |
| pty        | Native PTY allocation for sudo · ssh interactive prompts                             | portable-pty                              |   455 |
| glob       | Discovery with glob · type filters · mtime sort · gitignore respect                  | ignore · globset                          |   410 |
| workspace  | Workspace walker with gitignore + AGENTS.md discovery in one pass                    | ignore                                    |   385 |
| appearance | Mode 2031 + native macOS dark/light via CoreFoundation FFI                           | core-foundation                           |   270 |
| power      | macOS power-assertion API for idle/system/display-sleep prevention                   | IOKit FFI                                 |   270 |
| task       | Blocking work on libuv thread pool · cancellation · timeout · profiling              | tokio · napi                              |   260 |
| fd         | Filesystem walker for find-tool replacement                                          | ignore                                    |   250 |
| iso        | Workspace isolation shim · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy | veyyon-iso (PAL)                              |   245 |
| prof       | Circular buffer profiler with folded-stack and SVG flamegraph output                 | inferno                                   |   240 |
| ps         | Cross-platform process-tree kill and descendant listing                              | libc · libproc · CreateToolhelp32Snapshot |   195 |
| clipboard  | Text copy and image read from system clipboard · no xclip/pbcopy                     | arboard                                   |    80 |
| tokens     | O200k / Cl100k BPE token counting · both tables embedded                             | tiktoken-rs                               |    65 |
| sixel      | Terminal image rendering · decode PNG · JPEG · WebP · GIF · resize · SIXEL encode    | icy_sixel · image                         |    55 |
| html       | HTML to Markdown with optional content cleaning                                      | html-to-markdown-rs                       |    50 |

## Entry points

Same engine, four hosts:

- **Interactive:** `veyyon` (TUI)
- **One-shot:** `veyyon -p` / `--print`
- **SDK:** embed in Node via `@veyyon/coding-agent`
- **RPC / ACP:** `veyyon --mode rpc` and `veyyon acp` over stdio

### Interactive TUI

Default surface. Tool calls render as cards; the `ask` tool shows a structured option picker. The same permission/ask surfaces can route over ACP when the client advertises them.

<p align="center">
  <img src="assets/demo-commands.gif" width="820" alt="Typing / opens the slash-command palette, filtering live to model and session commands">
</p>

### SDK: embed in Node

`@veyyon/coding-agent`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@veyyon/coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

### RPC: drive over stdio

`veyyon --mode rpc`

For non-Node embedders, or when you want process isolation. NDJSON commands in, response and event frames out. `--mode rpc-ui` adds tool cards, selectors, and dialogs as `extension_ui_request` frames the host must answer.

```
$ veyyon --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP: speak to editors

`veyyon acp`

The [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over JSON-RPC. When the editor advertises capabilities, tool I/O routes through it and writes are gated by `session/request_permission`.

| Veyyon tool                   | ACP route                           |
| ----------------------------- | ----------------------------------- |
| `bash`                        | `terminal/create + terminal/output` |
| `read`                        | `fs/read_text_file`                 |
| `write`                       | `fs/write_text_file`                |
| `edit, bash`                  | `session/request_permission`        |

SDK: `@veyyon/coding-agent` (see `packages/coding-agent`).

## Extending

Source and releases: [github.com/santhreal/veyyon](https://github.com/santhreal/veyyon).

- **Extensions**: TypeScript modules using the same tool, slash-command, hotkey, and TUI registration APIs as built-ins.
- **Discovery**: with foreign import enabled, loads rules/skills/MCP from common on-disk layouts (Claude, Cursor, Codex, Gemini, Windsurf, Cline, Copilot, VS Code, …).
- **Reload**: `/reload-plugins` after local edits; packages publish via npm or marketplaces.

Operator handbook: `docs/handbook/`.

---

## Development

### Getting started from source

Fresh clones need both workspace dependencies and the local Rust/N-API addon before the source CLI can start.

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds `@veyyon/natives`. Re-run `bun run build:native` after changing Rust crates or `packages/natives`.

For a non-interactive smoke check:

```sh
bun dev -- --version
```

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Monorepo Packages

| Package                                                   | Description                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| **[@veyyon/collab-web](packages/collab-web)**           | Browser guest client, mock host, and local relay for collab live sessions  |
| **[@veyyon/ai](packages/ai)**                        | Multi-provider LLM client with streaming and model/provider integration    |
| **[@veyyon/catalog](packages/catalog)**              | Model catalog: bundled model database, provider descriptors, and identity  |
| **[@veyyon/agent-core](packages/agent)**             | Agent runtime with tool calling and state management                       |
| **[@veyyon/coding-agent](packages/coding-agent)**    | Interactive coding agent CLI and SDK                                       |
| **[@veyyon/tui](packages/tui)**                      | Terminal UI library with differential rendering                            |
| **[@veyyon/natives](packages/natives)**              | N-API bindings for grep, shell, image, text, syntax highlighting, and more |
| **[@veyyon/stats](packages/stats)**                 | Local observability dashboard for AI usage statistics                      |
| **[@veyyon/utils](packages/utils)**                  | Shared utilities (logging, streams, dirs/env/process helpers)              |
| **[@veyyon/wire](packages/wire)**                    | Shared collab live-session protocol types and relay constants              |
| **[@veyyon/hashline](packages/hashline)**               | Line-anchored patch language and applier behind the `edit` tool            |
| **[@veyyon/mnemopi](packages/mnemopi)**              | Local SQLite memory engine for Veyyon agents                             |
| **[@veyyon/metaharness](packages/metaharness)**      | Experimentation / meta harness package                                     |
| **[@veyyon/snapcompact](packages/snapcompact)**         | Bitmap-frame context compression package and SQuAD eval suite              |
| **[@veyyon/swarm-extension](packages/swarm-extension)** | Swarm orchestration extension package                                      |

### Rust Crates

| Crate                                              | Description                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[veyyon-natives](crates/veyyon-natives)**                | Core Rust native addon (N-API `cdylib`) used by `@veyyon/natives`; aggregates the crates below |
| **[veyyon-shell](crates/veyyon-shell)**                    | Embedded shell / PTY / process management split out of `veyyon-natives` (wraps `brush-*`)               |
| **[veyyon-ast](crates/veyyon-ast)**                        | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[veyyon-iso](crates/veyyon-iso)**                        | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy          |
| **[brush-core](crates/vendor/brush-core)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[brush-builtins](crates/vendor/brush-builtins)** | Vendored bash builtins (cd, echo, test, printf, read, export, etc.)                                 |

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for contribution guidelines.

---

## License

MIT. See [LICENSE](LICENSE) for the full text and copyright notices.

Veyyon is a fork of oh-my-pi (MIT) and Pi, created by Mario Zechner and Can Bölük. Their copyright notices are retained in [LICENSE](LICENSE).

- [GitHub](https://github.com/santhreal/veyyon)
- [Changelog](https://github.com/santhreal/veyyon/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@veyyon/coding-agent)
- [MIT](https://github.com/santhreal/veyyon/blob/main/LICENSE)
