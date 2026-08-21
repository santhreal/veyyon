<p align="center">
  <img src="assets/sun.svg" width="260" alt="Veyyon sun">
</p>

<h1 align="center">Veyyon</h1>

<p align="center">
  A terminal coding agent whose harness is built for inspectable context, controlled mutation, and long-running work.
</p>

<p align="center">
  <a href="https://github.com/santhreal/veyyon/releases/latest"><img src="https://img.shields.io/github/v/release/santhreal/veyyon?style=flat&colorA=222222&colorB=E05735&label=release" alt="Latest release"></a>
  <a href="https://github.com/santhreal/veyyon/actions"><img src="https://img.shields.io/github/actions/workflow/status/santhreal/veyyon/checks.yml?style=flat&colorA=222222&colorB=3FB950&label=checks" alt="Checks"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/santhreal/veyyon?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
</p>

<p align="center">
  <img src="assets/demo-hd.webp" width="960" alt="Veyyon opens a four-phase todo plan, audits a nine-module service tree, writes one validating owner, fans out three subagents, applies a hash-anchored edit, runs the suite, advances the plan, signs the result through a stored secret placeholder, and opens context and settings operator surfaces in one continuous session">
</p>

Veyyon uses the same model weights available in other clients. The difference is the workbench around them: a prompt you can inspect, model-native effort controls, explicit state ownership, protected secret spending, typed workers, language-server refactors, durable sessions, and tools that fail before stale state becomes a bad write.

Veyyon is a source fork of [oh-my-pi](https://github.com/can1357/oh-my-pi). It is not a clean-room rewrite. [UPSTREAM.md](UPSTREAM.md) records the inherited foundation and the contracts Veyyon changed.

## Install

**Linux and macOS**

```sh
curl -fsSL https://get.veyyon.dev | sh
```

**Windows**

```powershell
irm https://veyyon.dev/install.ps1 | iex
```

The installer verifies the release checksum and binary before replacing an existing installation. See [Install Veyyon](docs/handbook/src/using/install.md) for supported platforms, pinned releases, source checkouts, updates, rollback, and uninstall.

## What Veyyon changes

- **Inspectable context.** Prompt statements, layered project context, and context moves are visible before they affect a run. [Prompt customization](docs/system-prompt-customization.md) · [Context files](docs/context-files.md)
- **Deliberate model control.** Effort, roles, provider routing, and compaction remain explicit operator choices. [Models and effort](docs/settings.md#models) · [Roles and profiles](docs/handbook/src/using/roles-and-profiles.md)
- **Protected secret spending.** Models use named placeholders while credentials remain local, encrypted, scoped, and auditable. [Secret workflow](docs/handbook/src/features/secrets.md)
- **Visible workers.** Typed subagents, IRC, persistent transcripts, and the Agent Control Center keep parallel work inspectable. [Subagents](docs/handbook/src/features/subagents.md)
- **State-aware edits.** Language-server refactors and hash-anchored patches fail before stale state becomes a bad write. [Editing and repair](docs/handbook/src/using/editing.md)

The [Veyyon handbook](docs/handbook/src/introduction.md) explains the complete runtime and its contracts.

## Explore

- [Recorded end-to-end workflow and proof gallery](docs/handbook/src/using/examples.md#recorded-end-to-end-workflow)
- [Quickstart](docs/handbook/src/using/quickstart.md)
- [Configuration](docs/handbook/src/using/configuration.md)
- [Models, providers, and routing](docs/handbook/src/using/roles-and-profiles.md)
- [CLI modes and commands](docs/handbook/src/reference/cli.md)
- [Tools reference](docs/handbook/src/reference/tools.md)

## Provenance

### Inherited foundation

Veyyon retains the Bun and TypeScript agent loop, terminal UI, provider catalog, role routing, hashline edit engine, mnemopi memory, and the original native grep, PTY, and tree-sitter hot-path foundations from oh-my-pi. These remain important product capabilities. They are not presented as Veyyon inventions.

### Veyyon-owned contracts

Veyyon owns the statement-based prompt architecture, transactional context moves, model-native effort and explicit effort precedence, current compaction strategy and chains, provider-bound secret protection, profile/session durability rules, LSP write-through, capability and tool registry, typed worker and IRC operations, Agent Control Center, internal agent URLs, and post-fork reusable Rust crate boundaries and their current contracts.

This boundary describes this repository. It does not claim that current upstream has stood still. Read [UPSTREAM.md](UPSTREAM.md), the [mechanisms chapter](docs/handbook/src/why/innovations.md), and the [intentional divergence ledger](docs/internal/porting-from-pi-mono.md#15-intentional-divergences) for the detailed record.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) for source setup, development commands, verification gates, and runtime conventions.

## License

Veyyon is licensed under MIT. See [LICENSE](LICENSE).

Run `veyyon licenses` to print the complete notice bundle embedded in every
release binary. The same bundle is available as
[`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt) in a source checkout.

The project is derived from oh-my-pi. Upstream copyright and license notices are preserved in [UPSTREAM.md](UPSTREAM.md) and the source tree.
