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
Fix the config error so it states the invalid file and the setting to change. Add the regression test.
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

The landing-page recording is one operator task carried to a signed artifact, in a single unbroken
session. The task audits the numeric environment defaults of a small service. Before submission,
`/secret from-env` stores a synthetic release key as the placeholder `#RELEASE_SIGNATURE#`.

The model writes a three-phase, six-task plan and holds it until told to start. It fans three
directory-scoped refactors out to parallel workers, one per directory, applies the edits itself where
the change is one guard, and verifies that all nine documented defaults resolve in an environment
stripped of every one of those variables. It then signs its work in one `bash` call: the sha256 of
`#RELEASE_SIGNATURE#` appended to `SIGNED.md` as a single line. Veyyon resolves the placeholder only
at the outbound tool boundary and requires approval before the call runs, so the credential itself is
never printed and never reaches the transcript. The board closes 6/6.

The [recorded clip](../../../../assets/demo-hd.webp) runs the whole task. Untouched screens are
shortened rather than accelerated.

See [Testing and verification](../foundations/verification.md#recording-terminal-proofs) for the
recording environment and the regeneration command.
