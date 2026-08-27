# Veyyon documentation

There is one manual: the handbook under [`handbook/`](handbook/). Everything an operator or an
integrator needs is a page in it, from install to the generated settings table. Built output lands in
`handbook/book/`, which the website serves.

Everything else in this directory exists for a reason a reader can check:

| Directory | Who reads it |
| --- | --- |
| [`handbook/`](handbook/) | Operators and integrators. The manual. One page per topic. |
| [`tools/`](tools/README.md) | The model, at run time. One page per built-in tool, served by name over `veyyon://`, so a page here is a product surface and not prose about one. |
| [`internal/`](internal/README.md) | Contributors changing the code: runtime internals, native-crate plumbing, porting notes, operations, brand. Not published, not needed to use Veyyon. |
| [`adr/`](adr/README.md) | The load-bearing decisions, dated, with the alternative that was rejected. |
| [`migration/`](migration/) | The three contracts a port has to satisfy: conformance format, hashline, mnemopi. |

## Adding a page

Add it to the handbook, and add its row to [`handbook/src/SUMMARY.md`](handbook/src/SUMMARY.md). A
page that is not in `SUMMARY.md` is not built and cannot be reached.

The handbook is organized by what the reader is doing, and the parts are not interchangeable:

- **Everyday use** and **Extend and customize** are guides. They answer "how do I", in order, with
  the shortest path first.
- **Reference** is exhaustive. Every setting, every variable, every field of a config file. A
  reference page is allowed to be long and is not allowed to be selective.
- **Under the hood** is implementation: what the modules are, what invariant each one holds, and
  which file to open. It names symbols and paths.

A topic that needs both a guide and a reference gets one page in each part, and they link to each
other. `features/secrets.md` and `architecture/secrets.md` are that pair; so are
`using/configuration.md`, `reference/settings.md` and `reference/settings-reference.md`.

One page per topic. Extend the page that owns the topic rather than adding a second one beside it.

A page generated from code says so in its first paragraph and is regenerated in the change that
alters the code. [`handbook/src/reference/settings-reference.md`](handbook/src/reference/settings-reference.md)
is rendered from the settings schema by `scripts/gen-settings-reference.ts`, and a test fails when the
committed file and the generator disagree.

## Prose that lives outside `docs/`

A handful of first-party pages sit next to the thing they describe. The list is exhaustive and
`scripts/first-party-docs-are-indexed.test.ts` fails when a page outside `docs/` is not on it, so a
new stray doc has to be either moved into the handbook or added below with its reason. Prompt text,
discovery rules, test fixtures, per-package `README.md` and `CHANGELOG.md`, `.veyyon/` skills and
commands, and vendored trees are not prose pages and are not listed.

