# Getting started

Install, first-run setup, first session.

## 1. Install

**npm / Bun (recommended)**

```console
$ bun install -g @veyyon/coding-agent
$ veyyon --version
```

**From source** (repo root):

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup
$ bun dev --version
```

`bun setup` installs workspace deps and builds `@veyyon/natives`. Config home: `~/.veyyon`; default profile agent dir: `~/.veyyon/profiles/default/agent/`.

Shell completions: `veyyon completions bash|zsh|fish`. See [Install](./install.md).

## 2. First launch

First interactive `veyyon` (or `veyyon setup`) runs the setup UI:

1. Splash
2. Providers (sign-in / keys; optional web search)
3. Glyphs (Nerd Font / Unicode / ASCII)
4. Theme
5. Session welcome

Later: `/setup` or `/providers` in the TUI. Skip with `VEYYON_SKIP_SETUP=1` or by resuming a session.

**API key (example):** set `DEEPSEEK_API_KEY` in the environment, then pick a DeepSeek model in `/model`.

**Custom gateway** — add a provider in `~/.veyyon/profiles/default/agent/models.yml`:

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

1. Veyyon reads relevant files (`read`, `grep`, `glob`, …).
2. It proposes an edit through hashline/`edit`/`write` tools.
3. When policy requires it, you approve the tool call (`tools.approvalMode` — see [Safety](./safety.md)).
4. The change lands; diffs appear in the TUI.
5. If you asked for tests, approve `bash` or `cargo test` as needed.

## 4. Approval mode

Tool approval tiers (`read`, `write`, `exec`) combine with `tools.approvalMode`:

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | `read` (proposes without writing) | everything that writes or runs |
| `ask` | `read` | `write`, `exec` |
| `auto-edit` | `read`, `write` | `exec` |
| `yolo` (default) | all tiers | none (unless per-tool override or bash safety override) |

Legacy names `always-ask` (→ `ask`) and `write` (→ `auto-edit`) are still accepted.

Schema default for `tools.approvalMode` is **`yolo`**. Change in `/settings` or config. See [Approvals](../features/sandbox.md), [Safety](./safety.md).

## 5. Further surfaces

1. **Multi-file change** — refactor across modules; hashline edits batch paths.
2. **Session tree** — `/tree` jumps to an earlier user message and branches in the same session file.
3. **Models** — `/model` for the interactive model; set subagent and compaction models in settings. See [Models, roles, and profiles](./roles-and-profiles.md).

## Where to go next

- [Quickstart](./quickstart.md) — shorter walkthrough.
- [Configuration](./configuration.md)
- [Sessions](./sessions.md)
- [Memory](../features/memory.md) — mnemopi backend
- [Diagnostics](../features/doctor.md) — plugin doctor and debug tools
