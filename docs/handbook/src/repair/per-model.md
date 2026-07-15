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
    "google/*":
      repair: false
```

- `repair: false` skips schema repair for that model.
- `tools: [...]` filters the initial tool allowlist (MVP hint surface).

Disable all repair: `VEYYON_REPAIR_DISABLE=1`.

## Spec — not shipped

- Per-`(model,tool,shape)` telemetry counters
- Strictness tables (refuse earlier vs coerce more) beyond the ambiguity guard
- Full `backends.toml` three-backend tuning

See [Why repair exists](./overview.md) and [Models](../using/models.md#per-model-harness-profiles-mvp).
