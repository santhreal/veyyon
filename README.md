<p align="center">
  <img src="assets/sun.svg" width="320" alt="Veyyon sun">
</p>

<p align="center">
  <strong style="font-size: 2.5em; letter-spacing: 0.08em;">Veyyon</strong>
</p>

<p align="center">
  <a href="https://github.com/santhreal/veyyon/releases/latest"><img src="https://img.shields.io/github/v/release/santhreal/veyyon?style=flat&colorA=222222&colorB=E05735&label=release" alt="Latest release"></a>
  <a href="https://github.com/santhreal/veyyon/blob/main/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/santhreal/veyyon/actions"><img src="https://img.shields.io/github/actions/workflow/status/santhreal/veyyon/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/santhreal/veyyon/blob/main/LICENSE"><img src="https://img.shields.io/github/license/santhreal/veyyon?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  <em>A coding agent with the whole workbench wired in.</em>
</p>

Veyyon runs in your terminal and treats the machinery around your code, the language server, the debugger, the shell, the browser, as tools it can call. The model weights are the same ones you get anywhere. The harness is what changes how reliably they land a change.

Multi-provider catalog · 34 built-in tools (more optional and gated) · LSP and DAP · Rust natives on every hot path · and a per-project shorthand the model writes in.

Veyyon started as a fork of oh-my-pi (MIT) on 17 July 2026 and has moved a long way since: **1,000+ commits**, a shorthand codec the model writes in, a credential and profile layer rebuilt on SQLite, compaction that drops duplicate bytes before it summarizes anything, and five new Rust crates under the natives addon. [What Veyyon adds](#what-veyyon-adds) is the specific list, item by item, with the code behind each one.

## Install it in one line

**Linux / macOS**

```sh
curl -fsSL https://get.veyyon.dev | sh
```

**Windows**

```powershell
irm https://veyyon.dev/install.ps1 | iex
```

This installs one self-contained binary for your OS and architecture and links a short `vey` command. The first interactive `vey` opens first-run setup (providers, glyphs, theme); run it again with `veyyon setup`.

To pin a Linux or macOS release binary:

```sh
curl -fsSL https://get.veyyon.dev | sh -s -- --binary --ref v1.0.12
```

To pin the same release on Windows:

```powershell
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Binary -Ref v1.0.12
```

A bare `--ref` on POSIX, or `-Ref` on Windows, builds that ref from a source checkout. See [Install](docs/handbook/src/using/install.md) for source, help, and uninstall forms on both platforms.

Veyyon ships two ways only: a prebuilt release binary served through veyyon.dev from [GitHub Releases](https://github.com/santhreal/veyyon/releases), or a source checkout you build yourself. The installers verify the published SHA-256 sidecar before replacing an installed binary. A checksum detects changed bytes; it is not a publisher signature. There is no npm package, Homebrew tap, or crates.io release.

**From source (contributing)**

```sh
git clone https://github.com/santhreal/veyyon.git && cd veyyon
bun setup
bun dev
```

`bun setup` installs workspace dependencies and builds `@veyyon/natives`. Re-run `bun run build:native` after changing Rust crates.

Config and state live under `~/.veyyon` by default.

Prebuilt install: macOS, Linux, or Windows, with no Bun runtime required. Source and development: Bun ≥ 1.3.14 plus Git.

### Shell completions

`veyyon` generates completion scripts for **bash**, **zsh**, **fish**, and **PowerShell** from live command and flag metadata. Subcommands, flags, and enum values complete statically; model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog and `--resume` against on-disk sessions.

```sh
# zsh: add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(veyyon completions zsh)"

# bash: add to ~/.bashrc
eval "$(veyyon completions bash)"

# fish
veyyon completions fish > ~/.config/fish/completions/veyyon.fish

# PowerShell: write the script beside your profile, then dot-source it from $PROFILE
veyyon completions powershell > $HOME\veyyon-completions.ps1
```

Add `--no-alias` to any of these if `vey` is already your own command: the
generated scripts complete both `veyyon` and `vey`, and that flag drops the
second binding.

PowerShell has no directory it autoloads completions from, so the script
registers itself when you run it. Add `. $HOME\veyyon-completions.ps1` to your
`$PROFILE` to load it in every session.

## The harness is the product

Give two harnesses the same model weights and you get different outcomes, because the edit format, the tool surface, and the way the prompt is assembled all change how reliably the model lands a change. Veyyon leans on that: hashline edits instead of `str_replace`, summarized `read`, in-process search, a real language server, and per-model prompt assembly. Details are in the handbook [Mechanisms](docs/handbook/src/why/innovations.md) chapter.

## What Veyyon adds

This section is the product-level map of Veyyon's changes after the oh-my-pi fork. It describes observable mechanisms, not every refactor or ported upstream fix. Use the generated root [changelog](CHANGELOG.md) for release-level detail and the [divergence ledger](docs/internal/porting-from-pi-mono.md#15-intentional-divergences) when reconciling upstream code.

### Prompt assembly that stays configurable

- **The default prompt is assembled, not copied from one prose file.** Statement modules own instruction text. A section registry owns section identity, order, and banners. The outer `system-prompt.md` file is a checked scaffold with one `{{templateSections}}` slot.
- **Persistent customization has two explicit surfaces.** Put project instructions in layered `AGENTS.md` files. Put a validated body-only section replacement in `PROMPT_SECTIONS/`. Veyyon does not discover `SYSTEM.md` or `APPEND_SYSTEM.md`; it names an existing legacy file at launch and points you to the supported replacement.
- **Prompt gates follow the live model.** Switching models recalculates inline tool descriptors and native-schema placement. A provider that already receives tool schemas does not pay for a second prompt inventory.
- **Project context moves as one unit.** `set_cwd` and `/move` reload the destination's `AGENTS.md`, workspace tree, repository context, skills, rules, secret scope, and TTSR matchers. A failed move restores the previous directory and runtime.
- **Repeated context is removed only when containment is exact.** A less-authoritative context file is omitted when its normalized paragraphs appear contiguously in a later authoritative file. Paraphrases and noncontiguous matches remain.

See [System prompt customization](docs/system-prompt-customization.md) and [Context files](docs/context-files.md).

### Compaction that preserves ownership and boundaries

- **A lossless first pass runs before summarization.** Tier 0 removes tool results that are byte-identical to a newer copy. Nothing is paraphrased in this pass.
- **Compaction can trigger automatically, at an absolute token count, or at a percentage.** The effective threshold is visible in the context panel and status line.
- **Summaries remain agent-owned context.** Compaction and branch summaries enter provider requests as `developer` context where the provider supports it. Image-bearing developer context is split without relabelling the text as a user turn.
- **Summary boundaries fail closed.** Aborted and empty completions are rejected, internal presentation wrappers are stripped, and legacy image-block summaries are wrapped through the same context template.
- **Oversized tool output spills to an artifact.** The transcript keeps a bounded preview and an address the agent can read back instead of silently losing the remainder.

See [Compaction and project memory](docs/handbook/src/context/compaction-memory.md).

### Model-native effort and explicit routing

- **Each model exposes its own effort variants.** A low/high Gemini model does not show medium or xhigh. Separate provider SKUs that represent effort tiers appear as one logical model and route to the correct upstream ID.
- **Effort precedence is explicit.** A session choice from `/thinking` wins, followed by a selector suffix, the active model's `defaultEffort` row, the `*` row, and finally the model default. Choosing **Default** clears the session override.
- **Compaction and subagents use ordered model chains.** You can edit or remove one highlighted position and append fallbacks without rebuilding the whole value. YAML list and comma-separated forms round-trip through the same schema.
- **Model settings stay responsive with large catalogs.** Static catalog projection and sorting are cached across picker openings while authentication badges are recalculated every time.
- **Roles remain separate from subsystem chains.** The interactive model is `modelRoles.default`; named roles cover work such as `smol`, `slow`, `vision`, `plan`, and `advisor`; `subagent.model` and `compaction.model` own their own chains.

<p align="center">
  <img src="assets/model-effort-controls.gif" width="900" alt="Model-native effort choices followed by highlighted-position model-chain editing">
</p>

See [Settings](docs/settings.md#models) and [Models, roles, and profiles](docs/handbook/src/using/roles-and-profiles.md).

### Secret use with a final outbound boundary

- **Provider credentials live in SQLite, not an `auth.json` lockfile.** You can configure several credentials per provider with session affinity, round-robin selection, and per-credential backoff.
- **Named working secrets live in an encrypted vault.** `/secret` adds, lists, extends, removes, and audits scoped entries without listing their values.
- **Obfuscation runs at the final provider seam.** When enabled, it rewrites nested JSON keys and values for every physical attempt, including retries, fallback models, compaction, evaluation, memory, TTS, and image tools. Key collisions and opaque authenticated fields fail closed.
- **Redaction outlives expansion.** An expired, removed, disabled, or out-of-scope value loses placeholder expansion rights but keeps a forward-redaction tombstone, so old text does not become provider-visible again.
- **Spending a real credential can require approval.** The prompt names the secret but never its value, and the audit log records where the placeholder was expanded. The `yolo` mode remains the explicit opt-out from all approval gates.
- **Malformed declarations stop startup.** An unreadable file, invalid entry, unsafe regex, wrong field, or too-short reversible value is reported with the fix instead of being skipped.

Secret protection is opt-in. Read [Secret obfuscation](docs/secrets.md) for scope, persistence, and the documented tool-output caveat.

### Profiles, sessions, and operator-visible failure

- **One sign-in reaches every profile.** Provider credentials and global settings are shared, while each profile keeps its own agent directory, instructions, skills, and optional working directory.
- **A new profile copies only `AGENTS.md` as instruction text.** Skills remain explicit profile data. Unreadable or wrong-shaped seed items abort creation with their source path.
- **Session files are shape-checked and written atomically.** Listing, loading, moving, and closing refuse states that would orphan or overwrite an unreachable transcript.
- **Deep subsystems report through session-scoped operator notices.** Prompt migration, secret-vault, filesystem, and runtime failures reach the active surface without leaking a notice sink into the next session.

See [Profiles](docs/handbook/src/features/profiles.md) and [Sessions](docs/handbook/src/using/sessions.md).

### Agents you can inspect and coordinate

- **Task and eval workers share the real tool surface.** They can return schema-validated results, communicate over IRC, and expose their transcripts through `agent://` and `history://`.
- **The Agent Control Center is a live operational view.** It shows the roster, model badges, age, status, transcript, and communications stream, with keyboard and mouse actions for opening or stopping a worker.
- **The dashboard remains readable without color.** Selection uses a reserved cursor column and active tabs use width-stable brackets in addition to tint and emphasis.
- **An advisor can review each completed turn.** It runs on its own context and can inject a concern or blocker without becoming the primary model.

See [Subagents](docs/handbook/src/features/subagents.md), [IRC](docs/tools/irc.md), and [Advisor](docs/advisor-watchdog.md).

### One tool and extension architecture

- **Capabilities have one registration surface.** `defineCapability`, `registerProvider`, and `loadCapability` replace parallel resource-loader and package-manager paths.
- **Built-in tools come from one registry.** `createTools(session)` constructs tools from `BUILTIN_TOOLS`, so activation, SDK embedding, and UI rendering share one inventory.
- **Extensions load through native Bun imports.** Tool schemas use the repository's TypeBox or Zod compatibility surface without loading a second TypeScript runtime.
- **Bash interception adds a hard approval boundary.** Configured destructive patterns can require approval even when ordinary shell commands are allowed.
- **LSP format-on-save writes through the same edit path.** A server's workspace edit is applied with the same stale-content and filesystem protections as an agent edit.
- **Clipboard access stays in-process.** Text and image clipboard operations route through `@veyyon/natives` rather than platform-specific shell commands.

### Native kernels shared across hot paths

The N-API addon delegates reusable behavior to focused Rust crates instead of letting each shell builtin or TypeScript caller define it again:

- **`veyyon-glob`** owns compiled glob matching and directory-depth bounds.
- **`veyyon-keys`** owns Kitty keyboard protocol parsing and key lookup.
- **`veyyon-text`** owns ANSI-aware width, truncation, and UTF-16 column slicing.
- **`veyyon-diff-kernel`** owns unified-diff line handling, comparison keys, hunk formatting, and binary detection.
- **`veyyon-grep-kernel`** owns search pattern compilation and searcher construction.
- **`veyyon-walker`** owns the native directory-read traversal path.

The complete crate inventory is in [Rust Crates](#rust-crates).

### Argot: project shorthand that expands before use

Argot is experimental and off by default. Veyyon generates a project dictionary that maps short handles to repeated paths, commands, and identifiers. The model can write `§dbconn`; Veyyon expands it before a tool, transcript, parent agent, or display receives it.

Encoding is gated by model and context size. Decoding always runs, including across streamed subagent deltas, so disabling new encoding does not permit an old handle to leak. The settings screen hides Argot's dependent controls until the master toggle is on. The codec lives in [`@veyyon/argot`](packages/argot), and the integration contract is in [Argot](docs/handbook/src/why/argot.md).

## What it can do

The product surface, as you meet it. Some of this is the base the fork was built on, some of it is the work above; the split is in [What Veyyon adds](#what-veyyon-adds) rather than repeated on every line here.

### 01 · The agent writes code that calls its own tools

Ask it to cross-reference two files and it does not grep twice and guess. Persistent Python and Bun eval kernels stay live across the session and call agent tools (`read`, `grep`, `task`, and the rest) over a loopback bridge, so one cell can read, transform, and act.

### 02 · Renames go through the language server, not find-and-replace

Ask for a rename and the dependent files move with it. Rename and related operations route through the language server (including `workspace/willRenameFiles` where the server supports it), so references update with the edit instead of drifting.

### 03 · It drives a real debugger

A binary segfaults, and the agent attaches over DAP, steps to the bad frame, and reads the values there. Backends (lldb, dlv, debugpy, and others configured for the project) let it step, inspect frames, and evaluate.

### 04 · Rules that wait for the model to go off-script

Your rules sit dormant until a regex matches mid-stream. Then Veyyon aborts the stream mid-token, injects a system reminder, and retries. These injections can survive compaction, so the correction keeps holding.

### 05 · Fan a job out to workers, get typed results back

Split a task with the `task` tool and each worker runs in its own optional isolated worktree with its own tool surface. Workers return schema-validated results to the parent, not free text you have to reparse.

### 06 · A second model, reading every turn

Pair a reviewer to the advisor role and it reads each main-agent turn on its own context, injecting notes into the session when the main agent starts to drift.

### 07 · Hand someone the link and they are in

`/collab` publishes your live session on a relay as a link or QR. Peers join with `veyyon join` or a browser view. Frames are sealed client-side.

### 08 · Read a PDF off arxiv like it is a local file

`read` accepts URLs, PDFs included, and returns structured markdown you use exactly like a path. `web_search` ranks providers, so the agent picks a source instead of guessing a URL.

### 09 · Native on every path, Windows included

Other agents shell out to `rg`, `grep`, `find`, and `bash`. Veyyon runs search, glob, and find in-process through its Rust natives, and shell through brush with session continuity. One binary for macOS, Linux, and Windows.

### 10 · Code review that ends with a verdict

`/review` reads a branch, a commit, or your uncommitted work and returns ranked findings with confidence scores in-session, so you get a call on whether the change ships, not a wall of nits.

### 11 · Edits anchored to content hashes, not line numbers

The model points an edit at a content-hash anchor from an earlier read instead of retyping the surrounding lines. A stale anchor fails verification before anything is written, so a file that moved under the agent cannot silently corrupt a patch.

### 12 · One read tool for files, URLs, and internal resources

`read` covers filesystem paths, URLs, and internal schemes under a single interface (including PR-shaped paths where configured), so the agent learns one call shape and reuses it everywhere.

### 13 · Memory the agent keeps between sessions

With a backend such as mnemopi enabled, Veyyon retains and recalls project-scoped facts across sessions, so it does not relearn your codebase every time you open it.

### 14 · Drive it from your editor

`veyyon acp` runs as an Agent Client Protocol server, so Zed and other ACP editors get the same tool loop and approval gates as the terminal.

### 15 · It inherits the config your other tools already wrote

With foreign-config discovery enabled, Veyyon loads context, skills, rules, and MCP from the on-disk layouts of Claude, Codex, Cursor, Gemini, OpenCode, and related tools, with no conversion step. It is off by default; turn it on with `discovery.importForeignConfig: true`.

### 16 · Commits split into atomic, ordered pieces

`veyyon commit` reads the working tree through `git_overview`, `git_file_diff`, and `git_hunk`, groups the changes into dependency-ordered atomic commits, and rejects cycles before it writes. Lock files stay out of the analysis.

### 17 · A PR is just another path

FS-shaped tools accept internal schemes like `pr://`, `issue://`, `agent://`, `skill://`, `rule://`, and `conflict://` with the same call shapes as filesystem paths, so `read pr://1428` and `agent://<id>/findings.0.path` just work.

### 18 · Each merge conflict is one addressable URL

A conflict hunk is `conflict://N` (or `conflict://*` for all of them). Write `@theirs`, `@ours`, or `@base` to pick a side without hand-editing the markers.

### 19 · Preview a structural rewrite, then accept it

`ast_edit` stages an ast-grep rewrite and returns a proposed preview with the match count. `resolve` accepts or rejects, and an accepted apply is atomic.

### 20 · Drives a real browser, quietly

`browser` drives headless Chromium (Puppeteer) or a CDP-attached target. Stealth defaults are on, so a page sees a normal user rather than an automation fingerprint.

## Whatever the task needs is already a tool

Tools share the agent registry with `read` and `bash`. Restrict the exposed set with `--tools read,edit,bash,…`. Hidden tools stay indexed for `search_tool_bm25` when `tools.discoveryMode` allows discovery.

**Files and search**

- `read`: files, dirs, archives, SQLite, PDFs, notebooks, URLs, internal schemes
- `write`: create or overwrite a file, archive entry, or SQLite row
- `edit`: hashline patches with content-hash anchors
- `ast_edit` / `ast_grep`: structural rewrite preview and queries
- `grep` / `glob`: content regex and path globs

**Runtime**

- `bash`: shell (optional PTY / background jobs)
- `eval`: persistent Python/JS cells (opt-in Ruby/Julia kernels)
- `launch`: supervised long-running processes (dev servers, watchers)
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
- `set_cwd`: re-root the session's working directory
- `retain` / `recall` / `reflect` (when the hindsight or mnemopi memory backend is active)

**Misc**

- `resolve`: apply or discard a queued preview action.
- `search_tool_bm25`: BM25 over the hidden tool index; activates top matches mid-session.

Setting-gated and off by default: `github`, `inspect_image`, `tts`, `checkpoint`, `rewind`, `memory_edit`, `retain`, `recall`, `reflect`, `learn`, `manage_skill`, `argot_load`, `argot_unload`. Enable them in `/settings` or `config.yml`. `search_tool_bm25` needs no toggle: it appears automatically once the tool count passes 40 (`tools.discoveryMode: auto`).

[Tool guides →](docs/tools/)

## Dozens of providers, one `/model` away

- **Interactive model:** `/model` or `--model`; persisted as `modelRoles.default`.
- **Roles:** `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `advisor` (plus custom names). Assign in `modelRoles` or settings → Model → Roles. Launch pins: `--smol`, `--slow`, `--plan`.
- **Overrides:** `subagent.model`, `compaction.model` (else inherit interactive).
- **Cycle:** `cycleOrder` (default `smol`, `slow`); keybinding `app.model.cycleForward` (often Ctrl+P).

See [Models, roles, and profiles](docs/handbook/src/using/roles-and-profiles.md).

The auth tags below read as follows: `oauth` signs in with your provider account, `plan` routes through a coding-plan subscription, `local` runs against a local server with the key optional.

### Hosted APIs

Direct APIs and gateways. Mix providers per role.

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Antigravity `oauth` · xAI · Mistral · Groq · Cerebras · Fireworks · Together · Hugging Face · NVIDIA · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### Coding plans

Subscription-routed. `/login` attaches the session.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal · Z.AI / GLM Coding Plan `plan` · Xiaomi MiMo · Qianfan · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### Run it yourself

OpenAI-compatible `/v1/models`. Local instances skip the key.

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### Routing settings

- **Custom providers**: OpenAI-compatible and other API kinds in `~/.veyyon/profiles/default/agent/models.yml` (`openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`, …).
- **Fallback chains**: `retry.fallbackChains` (per role or model). On a 429 or quota failure the next entry continues the turn; the primary returns after cooldown.
- **Path-scoped models**: `enabledModels` / `disabledProviders` with a `path:` prefix for repo-local sets.
- **Round-robin credentials**: multiple API keys per provider with session affinity and per-credential backoff.

Provider and routing settings live in `~/.veyyon/profiles/default/agent/models.yml` (see `packages/coding-agent` docs).

## One search tool, many backends behind it

`web_search` is a built-in tool. Mode `auto` walks the configured provider chain; pin a single provider id when you want one. Site-aware extraction turns selected hosts into structured markdown.

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

## Rust on the hot paths (`@veyyon/natives`)

Thirteen crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, image decode, and BPE counting run in-process on the libuv pool.

- Crates: `veyyon-natives`, `veyyon-shell`, `veyyon-ast`, `veyyon-iso`, `veyyon-walker`, `veyyon-uutils-ctx`, `veyyon-uu-diff`, `veyyon-uu-grep`, `veyyon-diff-kernel`, `veyyon-grep-kernel`, `veyyon-glob`, `veyyon-keys`, `veyyon-text`
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

## Four ways to run the same engine

- **Interactive:** `veyyon` (TUI)
- **One-shot:** `veyyon -p` / `--print`
- **SDK:** embed in Node via `@veyyon/coding-agent`
- **RPC / ACP:** `veyyon --mode rpc` and `veyyon acp` over stdio

### Interactive TUI

The default surface. Tool calls render as cards; the `ask` tool shows a structured option picker. The same permission and ask surfaces route over ACP when the client advertises them.

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

## Built to extend, not outgrow

Source and releases: [github.com/santhreal/veyyon](https://github.com/santhreal/veyyon).

- **Extensions**: TypeScript modules using the same tool, slash-command, hotkey, and TUI registration APIs as the built-ins.
- **Discovery**: with foreign import enabled, loads rules, skills, and MCP from common on-disk layouts (Claude, Cursor, Codex, Gemini, Windsurf, Cline, Copilot, VS Code, …).
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
| **[@veyyon/argot](packages/argot)**                  | Per-project shorthand vocabularies: a lossless substitution codec over AGENTS.dict |
| **[@veyyon/coding-agent](packages/coding-agent)**    | Interactive coding agent CLI and SDK                                       |
| **[@veyyon/tui](packages/tui)**                      | Terminal UI library with differential rendering                            |
| **[@veyyon/natives](packages/natives)**              | N-API bindings for grep, shell, image, text, syntax highlighting, and more |
| **[@veyyon/stats](packages/stats)**                 | Local observability dashboard for AI usage statistics                      |
| **[@veyyon/utils](packages/utils)**                  | Shared utilities (logging, streams, dirs/env/process helpers)              |
| **[@veyyon/wire](packages/wire)**                    | Shared collab live-session protocol types and relay constants              |
| **[@veyyon/hashline](packages/hashline)**               | Line-anchored patch language and applier behind the `edit` tool            |
| **[@veyyon/mnemopi](packages/mnemopi)**              | Local SQLite memory engine for Veyyon agents                             |
| **[@veyyon/metaharness](packages/metaharness)**      | Experimentation / meta harness package                                     |
| **[@veyyon/swarm-extension](packages/swarm-extension)** | Swarm orchestration extension package                                   |
| **[@veyyon/tool-render](packages/tool-render)**      | Shared React tool-call renderers for HTML export and collab-web            |
| **[@veyyon/deepswe-bench](packages/deepswe-bench)**  | DeepSWE bench runner for perf-affecting features                           |
| **[@veyyon/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | Edit benchmark suite over TypeScript source mutations    |

### Rust Crates

| Crate                                              | Description                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[veyyon-natives](crates/veyyon-natives)**                | Core Rust native addon (N-API `cdylib`) used by `@veyyon/natives`; aggregates the crates below |
| **[veyyon-shell](crates/veyyon-shell)**                    | Embedded shell / PTY / process management split out of `veyyon-natives` (wraps `brush-*`)               |
| **[veyyon-ast](crates/veyyon-ast)**                        | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[veyyon-iso](crates/veyyon-iso)**                        | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy          |
| **[veyyon-walker](crates/veyyon-walker)**                  | Platform directory traversal primitives: the native directory-read fast path                    |
| **[veyyon-glob](crates/veyyon-glob)**                      | Glob matching engine (globset) behind the native glob binding                                   |
| **[veyyon-keys](crates/veyyon-keys)**                      | Kitty keyboard protocol parsing with PHF perfect-hash lookup                                    |
| **[veyyon-text](crates/veyyon-text)**                      | ANSI-aware text measurement and slicing over UTF-16 (the engine behind the native text module)  |
| **[veyyon-uutils-ctx](crates/veyyon-uutils-ctx)**          | Thread-local stdio + cwd context for embedding uutils as in-process shell builtins              |
| **[veyyon-uu-diff](crates/veyyon-uu-diff)**                | `diff`: in-process shell builtin for file comparison                                            |
| **[veyyon-diff-kernel](crates/veyyon-diff-kernel)**        | One owner for unified-diff text: line splitting, comparison keys, hunk formatting, binary sniff  |
| **[veyyon-grep-kernel](crates/veyyon-grep-kernel)**        | One owner for the search stack: pattern compilation and searcher construction                    |
| **[veyyon-uu-grep](crates/veyyon-uu-grep)**                | `grep`: ripgrep-backed in-process shell builtin                                                 |
| **[brush-core](crates/vendor/brush-core)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[brush-builtins](crates/vendor/brush-builtins)** | Vendored bash builtins (cd, echo, test, printf, read, export, etc.)                                 |
| **[crates/vendor](crates/vendor)**                 | Vendored [uutils](https://github.com/uutils/coreutils) coreutils and jaq, embedded as in-process shell builtins |

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for contribution guidelines.

---

## License

MIT. See [LICENSE](LICENSE) for the full text and copyright notices.

Veyyon is a fork of oh-my-pi (MIT) and Pi, created by Mario Zechner and Can Bölük. Their copyright notices are retained in [LICENSE](LICENSE).

- [GitHub](https://github.com/santhreal/veyyon)
- [Changelog](https://github.com/santhreal/veyyon/blob/main/CHANGELOG.md)
- [Releases](https://github.com/santhreal/veyyon/releases) (the installer downloads one SHA-256-verified binary per supported OS and architecture)
- [MIT](https://github.com/santhreal/veyyon/blob/main/LICENSE)
