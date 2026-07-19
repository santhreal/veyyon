# Overview

Veyyon is a local terminal coding agent. The loop, the tools, and your credentials all stay on your machine. You choose which model to use from the bundled provider catalog, either by signing in to a subscription or by bringing your own key.

This chapter is a one-page map of what the harness does. Each row links to the chapter that explains it in full, so you can skim now and follow up later.

## What the harness does

| Area | What you get |
| --- | --- |
| Edits | Hashline `edit` and `write`, verified before anything is written to disk |
| Tools | read, grep, glob, bash, LSP, DAP, browser, MCP, task subagents, and more |
| Approvals | `tools.approvalMode` gates the read, write, and exec tiers (there is no operating-system process sandbox) |
| Models | Separate slots for the interactive, subagent, and compaction models, plus optional roles per profile |
| Sessions | Branchable session trees that you can resume and fork |
| Memory | Memory backends, active whenever `memory.backend` is not `off` |
| Config | `~/.veyyon`, or a relocated agent directory per profile, alongside project files under your working directory |

## Lineage

Veyyon is built from [oh-my-pi](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/badlogic/pi-mono). The [Acknowledgements](../acknowledgements.md) page records the full provenance.

## Next

- [Mechanisms](./innovations.md) explains how the harness works.
- [Getting started](../using/getting-started.md) walks through your first session.
- [Editing and repair](../using/editing.md) covers the edit path in depth.
