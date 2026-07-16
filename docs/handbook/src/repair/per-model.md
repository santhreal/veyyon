# Per-model repair posture

> **Status: Partial — repair shipped; per-model knobs are an early cut via harness profiles.**

## Shipped

- **Repair** threads the active model through the repair hook, so per-model posture can vary.
- **Harness profiles:** `harness.profiles` in `config.yml` or `harness-profiles.yml` in the
  agent dir. Keys match `provider/model-id` or `provider/*` wildcards.

```yaml
harness:
  profiles:
    "anthropic/claude-sonnet-4-20250514":
      repair: true
      tools: ["read", "edit", "grep", "bash"]
      promptSectionOrder: ["activeRepo", "system", "project"]
    "google/*":
      repair: false
```

- `repair: false` skips schema repair for that model.
- `tools: [...]` filters the initial tool allowlist (MVP hint surface).
- `promptSectionOrder: [...]` reorders the top-level system-prompt blocks for that model. The three
  addressable blocks are `system` (the rendered `system-prompt.md`/custom prompt), `project` (the
  environment/workspace footer), and `activeRepo` (nested-repo notice, when applicable). Named
  blocks move to the front in the order given; unlisted blocks keep their default relative order
  after the named ones. This reorders whole blocks only — it does **not** reorder content *within*
  `system-prompt.md` (e.g. moving "Delegation" before "Tool Policy"), because that template renders
  as one piece, not a list of named sections.

Disable all repair: `VEYYON_REPAIR_DISABLE=1`.

## Spec — not shipped

- Per-`(model,tool,shape)` telemetry counters
- Strictness tables (refuse earlier vs coerce more) beyond the ambiguity guard
- Full `backends.toml` three-backend tuning
- Reordering *within* `system-prompt.md` (Skills vs. Tool Policy vs. Delegation, etc.) — only the
  three coarse top-level blocks above are addressable today; the template itself is monolithic.

See [Why repair exists](./overview.md) and [Models](../using/models.md#per-model-harness-profiles-mvp).
