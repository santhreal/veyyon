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

The landing-page recording is one operator task from objective to running artifact. Before submission, `/secret from-env` stores a synthetic release key. The model creates its own persistent goal from the single task prompt, then idle goal continuation carries the work across model turns without another user prompt.

The task creates an eight-item, four-phase todo list, launches three workers together for flight dynamics, terminal rendering, and autopilot behavior, and integrates their modules into **Nebula Drift**, a deterministic terminal 3D ship simulator. The project must pass its tests and TypeScript check, compile to `dist/nebula-drift`, and render a perspective-projected ship, star field, navigation gate, and telemetry HUD.

After the build passes, the model signs the compiled binary with HMAC-SHA256 through `#RELEASE_SIGNATURE#`. Veyyon resolves the placeholder only at the outbound tool boundary and asks for explicit approval before the command runs. The model then closes all eight tasks, completes the persistent goal itself, and presents the compiled simulator.

| Surface | Evidence |
| --- | --- |
| Complete task | [Published clip](../../../../assets/demo-hd.webp) · [full-quality cut](../../../../proof/captures/x11/demo-hd-cut.mp4) · [unedited take](../../../../proof/captures/x11/demo-hd.mp4) |
| Secret setup | [Release key stored from the environment](../../../../assets/demo-hd-secret-stored.png) |
| Persistent objective | [Goal created by the model from the task prompt](../../../../assets/demo-hd-goal-created.png) |
| Plan | [Four phases and eight open tasks](../../../../assets/demo-hd-todo-board.png) · [all eight tasks complete](../../../../assets/demo-hd-todo-finished.png) |
| Parallel implementation | [Dynamics, rendering, and flight workers live together](../../../../assets/demo-hd-agent-lanes.png) |
| Integration | [Parent-agent CLI and signing integration](../../../../assets/demo-hd-integration-edit.png) |
| Verification | [Tests, typecheck, and compiled binary green](../../../../assets/demo-hd-build-verified.png) |
| Compiled simulator | [Deterministic 3D flight display](../../../../assets/demo-hd-simulator-preview.png) |
| Protected signing | [permission boundary](../../../../assets/demo-hd-secret-approval.png) · [signature artifact](../../../../assets/demo-hd-signature-written.png) |
| Goal completion | [Model-completed persistent objective](../../../../assets/demo-hd-goal-complete.png) |
| Presentation | [Signed Nebula Drift binary running](../../../../assets/demo-hd-presentation.png) |

The opening and release play at capture speed. Visible implementation work between the worker launch and verified build plays at 1.25×; untouched screens are trimmed rather than accelerated. Every frame and both clips come from the same guarded take.

See [Testing and verification](../foundations/verification.md#recording-terminal-proofs) for the recording environment, regeneration command, and before-and-after proof requirements. Verify the archived binary signature with `proof/verify-binary-signature.py`.
