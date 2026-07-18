# Feature flags

Veyyon gates optional behavior in two places: `features.*` keys in the settings schema, and
per-plugin feature gates managed with the **plugin** subcommand.

## Settings-schema flags (`features.*`)

Registered flags live in `config.yml` under dotted `features.*` keys and appear in
**Settings › Interaction** in the TUI. Unknown keys are rejected.

| Key | Default | Effect |
| --- | --- | --- |
| `features.unexpectedStopDetection` | off | Use a small model to detect when the assistant says it will continue but stops without tool calls, and automatically prompt it to continue. |

```yaml
features:
  unexpectedStopDetection: true
```

Per-run override:

```console
$ veyyon -c features.unexpectedStopDetection=true "long refactor; keep going until done"
```

## Plugin feature gates

Plugins can declare named features that you toggle per plugin:

```console
$ veyyon plugin features <plugin>                 # list a plugin's features
$ veyyon plugin features <plugin> --enable f1,f2  # turn features on
$ veyyon plugin features <plugin> --disable f1    # turn features off
$ veyyon plugin features <plugin> --set f1,f2     # replace the enabled set
```

See [Plugins](./plugins.md) for installation and management.

## Related

Tool approvals are not feature flags — they use `tools.approvalMode` and per-tool policy.
See [Approvals](./sandbox.md).
