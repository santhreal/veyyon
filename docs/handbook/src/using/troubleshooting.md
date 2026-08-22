# Troubleshooting

Common failure paths.

## Install or startup

```shell
veyyon --version
veyyon plugin doctor
```

`veyyon plugin doctor` reports extension health and missing optional binaries/keys. Non-zero exit: fix the reported check and re-run.

## Provider errors

Check API key / auth store / `models.yml` for that provider id, base URL, and scopes. See [Models and providers](../reference/models-yml.md).

## Command or edit blocked or prompting

Policy is **`tools.approvalMode`** and `tools.approval`, plus the working-directory and secret-use boundaries (every rung except `yolo`) and hard-coded flagged bash patterns: the destructive ones prompt on every rung, `yolo` included, and the merely dangerous ones (`curl | sh`, `reboot`, `nc -e`) prompt on every rung below it. There is no OS command sandbox. Schema default is **`auto`**. See [Approvals](../features/sandbox.md) and [Configuration](./configuration.md).

## Truncated tool output

Tool results truncate at configured budgets; the result text should state that truncation occurred and how to continue (limit, offset, narrower query). See [Bounded reads and search](../context/reads-search.md).

## Related

- [Observability](../observability/overview.md)
