# Getting started

Install Veyyon, complete the first-run ceremony, and land your first approved edit. Budget about five minutes.

## 1. Install

**npm / Bun (recommended)**

```console
$ bun install -g @veyyon/pi-coding-agent
$ veyyon --version
```

**From source** (repo root):

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup
$ bun dev --version
```

`bun setup` installs workspace deps and builds `@veyyon/pi-natives`. Config and state default to `~/.veyyon`.

Shell completions: `veyyon completions bash|zsh|fish`. See [Install](./install.md).

## 2. First launch — the setup ceremony

The first interactive `veyyon` (or an explicit `veyyon setup`) opens a fullscreen ceremony:

1. **Splash** — silver wordmark reveal
2. **Providers** — sign in to a model provider; optional web search tab
3. **Glyphs** — Nerd Font / Unicode / ASCII for your terminal
4. **Theme** — Titanium (default dark), Light, or browse
5. **Outro** — handoff into the session welcome

Re-run the provider panel later with `/setup` or `/providers` inside the TUI. Skip the ceremony with `VEYYON_SKIP_SETUP=1` (or resume an existing session).

**API key (example):** set `DEEPSEEK_API_KEY` in the environment, then pick a DeepSeek model in `/model`.

**Custom gateway** — add a provider in `~/.veyyon/agent/models.yml`:

```yaml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

**OAuth providers:** `/login` or `/login anthropic` inside the TUI (same flows the Providers scene uses).

Details: [Models and providers](./models.md), [Configuring providers](./configuring-providers.md), engine doc `docs/providers.md`.

Local **Ollama** (keyless when the daemon is up):

```console
$ ollama serve
$ veyyon
```

Then `/model` and choose an `ollama/…` model from discovery.

## 3. Run your first task

```console
$ cd ~/code/my-project
$ veyyon
```

Describe a small task:

```text
Add a function add(a, b) in src/lib.rs and a unit test. Run the test.
```

Typical flow:

1. Veyyon reads relevant files (`read`, `search`, …).
2. It proposes an edit through hashline/`edit`/`write` tools.
3. When policy requires it, you approve the tool call (`tools.approvalMode` — see [Safety](./safety.md)).
4. The change lands; diffs appear in the TUI.
5. If you asked for tests, approve `bash` or `cargo test` as needed.

## 4. Work safely (defaults)

Tool approval tiers (`read`, `write`, `exec`) combine with `tools.approvalMode`:

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | `read` (proposes without writing) | everything that writes or runs |
| `ask` | `read` | `write`, `exec` |
| `auto-edit` | `read`, `write` | `exec` |
| `yolo` (default) | all tiers | none (unless per-tool override or bash safety override) |

Legacy names `always-ask` (→ `ask`) and `write` (→ `auto-edit`) are still accepted.

Use `/settings` or config to tighten policy on unfamiliar repos. Deep dive: [Sandbox](../features/sandbox.md), [Safety](./safety.md), `docs/approval-mode.md`.

## 5. Three things to try next

1. **Multi-file change** — ask for a refactor across modules; watch hashline edits batch paths.
2. **Session tree** — `/tree` to jump to an earlier user message and branch in the same session file.
3. **Switch models** — `/model` for the model you talk to; set the subagent and compaction models in settings. See [Models, roles, and profiles](./roles-and-profiles.md).

## Where to go next

- [Quickstart](./quickstart.md) — shorter walkthrough.
- [Configuration](./configuration.md)
- [Sessions](./sessions.md)
- [Memory](../features/memory.md) — mnemopi backend
- [Diagnostics](../features/doctor.md) — plugin doctor and debug tools
