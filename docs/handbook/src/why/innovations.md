# What makes Veyyon different

These ideas set Veyyon apart. Each is shipped unless noted as **Spec — not shipped**.

For a reader-first pass, start with the benefit chapters. This page is the compact design map.

## Hashline-first editing

Open models emit reliable **hashline** patches when the harness matches their training. Veyyon's `edit`
and `write` tools apply hashline patches with verification before bytes hit disk, so an edit either
lands exactly or fails loudly with recovery hints.

See [Editing and repair](../using/editing.md) and [The hashline edit engine](../edit/engine.md).

## Tool approval by tier (autonomy ladder)

`tools.approvalMode` (`plan`, `ask`, `auto-edit`, `yolo`; legacy `always-ask` / `write` aliases) and
per-tool `tools.approval` overrides gate read, write, and exec tiers. Bash can force prompts on
destructive patterns even in permissive modes.

See `docs/approval-mode.md` and `/settings` → Advanced → Safety.

## Every model in the harness it fits

Model selection is three explicit slots — the **interactive** model (chosen with `/model`), the
**subagent** model, and the **compaction** model (both set in settings). No `default` model stands in
for the others. Optional named **roles** live in settings, scoped per profile, for anyone who wants
specific work types pinned to specific models. Prompts and tool exposure adapt per model and per agent
kind (main vs subagent).

## Provider-agnostic runtime

The agent loop, TUI, session format, MCP, skills, hooks, and extensions are provider-neutral. You configure providers in `~/.veyyon/agent/config.yml` or via `/setup` / `/providers`.

## Control flow in the harness

Compaction, goal continuation, plan mode, vibe mode, and task subagents are engine features, not persona-only instructions. Goal mode can auto-continue idle sessions toward an objective; plan mode drafts a plan file before mutating the repo.

## Spec — not shipped (documented elsewhere)

- A full schema-based tool-call repair cascade. General schema repair on tool calls is shipped; the
  broader cascade is planned. See [Repair overview](../repair/overview.md).
- Self-contained profiles that own isolated MCP/skills copies per profile. Today profiles relocate the
  agent directory to `~/.veyyon/profiles/<name>/agent/`.
- A top-level `veyyon doctor` install-health command. Use `veyyon plugin doctor` and `/debug` today.

## Where to go next

- [Performance](./performance.md)
- [The thesis: the harness is the lever](../foundations/thesis.md)
- [Roles and profiles](../using/roles-and-profiles.md)
