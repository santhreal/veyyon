# Per-model repair posture

The repair hook receives the active model id so behavior can vary by model. Configure overrides with **harness profiles**: `harness.profiles` in `config.yml`, or `harness-profiles.yml` in the agent dir. Keys are `provider/model-id` or `provider/*` wildcards.

```yaml
harness:
  profiles:
    "anthropic/claude-sonnet-4-20250514":
      repair: true
      tools: ["read", "edit", "grep", "bash"]
      promptSectionOrder: ["tool-policy", "delivery-contract"]
    "google/*":
      repair: false
```

| Field | Effect |
| --- | --- |
| `repair: false` | Skip schema repair for that model |
| `tools: [...]` | Filter the initial tool allowlist |
| `promptSectionOrder: [...]` | Reorder default system-prompt banner sections |

Addressable banner sections: `role`, `runtime`, `tool-policy`, `execution-workflow`, `delivery-contract`. Listed sections move to the front in the given order (after the fixed system-conventions preamble); unlisted sections keep template order after them. An unknown name rejects the whole list with a warning. Custom system-prompt templates have no banner sections, so the setting is ignored (with a warning).

Disable all repair process-wide: `VEYYON_REPAIR_DISABLE=1`.

See [Why repair exists](./overview.md) and [Models](../using/models.md#harness-profiles).
