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

Addressable banner sections are `role`, `runtime`, `tool-policy`, `execution-workflow`, `delivery-contract`, `project`, `shorthand`, and `shorthand-handles`. Listed sections move first in the order you provide, after the fixed system-conventions preamble. Unlisted sections keep section-registry order. One provider-cache boundary remains: runtime sections (`project`, `shorthand`, and `shorthand-handles`) cannot move ahead of the static statement-assembled prefix. If you list a runtime section before a static section, Veyyon keeps the cache boundary and logs a warning. An unknown or non-string section rejects the whole list with a warning, so a hand-edited file cannot apply an order you did not write. `tools` follows the same rule: one invalid entry drops the whole allowlist rather than silently denying the model a tool. A `harness-profiles.yml` file that cannot be read or parsed is reported with its path and reason, and no profiles take effect. Custom system prompts have no banner sections, so Veyyon ignores this setting with a warning.

Disable all repair process-wide: `VEYYON_REPAIR_DISABLE=1`.

See [Why repair exists](./overview.md) and [Models](../using/models.md#harness-profiles).
