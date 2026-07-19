# Getting started

This chapter takes you from nothing installed to a first real change in your own project. It has four steps: install Veyyon, run the first-time setup, sign in to a provider, and hand Veyyon a small task.

## 1. Install

The quickest path uses Bun to install the published package.

```console
$ bun install -g @veyyon/coding-agent
$ veyyon --version
```

If you would rather build from a source checkout, clone the repository and run the setup script.

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup
$ bun dev --version
```

`bun setup` installs the workspace dependencies and builds `@veyyon/natives`, the Rust addon. Your configuration lives under `~/.veyyon`, and the default profile keeps its agent state in `~/.veyyon/profiles/default/agent/`.

To add shell completion, run `veyyon completions bash`, `veyyon completions zsh`, or `veyyon completions fish`. The [Install](./install.md) chapter has the full details.

## 2. First launch

The first time you run `veyyon` (or any time you run `veyyon setup`), the setup UI walks you through five steps:

1. The splash screen.
2. Providers, where you sign in or paste an API key, and optionally enable web search.
3. Glyphs, where you choose a Nerd Font, plain Unicode, or ASCII.
4. Theme.
5. The session welcome.

You can return to provider setup later with `/setup` or `/providers` inside the TUI. To skip setup entirely, set `VEYYON_SKIP_SETUP=1`, or resume an existing session.

## 3. Sign in to a provider

Veyyon needs at least one model provider. You have three common options.

**Use an API key.** Set the provider's key in your environment, then pick one of its models in `/model`. For example, export `DEEPSEEK_API_KEY` and choose a DeepSeek model.

**Sign in with OAuth.** Run `/login`, or name a provider directly with `/login anthropic`. These are the same flows the Providers setup scene uses.

**Add a custom gateway.** Declare a provider in `~/.veyyon/profiles/default/agent/models.yml`:

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

**Run a local model.** With the Ollama daemon running, Veyyon discovers local models and needs no key:

```console
$ ollama serve
$ veyyon
```

Open `/model` and choose an `ollama/...` entry from the discovered list.

For the full picture, see [Models and providers](./models.md) and [Configuring providers](./configuring-providers.md).

## 4. Run your first task

Change into a project you know, and start Veyyon.

```console
$ cd ~/code/my-project
$ veyyon
```

Describe a small, checkable task:

```text
Add a function add(a, b) in src/lib.rs and a unit test. Run the test.
```

A typical run looks like this:

1. Veyyon reads the files it needs with `read`, `grep`, and `glob`.
2. It proposes an edit through the hashline `edit` and `write` tools.
3. When your policy requires it, you approve the tool call. The `tools.approvalMode` setting decides when this happens; see [Safety](./safety.md).
4. The change lands, and the diff appears in the TUI.
5. If you asked for tests, you approve the `bash` or `cargo test` call when Veyyon runs them.

## Approval mode

Every tool call falls into one of three tiers: `read`, `write`, or `exec`. The `tools.approvalMode` setting decides which tiers run without asking and which ones prompt you first.

| Mode | Runs without asking | Prompts you for |
| --- | --- | --- |
| `plan` | `read` (it proposes, but does not write) | everything that writes or runs |
| `ask` | `read` | `write` and `exec` |
| `auto-edit` | `read` and `write` | `exec` |
| `yolo` (default) | all tiers | nothing, unless a per-tool override or a bash safety rule applies |

The older names `always-ask` and `write` still work, and map to `ask` and `auto-edit`. The schema default is `yolo`. You can change it in `/settings` or in your config. See [Approvals](../features/sandbox.md) and [Safety](./safety.md).

## Where to go next

A few surfaces are worth trying early:

- **A multi-file change.** Ask for a refactor across modules. Hashline edits batch the paths together.
- **The session tree.** `/tree` jumps back to an earlier message and branches from it inside the same session file.
- **Model slots.** `/model` sets the interactive model. You set the subagent and compaction models in settings; see [Models, roles, and profiles](./roles-and-profiles.md).

From here, the [Quickstart](./quickstart.md) is a shorter walkthrough, [Configuration](./configuration.md) covers settings, [Sessions](./sessions.md) explains resuming and branching, [Memory](../features/memory.md) covers the mnemopi backend, and [Diagnostics](../features/doctor.md) covers the doctor and debug tools.
