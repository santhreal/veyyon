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

A provider error message carries the failing status and the body the server sent, with three
limits. At most 64 KiB of the body is read, and the message says so: `[truncated, showing
4096 of 65536 chars read, 134505 of 200041 bytes not read]`, or `read stopped at 65536 bytes`
when the server declared no length. Control characters and terminal escape sequences are
removed, so an error page cannot repaint the screen. Credential-shaped text is replaced with
`<redacted N chars>`: an `Authorization` or `Cookie` value, a bearer token, a JWT, and the
vendor key prefixes. A proxy or captive portal answering HTML instead of the provider is the
usual reason a message is truncated.

## Command or edit blocked or prompting

Policy is **`tools.approvalMode`** and `tools.approval`, plus the working-directory and secret-use boundaries (every rung except `yolo`) and hard-coded flagged bash patterns: the destructive ones prompt on every rung, `yolo` included, and the merely dangerous ones (`curl | sh`, `reboot`, `nc -e`) prompt on every rung below it. There is no OS command sandbox. Schema default is **`auto`**. See [Approvals](../features/sandbox.md) and [Configuration](./configuration.md).

## Truncated tool output

Tool results truncate at configured budgets; the result text should state that truncation occurred and how to continue (limit, offset, narrower query). See [Bounded reads and search](../context/reads-search.md).

## Related

- [Observability](../observability/overview.md)
