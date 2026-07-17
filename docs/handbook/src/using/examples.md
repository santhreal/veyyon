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

Malformed tool JSON is repaired when the fix is unambiguous, otherwise it fails loudly with coaching
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

Example: `bun run test` in `packages/coding-agent` or the project's documented `cargo_full` / CI
script from `STANDARD.md` when touching Rust natives.

## Use the hosted model contract

```text
Point Veyyon at a hosted model and rely on the same behavior contract every provider must satisfy.
```

See [Model contract](../concepts/model-contract.md) and [Providers](../models/providers.md).
