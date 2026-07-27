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

Addressable banner sections: `role`, `runtime`, `tool-policy`, `execution-workflow`, `delivery-contract`, plus the runtime sections `project`, `shorthand`, and `shorthand-handles`. Listed sections move to the front in the given order (after the fixed system-conventions preamble); unlisted sections keep template order after them. One boundary holds: runtime sections (`project`, `shorthand`, `shorthand-handles`) can never move ahead of template sections, because the template prefix is the provider-cached part. A runtime section listed ahead of a template section stays put and the harness logs a warning. An entry that is not a section name rejects the whole list with a warning, whether it is misspelled or not a string at all, so a hand-edited file can never apply an order you did not write. `tools` follows the same rule: one bad entry drops the whole allowlist rather than silently denying the model a tool. A `harness-profiles.yml` that cannot be read or parsed is reported with the path and the reason, and no profiles take effect. Custom system-prompt templates have no banner sections, so the setting is ignored (with a warning).

Disable all repair process-wide: `VEYYON_REPAIR_DISABLE=1`.

See [Why repair exists](./overview.md) and [Models](../using/models.md#harness-profiles).
