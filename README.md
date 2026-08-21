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
  <img src="assets/demo-hd.webp" width="960" alt="Veyyon creates a long-running goal from one task prompt, opens an eight-task plan, launches three parallel workers, builds and verifies a terminal 3D ship simulator, signs the compiled binary through a protected secret placeholder, completes the goal, and presents the running simulator">
</p>

<p align="center">
  <a href="docs/handbook/src/using/examples.md#recorded-end-to-end-workflow">Follow the complete task and inspect its proof frames</a>
</p>

<table align="center">
  <tr><td align="center"><strong>Before</strong></td><td align="center"><strong>After</strong></td></tr>
  <tr>
    <td><img src="assets/todos-block-before.png" width="440" alt="The todo block with a count in its header, box-drawing connectors on every row, and a phase collapsed to its name"></td>
    <td><img src="assets/todos-block-after.png" width="440" alt="The todo block with a bare header, per-phase counts right-aligned in one column, a rail in place of the connectors, and every phase keeping its tasks on screen"></td>
  </tr>
</table>

<p align="center">
  The todo board above the composer, rebuilt. One scene recorded twice by the same container at 131 columns and sampled at the same second of the same script: the header loses its count, the per-phase counts line up in one column at the far margin, a rail replaces the connectors and carries the block's liveness, and every phase keeps its tasks on screen. <a href="docs/handbook/src/using/task-guides.md#track-long-work-without-repeated-reminder-walls">How the block reads</a>
</p>

<table align="center">
  <tr><td align="center"><strong>Before</strong></td><td align="center"><strong>After</strong></td></tr>
  <tr>
    <td><img src="assets/subagent-lanes-before.png" width="440" alt="A subagent lane whose model badge has wrapped onto a line of its own at column zero, outside the block"></td>
    <td><img src="assets/subagent-lanes-after.png" width="440" alt="Two subagent lanes, each ending in its model badge right-aligned at the far margin inside the block"></td>
  </tr>
</table>

<p align="center">
  The same recorder found a defect no unit test could see: both anchored blocks were handed the terminal's full width while their mount wraps two cells earlier, so each row's right-aligned tail landed on a line of its own outside the block. <a href="docs/handbook/src/features/subagents.md#watching-a-run">How a lane reads</a>
</p>

Veyyon is a terminal coding agent for work that outlives one prompt. It keeps context, goals, plans, workers, permissions, and verification visible while the model reads, edits, runs, and finishes the task.

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi). Thanks to its maintainers and contributors for the project Veyyon builds on. [UPSTREAM.md](UPSTREAM.md) preserves the history and notices.

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

## Documentation

| Area | Guides |
| --- | --- |
| Start | [Quickstart](docs/handbook/src/using/quickstart.md) · [Install and update](docs/handbook/src/using/install.md) |
| Configure | [Configuration](docs/handbook/src/using/configuration.md) · [Models, providers, and roles](docs/handbook/src/using/roles-and-profiles.md) |
| Operate | [CLI modes](docs/handbook/src/reference/cli.md) · [Tools](docs/handbook/src/reference/tools.md) · [Long-running goals](docs/handbook/src/context/goal-state.md) |
| Inspect | [Recorded end-to-end workflow](docs/handbook/src/using/examples.md#recorded-end-to-end-workflow) · [Testing and verification](docs/handbook/src/foundations/verification.md) |
| Develop | [Contributing](CONTRIBUTING.md) · [Coding-agent development](packages/coding-agent/DEVELOPMENT.md) |

## License

Veyyon is licensed under MIT. See [LICENSE](LICENSE). Upstream and third-party notices are preserved in [UPSTREAM.md](UPSTREAM.md) and [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt).
