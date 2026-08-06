# Veyyon documentation

Documentation is split by audience. Keep the split when adding pages.

- **`docs/handbook/`**: the user handbook (mdBook). Start here as an operator: install, quickstart, features, settings, reference. Built output lands in `docs/handbook/book/`.
- **`docs/*.md`**: user- and integrator-facing reference pages that go deeper than the handbook: per-feature configuration (`settings.md`, `mcp-config.md`, `keybindings.md`, …), authoring guides (`custom-tools.md`, `extensions.md`, `skills.md`), and integration surfaces (`sdk.md`, `rpc.md`).
- **`docs/tools/`**: per-tool implementation reference, one page per tool, indexed at [`docs/tools/README.md`](tools/README.md).
- **`docs/skills/`**: authoring skill guides shipped with the repo.
- **`docs/internal/`**: contributor and implementation docs: architecture notes, runtime internals, native-crate plumbing, porting notes, errata, the operations docs, and the design/brand docs. Start at the grouped index [`docs/internal/README.md`](internal/README.md); incident procedures are in [`docs/internal/runbooks/`](internal/runbooks/). Nothing in here is published to the website or needed to *use* Veyyon; it documents how the code works, ships, and looks for the people changing it. `packages/coding-agent/DEVELOPMENT.md` maps `src/` subsystems to their doc, and [`docs/adr/`](adr/) records the load-bearing decisions.

## Index of `docs/*.md`

Every page at this level, grouped by what you are trying to do. The handbook covers the
same ground more gently; these pages are the exhaustive version.

**Configuring a session**

| Page | Covers |
| --- | --- |
| [`settings.md`](settings.md) | Where settings come from, which layers a repository cannot write, and how a value is resolved |
| [`settings-reference.md`](settings-reference.md) | Every setting in `/settings`, generated from the schema |
| [`config-usage.md`](config-usage.md) | Which roots are scanned for configuration, in what precedence, and which subsystem reads each one |
| [`environment-variables.md`](environment-variables.md) | Every environment variable the code reads, with its default and the module that reads it |
| [`context-files.md`](context-files.md) | The Markdown instruction files discovered before a session starts and injected into the prompt |
| [`keybindings.md`](keybindings.md) | Default chords and how to remap them |
| [`theme.md`](theme.md) | Theme schema, loading order, runtime behavior, failure modes |

**Models and providers**

| Page | Covers |
| --- | --- |
| [`models.md`](models.md) | `models.yml`: loading, overrides, credential resolution, runtime model choice |
| [`providers.md`](providers.md) | The backends requests can route to, and what each one needs |
| [`system-prompt-customization.md`](system-prompt-customization.md) | How the system prompt is assembled and which parts you can change |
| [`advisor-watchdog.md`](advisor-watchdog.md) | The optional second model that reviews the transcript, and its `WATCHDOG.yml` rules |
| [`compaction.md`](compaction.md) | Compaction and branch summaries: what keeps a long session usable |
| [`memory.md`](memory.md) | Autonomous memory: extraction from past sessions and injection into the prompt |

**Tools and execution**

| Page | Covers |
| --- | --- |
| [`approval-mode.md`](approval-mode.md) | The two independent inputs to a tool-approval decision |
| [`custom-tools.md`](custom-tools.md) | Writing a model-callable function that joins the built-in execution pipeline |
| [`python-repl.md`](python-repl.md) | The Python backend behind the `eval` tool |
| [`lsp-config.md`](lsp-config.md) | Configuring language servers |
| [`mcp-config.md`](mcp-config.md) | Adding, editing and validating MCP servers |
| [`secrets.md`](secrets.md) | Secret obfuscation: keeping credentials out of provider requests |

**Extending Veyyon**

| Page | Covers |
| --- | --- |
| [`extensions.md`](extensions.md) | Authoring a runtime extension |
| [`hooks.md`](hooks.md) | The hook subsystem and how the extension runner loads it |
| [`skills.md`](skills.md) | File-backed capability packs, discovered at startup |
| [`marketplace.md`](marketplace.md) | Discovering and installing plugins from Git, local paths, or a catalog |
| [`tui.md`](tui.md) | The TUI contract available to extensions and custom tools |

**Integrating**

| Page | Covers |
| --- | --- |
| [`sdk.md`](sdk.md) | The in-process integration surface |
| [`rpc.md`](rpc.md) | Newline-delimited JSON protocol over stdio |
| [`collab.md`](collab.md) | Live session sharing |

