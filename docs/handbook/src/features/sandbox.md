# Sandbox and approvals

> **Spec — not shipped:** the OS-enforced sandbox described on this page — Landlock/seccomp on Linux,
> Seatbelt on macOS, bundled `bwrap`, the `read-only` / `workspace-write` / `danger-full-access` /
> `external-sandbox` policies, and the `-s` / `--sandbox`, `--full-auto`, and
> `--dangerously-bypass-approvals-and-sandbox` flags. Veyyon does **not** ship an OS-level command
> sandbox yet. What ships today is the **`tools.approvalMode`** autonomy ladder that decides when the
> agent pauses before write and exec tools: `plan` (read-tier tools only), `ask` (prompt before
> write/exec), `auto-edit` (auto write, prompt exec), `yolo` (auto-approve all). Set it with
> `--approval-mode <mode>`, `--auto-approve` (alias `--yolo`), or `tools.approvalMode` in `config.yml`.
> Read the rest of this page as the reference for the target sandbox model.

Veyyon separates two questions: **what a command is allowed to touch** (the sandbox) and **when
Veyyon must ask you first** (the approval policy). Together they decide whether a tool call runs
automatically, runs inside a restricted environment, or waits for your yes.

This page is the deep reference. For the short mental model, see
[Permission model](../concepts/permission-model.md). For the approval UX walkthrough, see
[Permissions and approvals](./permissions-explainer.md). For the honesty guarantees, see
[Safety](../using/safety.md).

## Two controls, one decision

| Control | Question it answers | Soft or hard? |
| --- | --- | --- |
| **Sandbox policy** | What may this process read, write, and reach on the network? | Hard boundary (OS-enforced where available). |
| **Approval policy** | Must a human say yes before this action runs? | Interaction policy (can pause; cannot widen the sandbox). |

A command the sandbox forbids **never runs**, regardless of approvals. A command the sandbox permits
may still pause for your approval. Choose a permissive approval policy only alongside a sandbox you
trust for the task.

## Sandbox policies

The sandbox bounds filesystem and network access for commands the agent runs.

| Policy | Filesystem | Network | Best for |
| --- | --- | --- | --- |
| `read-only` | Read anywhere; write nothing. | Off by default (opt in per policy / permissions). | Exploring code you do not fully trust. |
| `workspace-write` | Read anywhere; write within the workspace and configured writable roots. | Off by default. | Everyday coding in a trusted project. |
| `danger-full-access` | No filesystem restrictions from Veyyon. | Unrestricted. | Disposable environments that truly need full access. |
| `external-sandbox` | Full disk access from Veyyon's point of view, because an **outer** sandbox already contains the process. | Honors the provided setting. | Docker, a VM, or a CI job that already sandboxes the runner. |

Set it in `config.yml`, with `-s` / `--sandbox <policy>`, or per run with `-c sandbox_policy=...`.

Additional writable roots for a single run:

```console
$ veyyon --print --sandbox workspace-write --add-dir /tmp/veyyon-scratch "…"
```

### Defaults you should expect

- Interactive `veyyon`: prefer a bounded sandbox (`workspace-write` for normal coding) plus an approval
  policy that still asks for risky work (`on-request` or `untrusted`).
- Headless `veyyon --print`: approvals default to **never** (no TTY to answer), so the **sandbox** is the
  containment. Prefer `--sandbox workspace-write` (or `read-only`) explicitly in CI.
- Network egress is **off by default** for `read-only` and `workspace-write`. Enabling network is a
  deliberate permission change, not an ambient side effect of “running a command.”

## How enforcement works per OS

Veyyon does not implement a toy “please don’t touch that file” filter as its only defense. It builds
and applies a **platform sandbox** so a command can only touch what the active policy permits. If
enforcement cannot be established, Veyyon **fails closed** — that is an error, not a silent
run-without-confinement.

### Linux — Landlock, seccomp, and bubblewrap

On Linux the platform sandbox type is **Linux seccomp** (with Landlock / bubblewrap in the helper):

1. Veyyon self-invokes a helper (`veyyon-linux-sandbox`) with the permission profile, policy cwd, and
   command cwd.
2. The helper applies the profile: **bubblewrap** provides the mount (and, when needed, network)
   namespace; **seccomp** restricts syscalls; **Landlock** (including a legacy Landlock path) further
   constrains filesystem access when selected.
3. A **bundled `bwrap`** is used when the system bubblewrap is missing; Veyyon warns so you can install
   the OS package. If user namespaces are unavailable, you get an explicit warning — sandboxing needs
   them.
4. **WSL1** cannot create the required user namespaces; use **WSL2** for sandboxed shell commands.
   Veyyon surfaces this instead of pretending confinement worked.

Managed / proxy-only networking (when configured) requires bubblewrap’s isolated network namespace and
the helper flag that allows proxy egress only — not a silent hole in the default deny.

### macOS — Seatbelt

On macOS the platform sandbox type is **Seatbelt**. Veyyon launches the command under a Seatbelt
profile derived from the permission policy (base profile plus network policy). Filesystem and network
isolation come from the OS sandbox, not from hope.

### Windows — restricted token (when enabled)

On Windows, when Windows sandboxing is enabled, Veyyon can use a **restricted-token** sandbox.
Unsupported configurations fail with an explicit reason rather than falling back to full access.

### `external-sandbox`

Use this when the process is **already** inside Docker, a VM, or another outer jail. Veyyon will not
double-wrap; it trusts the outer boundary and still honors the network setting you provide. Pair with
headless approvals carefully — the outer jail is doing the hard work.

## Network egress

Network policy is separate from “can the shell start.”

