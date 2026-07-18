# Overview

Veyyon is a local terminal coding agent: the loop, tools, and credentials stay on your machine. You pick models through the bundled provider catalog (subscription sign-in or BYOK).

## What the harness does

| Area | Behavior |
| --- | --- |
| Edits | Hashline-oriented `edit` / `write` with verification before disk write |
| Tools | read, grep, glob, bash, LSP, DAP, browser, MCP, task subagents, … |
| Approvals | `tools.approvalMode` gates read / write / exec (no OS process sandbox) |
| Models | Interactive, subagent, and compaction slots; optional roles per profile |
| Sessions | Branchable session trees; resume and fork |
| Memory | Memory backends when `memory.backend` is not `off` |
| Config | `~/.veyyon` (or profile-relocated agent dir); project files under cwd |

## Lineage

Built from [oh-my-pi](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/badlogic/pi-mono). See [Acknowledgements](../acknowledgements.md).

## Next

- [Mechanisms](./innovations.md)
- [Getting started](../using/getting-started.md)
- [Editing and repair](../using/editing.md)