**Sessions**

| Page | Covers |
| --- | --- |
| [`tree.md`](tree.md) | `/tree`: moving the active leaf inside a session file |

Subdirectory indexes: [`tools/`](tools/README.md), [`internal/`](internal/README.md),
[`adr/`](adr/README.md). [`skills/`](skills/) holds three authoring guides
(extensions, hooks, marketplaces) and [`migration/`](migration/) holds the three contracts
a port has to satisfy (conformance format, hashline, mnemopi).

## Prose that lives outside `docs/`

A handful of first-party pages sit next to the thing they describe rather than under `docs/`, and each one has a reason. The list is exhaustive and `scripts/first-party-docs-are-indexed.test.ts` fails when a page outside `docs/` is not on it, so a new stray doc has to be either moved here or added below with its reason. Prompt text, discovery rules, test fixtures, per-package `README.md` and `CHANGELOG.md`, `.veyyon/` skills and commands, and vendored trees are not prose pages and are not listed.

| Page | Why it lives there |
| --- | --- |
| [`AGENTS.md`](../AGENTS.md) | Read by agents working in this repository, from the repository root, which is where every agent harness looks for it. |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | The package map and the cross-cutting rules. Conventional at the root, and the first file a new contributor opens. |
| [`SECURITY.md`](../SECURITY.md), [`SUPPORT.md`](../SUPPORT.md) | GitHub reads these from the root to render the security and support links on the repository page. Moving them breaks that. |
| [`UPSTREAM.md`](../UPSTREAM.md) | How this fork tracks `can1357/oh-my-pi`. Root-level because it is about the repository itself, not about the code in it. |
| [`release-notes.md`](../release-notes.md) | The staging buffer for the next release's notes, written by the release tooling. Not a page anyone reads outside a release. |
| [`packages/coding-agent/DEVELOPMENT.md`](../packages/coding-agent/DEVELOPMENT.md) | Maps `src/` subsystems to their authoritative doc. It belongs beside the tree it maps, since a map that lives elsewhere goes stale the first time a directory moves. |
| [`packages/coding-agent/docs/modal-shell.md`](../packages/coding-agent/docs/modal-shell.md) | The `ModalShell` overlay contract, read while editing the component it specifies. |
| [`packages/ai/src/utils/schema/CONSTRAINTS.md`](../packages/ai/src/utils/schema/CONSTRAINTS.md) | The normalization and strictness contract for the module it sits in, and the module is the only reader. |
| [`packages/argot/SPEC.md`](../packages/argot/SPEC.md), [`packages/argot/INTEGRATING.md`](../packages/argot/INTEGRATING.md) | `argot` is published standalone and cannot depend on this repository's docs. Its spec and integration guide ship with the package. |
| [`python/veybot/AGENTS.md`](../python/veybot/AGENTS.md), [`python/veybot/docs/pr-review-handoff.md`](../python/veybot/docs/pr-review-handoff.md) | veybot is a separate Python tool with its own tree; its docs stay with it. |
| [`packages/deepswe-bench/dicts/report.md`](../packages/deepswe-bench/dicts/report.md) | Generated by `gen-dicts.ts` and stamped with the run that produced it. A generated artifact, not a page to edit. |
| [`scripts/rewrite-system-prompt.style.md`](../scripts/rewrite-system-prompt.style.md), [`scripts/session-stats/audit-prompt.md`](../scripts/session-stats/audit-prompt.md), [`scripts/upstream-port-issue.md`](../scripts/upstream-port-issue.md) | Prompt text a script feeds to a model. Markdown because the model reads markdown, not because a human does. |
| [`website/blog/argot.md`](../website/blog/argot.md), [`website/blog/secrets.md`](../website/blog/secrets.md) | Published and draft blog posts. Their home is the website's content tree. |

Rules of thumb:

- If a page explains behavior an operator can observe or configure, it belongs at `docs/` top level (or the handbook).
- If a page explains how a subsystem is implemented, pipelines, lifecycles, binding contracts, migration/porting notes, it belongs in `docs/internal/`.
- One page per topic. Extend the existing page instead of adding a second one on the same subject.
- A page generated from code says so at the top and is regenerated in the same change as the code. [`settings-reference.md`](settings-reference.md) is rendered from the settings schema by `scripts/gen-settings-reference.ts`; a test fails when the committed file and the generator disagree. Prefer generating an exhaustive reference over hand-maintaining one, and keep the prose that explains it in the hand-written page next to it.
