# Troubleshooting

Common failure paths.

## Install or startup

```shell
veyyon --version
veyyon plugin doctor
```

`veyyon plugin doctor` reports extension health and missing optional binaries/keys. Non-zero exit: fix the reported check and re-run.

## Provider errors

Check API key / auth store / `models.yml` for that provider id, base URL, and scopes. See [Models and providers](./models.md).

## Command or edit blocked or prompting

Policy is **`tools.approvalMode`** and `tools.approval` (plus execpolicy `.rules`). There is no OS command sandbox. Schema default is **`yolo`**. See [Approvals](../features/sandbox.md) and [Configuration](./configuration.md).

## Truncated tool output

Tool results truncate at configured budgets; the result text should state that truncation occurred and how to continue (limit, offset, narrower query). See [Context size and retries](../benefits/lower-cost.md), [Bounded reads and search](../context/reads-search.md).

## Related

- [Approvals and errors](../benefits/safety-errors.md)
- [Observability](../observability/overview.md)
