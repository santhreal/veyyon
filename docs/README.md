# Veyyon documentation

Documentation is split by audience. Keep the split when adding pages.

- **`docs/handbook/`** — the user handbook (mdBook). Start here as an operator: install, quickstart, features, settings, reference. Built output lands in `docs/handbook/book/`.
- **`docs/*.md`** — user- and integrator-facing reference pages that go deeper than the handbook: per-feature configuration (`settings.md`, `mcp-config.md`, `keybindings.md`, …), authoring guides (`custom-tools.md`, `extensions.md`, `skills.md`), and integration surfaces (`sdk.md`, `rpc.md`).
- **`docs/tools/`** — per-tool reference (bash, grep, task, resolve, …).
- **`docs/skills/`** — authoring skill guides shipped with the repo.
- **`docs/internal/`** — contributor and implementation docs: architecture notes, runtime internals, native-crate plumbing, porting notes, and errata. Nothing in here is needed to *use* Veyyon; it documents how the code works for people changing it. `packages/coding-agent/DEVELOPMENT.md` is the map into these.

Rules of thumb:

- If a page explains behavior an operator can observe or configure, it belongs at `docs/` top level (or the handbook).
- If a page explains how a subsystem is implemented — pipelines, lifecycles, binding contracts, migration/porting notes — it belongs in `docs/internal/`.
- One page per topic. Extend the existing page instead of adding a second one on the same subject.