| Page | Why it lives there |
| --- | --- |
| [`AGENTS.md`](../AGENTS.md) | Read by agents working in this repository, from the repository root, which is where every agent harness looks for it. |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | The package map and the cross-cutting rules. Conventional at the root, and the first file a new contributor opens. |
| [`SECURITY.md`](../SECURITY.md), [`SUPPORT.md`](../SUPPORT.md) | GitHub reads these from the root to render the security and support links on the repository page. Moving them breaks that. |
| [`UPSTREAM.md`](../UPSTREAM.md) | The fork statement and where the legal notices live. Root-level because it is about the repository itself, not about the code in it. Lineage and the port pipeline are in [`docs/internal/porting-from-pi-mono.md`](internal/porting-from-pi-mono.md). |
| [`review.md`](../review.md) | The pull-request review procedure. Root-level so a reviewer reaches it without knowing the docs layout, and so an agent harness loads it beside `AGENTS.md`. |
| [`packages/coding-agent/DEVELOPMENT.md`](../packages/coding-agent/DEVELOPMENT.md) | Maps `src/` subsystems to their authoritative doc. It belongs beside the tree it maps, since a map that lives elsewhere goes stale the first time a directory moves. |
| [`packages/coding-agent/docs/modal-shell.md`](../packages/coding-agent/docs/modal-shell.md) | The `ModalShell` overlay contract, read while editing the component it specifies. |
| [`packages/ai/src/utils/schema/CONSTRAINTS.md`](../packages/ai/src/utils/schema/CONSTRAINTS.md) | The normalization and strictness contract for the module it sits in, and the module is the only reader. |
| [`packages/argot/SPEC.md`](../packages/argot/SPEC.md), [`packages/argot/INTEGRATING.md`](../packages/argot/INTEGRATING.md) | `argot` is published standalone and cannot depend on this repository's docs. Its spec and integration guide ship with the package. |
| [`python/veybot/AGENTS.md`](../python/veybot/AGENTS.md), [`python/veybot/docs/pr-review-handoff.md`](../python/veybot/docs/pr-review-handoff.md) | veybot is a separate Python tool with its own tree; its docs stay with it. |
| [`packages/evals/datasets/dicts/report.md`](../packages/evals/datasets/dicts/report.md) | Generated by `gen-dicts.ts` and stamped with the run that produced it. A generated artifact, not a page to edit. |
| [`packages/evals/docs/deep-swe/ADAPTER_AUTHORING.md`](../packages/evals/docs/deep-swe/ADAPTER_AUTHORING.md), [`packages/evals/docs/deep-swe/MEASUREMENT_TOOLS.md`](../packages/evals/docs/deep-swe/MEASUREMENT_TOOLS.md), [`packages/evals/docs/manager.md`](../packages/evals/docs/manager.md) | Author-facing reference for the eval harness: how to write a system adapter, how measurement tools are structured, and how the run store and dashboard are operated. They live with the package they document. |
| [`packages/evals/docs/deep-swe/ARMS_REFERENCE.md`](../packages/evals/docs/deep-swe/ARMS_REFERENCE.md), [`packages/evals/docs/deep-swe/EVAL_GUIDE.md`](../packages/evals/docs/deep-swe/EVAL_GUIDE.md), [`packages/evals/docs/deep-swe/RUN_FORMAT.md`](../packages/evals/docs/deep-swe/RUN_FORMAT.md) | Operator reference for one suite: the arms it ships, how to run it, and the on-disk shape of a run directory. Each is read beside the arm files and run outputs it describes. |
| [`packages/evals/docs/terminal-bench.md`](../packages/evals/docs/terminal-bench.md) | Operator reference for the Terminal-Bench 3.0 suite: the pinned dataset, the task lists, and how a run reaches Harbor. It lives with the suite it documents. |
| [`packages/evals/docs/harnesses.md`](../packages/evals/docs/harnesses.md), [`packages/evals/docs/backends.md`](../packages/evals/docs/backends.md), [`packages/evals/docs/dashboard.md`](../packages/evals/docs/dashboard.md) | One page per layer of the eval harness: the harness registry and its adapters, the execution backends a suite runs on, and the dashboard served over the run store. Each is read beside the code it documents. |
| [`packages/evals/docs/runs.md`](../packages/evals/docs/runs.md) | The run engine: how a plan is computed, what a run id commits to, the trial journal, and the order `executeRun` refuses in. It is read beside `src/run/`. |
| [`packages/evals/docs/typescript-edit.md`](../packages/evals/docs/typescript-edit.md), [`packages/evals/docs/search-bench.md`](../packages/evals/docs/search-bench.md) | Operator reference for the typescript-edit suite and the offline search bench: their corpora, their registered cases and arms, and how each is run. They live with the code that owns the fixtures. |
| [`scripts/rewrite-system-prompt.style.md`](../scripts/rewrite-system-prompt.style.md), [`scripts/session-stats/audit-prompt.md`](../scripts/session-stats/audit-prompt.md), [`scripts/upstream-port-issue.md`](../scripts/upstream-port-issue.md) | Prompt text a script feeds to a model. Markdown because the model reads markdown, not because a human does. |
| [`website/blog/argot.md`](../website/blog/argot.md), [`website/blog/secrets.md`](../website/blog/secrets.md) | Published and draft blog posts. Their home is the website's content tree. |

Runnable examples are code, not prose: they live in `packages/coding-agent/examples/` beside the
package they extend.