| Mode | Meaning |
| --- | --- |
| Restricted (default for bounded sandboxes) | Outbound network is off unless the permission profile enables it. |
| Enabled | Network is allowed under the active sandbox / proxy rules. |

Practical guidance:

- Keep network off for pure local edit/test loops.
- Enable network only when the task needs package downloads, API calls, or live search — and prefer
  asking (`untrusted` / `on-request`) the first time in an unfamiliar repo.
- In CI, prefer a runner firewall or `external-sandbox` plus an explicit allowlist at the job layer;
  do not rely on the model to “be careful.”

## Approval policies

The approval policy decides when a command or sensitive tool action is shown to you before it runs.
Set it with `-a, --ask-for-approval <policy>` or in config.

| Policy | Behavior | Best for |
| --- | --- | --- |
| `untrusted` | Only known-safe, read-only commands run automatically; everything else asks. | Unfamiliar repositories or high-risk work. |
| `on-request` | The model decides when to ask; it requests approval for anything it considers risky. | Everyday coding where you want the model to judge. |
| `granular` | Fine-grained per-category control: shell commands, execpolicy prompts, skill scripts, the `request_permissions` tool, and MCP elicitations are each allowed or auto-rejected. | Teams that want explicit rules per tool class. |
| `never` | Never ask. Denied or failed commands return to the model rather than escalating to you. | Trusted automation / `veyyon --print` (the headless default). |

### What the approval prompt looks like

```text
Veyyon would like to run a shell command

Command:  npm test
Directory: /home/you/proj
Sandbox:   workspace-write

[y] yes   [n] no   [a] always for this session   [p] show policy
```

```text
Veyyon would like to edit a file

File:      src/main.rs
Sandbox:   workspace-write
Change:    update the function signature and add a null check

[y] yes   [n] no   [a] always for this session   [p] show policy
```

- `y` — run once.
- `a` — allow this kind of action for the rest of the session.
- `n` — deny; the model is told so it can try another approach.
- `p` — show the active policy details.

Trust/allowlists also come from **execpolicy** `.rules` files (user and project). In automation you
can skip loading them with `veyyon --print --ignore-rules` when you want a hermetic policy (see
[Non-interactive mode](./exec.md)).

## How they combine (recipes)

| Goal | Sandbox | Approval |
| --- | --- | --- |
| Explore an unfamiliar repo | `read-only` | `untrusted` |
| Everyday coding | `workspace-write` | `on-request` |
| Trusted CI automation | `workspace-write` or `read-only` | `never` (exec default) + explicit `--sandbox …` |
| Already inside Docker/CI jail | `external-sandbox` | `never` |
| Need full disk, still want human gates | `danger-full-access` | `untrusted` |
| Disposable env, no humans, no jail | `danger-full-access` | `never` — **only** if inputs and the machine are disposable |

Never pair `danger-full-access` with `never` unless the environment is disposable and the inputs are
fully trusted. That combination removes both containment and human review.

### Deprecated: `--full-auto`

On `veyyon --print`, `--full-auto` is a **legacy compatibility trap**. It prints a warning and maps to
`--sandbox workspace-write` behavior. Prefer the explicit flag:

```console
$ veyyon --print --sandbox workspace-write "run the unit tests and summarize failures"
```

Do not document new automation as `--full-auto`.

### Dangerous escape hatch

```console
$ veyyon --print --dangerously-bypass-approvals-and-sandbox "…"
```

(`--yolo` is an alias.) This skips confirmation prompts **and** sandboxing. Intended solely for
environments that are **externally** sandboxed. Prefer `external-sandbox` when you can express the
outer jail cleanly.

## Extending the boundary at runtime

You can widen read access or escalate without editing `config.yml` mid-thought:

| Action | Effect |
| --- | --- |
| `/sandbox-add-read-dir <absolute_path>` | Grant the sandbox read access to a directory for the current session. |
| `/elevate-sandbox` | Walk through setting up the elevated agent sandbox when a task needs more than the default. |
| `/approve` | Approve a specific pending request. |
| `/reload` | Re-read configuration after you edit policies on disk. |
| `-c sandbox_policy=…` / `-a …` | Override for a single run. |
| `--add-dir <DIR>` | Extra writable root for this invocation. |

Use [profiles](../using/configuration.md) for repeatable combinations (for example a `reviewer`
profile with `read-only` + `untrusted`).

## Fail-closed behavior

Security-control failures are operator-visible:

- Missing Linux sandbox helper → error, not unsandboxed execution.
- Seatbelt unavailable off macOS → unsupported operation, not a silent skip.
- Bubblewrap / user-namespace problems → warning or hard failure depending on whether the policy
  **requires** a platform sandbox.
- WSL1 → explicit unsupported message pointing at WSL2.

Treat a silent fallback to a weaker boundary as a **bug**. After changing sandbox or approval
settings, confirm the active `tools.approvalMode` in `/settings` (Advanced → Safety).

## Choosing settings (checklist)

1. Is the repo trusted? If no → `read-only` + `untrusted`.
2. Does the task need writes? If yes → `workspace-write`, keep network off until needed.
3. Are you headless? If yes → set `--sandbox` explicitly; do not rely on interactive approvals.
4. Is there an outer jail? If yes → `external-sandbox` (or `--dangerously-bypass-…` only when you
   understand the outer jail).
5. Would a wrong `rm -rf` hurt? If yes → never combine full access with `never`.

## See also

- [Safety](../using/safety.md) — honesty guarantees and what to verify.
- [Permissions explainer](./permissions-explainer.md) — approval UX.
- [Non-interactive mode](./exec.md) — CI flags (`--ignore-user-config`, `--ignore-rules`, sandbox).
- [CLI reference](../reference/cli.md) — launch flags.
- [Exit codes](../reference/exit-codes.md) — how failures surface in scripts.
