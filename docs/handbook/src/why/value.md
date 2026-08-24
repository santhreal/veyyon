# Overview

Veyyon is a local terminal coding agent. The loop, tools, and credentials run locally on the host machine. Model selection uses the bundled provider catalog via subscription sign-in or API keys.

## Subsystem summary

| Area | Capability |
| --- | --- |
| Edits | Hashline `edit` and `write`, checked against file contents before writing to disk |
| Tools | `read`, `grep`, `glob`, `bash`, LSP, DAP, browser, MCP, task subagents, and extensions |
| Approvals | `tools.approvalMode` gates read, write, and exec tiers |
| Models | Separate slots for interactive, subagent, and compaction models, with role mappings per profile |
| Sessions | Branchable session trees with resume and fork support |
| Memory | Local SQLite memory backends, active when `memory.backend` is not `off` |
| Config | `~/.veyyon` or profile-specific agent directories; repository trees contribute `AGENTS.md` instructions |

## Lineage

Veyyon is built from [oh-my-pi](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/badlogic/pi-mono). See [Acknowledgements](../acknowledgements.md) for credits.

## Related

- [Mechanisms](./innovations.md)
- [Getting started](../using/getting-started.md)
- [Editing and repair](../using/editing.md)
