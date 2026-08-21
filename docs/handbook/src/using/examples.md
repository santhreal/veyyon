# Examples

Use Veyyon from the repository root for tasks where the harness can inspect files, edit, and verify.

## Understand a code path

```text
Explain how model/provider configuration is loaded and where an invalid setting is surfaced to the user.
```

Veyyon should read the relevant configuration files in your project, name the boundary where state
enters, and point at tests or missing tests.

## Make a small fix

```text
Fix the config error so it names the invalid file and the setting to change. Add the regression test.
```

Veyyon should edit through hashline or `write`, run the focused test (`bun test` in the relevant
package), and stop when the test proves the behavior.

## Improve docs with code truth

```text
Make the MCP setup page match the MCP config loader in this project. Verify against the schema.
```

Inspect the live schema source, update the handbook, and avoid claims not backed by code. Engineering
notes live under `docs/`.

## Review a change

```text
Review the staged diff for correctness, security, missing tests, and public/private boundary leaks.
```

A useful review names concrete files and lines, separates correctness from style, and recommends the
smallest fix that makes the behavior true. Enable the advisor watchdog (`advisor.enabled`) when a
second model should comment on each turn.

## Recover a malformed tool call

```text
Use the edit tool with a stale hashline tag and observe the mismatch error.
```

Malformed tool JSON is repaired when the fix is unambiguous; otherwise the call returns an error tool result with hints
rather than dispatching garbage. Hashline returns actionable stale-tag errors. See
[Repair overview](../repair/overview.md).

## Continue through long context

```text
Keep the security requirement, touched files, and next action intact after compaction.
```

Use `/compact` with a focus string; goal mode (`/goal`) preserves objectives across compaction when
enabled. See [Compaction and memory](../context/compaction-memory.md).

## Verify before claiming done

```text
Run the package test gate for the area you changed.
```

Example: `bun run test` in `packages/coding-agent`, or the Rust + TypeScript CI matrix documented in `CONTRIBUTING.md` when touching Rust natives.

## Use the model/provider contract

```text
Point Veyyon at a provider model and rely on the same harness contract every provider path must satisfy.
```

See [Model contract](../concepts/model-contract.md) and [Providers](../models/providers.md).

## Recorded end-to-end workflow

The main recording is one continuous session through the shipped CLI. It opens a four-phase plan, audits nine environment reads, writes one validating owner, fans three migrations out to parallel workers, applies a hash-anchored edit, runs the suite, advances the plan, spends a protected secret placeholder, and inspects the resulting context and settings.

The scenario deliberately catches a coercion boundary: `Number("0x10")` returns 16, so a hexadecimal environment value must be rejected rather than read as decimal configuration. The session records the search, inventory, parallel edits, verification, and final operator state rather than staging those surfaces separately.

| Surface | Evidence |
| --- | --- |
| Complete session | [Published clip](../../../../assets/demo-hd.webp) · [full-quality cut](../../../../proof/captures/wayland/demo-hd-cut.mp4) · [unedited take](../../../../proof/captures/wayland/demo-hd.mp4) |
| Search | [All nine configuration reads found by the completed audit](../../../../assets/demo-hd-search-block.png) |
| Inventory | [The nine reads classified by file, variable, environment key, default, and coercion](../../../../assets/demo-hd-inventory.png) |
| Parallel workers | [Three workers editing disjoint directories](../../../../assets/demo-hd-agent-lanes.png) |
| Hash-anchored edit | [The main agent adds the numeric-format guard](../../../../assets/demo-hd-edit-diff.png) |
| Verification | [The selected verification command and its result](../../../../assets/demo-hd-verify-command.png) |
| Plan | [Plan opened before editing](../../../../assets/demo-hd-todo-board.png) · [plan advanced after verification](../../../../assets/demo-hd-todo-strike.png) |
| Protected secret | [stored](../../../../assets/demo-hd-secret-stored.png) · [approval](../../../../assets/demo-hd-secret-approval.png) · [spent](../../../../assets/demo-hd-signature-written.png) · [value-free audit log](../../../../assets/demo-hd-secret-log.png) |
| Context | [Live session accounting](../../../../assets/demo-hd-context-report.png) |
| Settings | [Appearance and footline preview](../../../../assets/demo-hd-settings-pane.png) |
| Worker control | [Parallel findings](../../../../assets/stills-extra-agents.png) · [Agent Control Center](../../../../assets/stills-extra-agent-control.png) |
| Language server | [Workspace rename and green suite](../../../../assets/demo-lsp-hd.webp) |
| Installation | [Published installer and checksum verification](../../../../assets/demo-install-hd.webp) |

See [Testing and verification](../foundations/verification.md#recording-terminal-proofs) for the recording environment, regeneration commands, and before-and-after proof requirements.
