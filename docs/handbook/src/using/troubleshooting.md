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

A provider error message contains the failing status and the body the server sent, with three
limits. At most 64 KiB of the body is read, and the message states it: `[truncated, showing
4096 of 65536 chars read, 134505 of 200041 bytes not read]`, or `read stopped at 65536 bytes`
when the server declared no length. Control characters and terminal escape sequences are
removed, so an error page cannot repaint the screen. Credential-shaped text is replaced with
`<redacted N chars>`: an `Authorization` or `Cookie` value, a bearer token, a JWT, and the
vendor key prefixes. A proxy or captive portal answering HTML instead of the provider is the
usual reason a message is truncated.

A streamed response is read one frame at a time: a line, a JSONL record, or an SSE event
ending at a blank line. One frame may occupy 64 MiB. A server or proxy that keeps sending
without ever sending the delimiter is stopped at that point, the connection is cancelled,
and the message states the protocol and both byte counts: `an SSE event arrived with no
blank-line dispatch: 67109376 bytes exceeded the 67108864 byte frame limit`. The same
bound covers a stream of `data:` lines that never dispatches and a keepalive comment sent
in a loop. This failure is never retried: the next attempt reaches the same peer.

## Command or edit blocked or prompting

Policy is **`tools.approvalMode`** and `tools.approval`, plus the working-directory and secret-use boundaries (every rung except `yolo`) and hard-coded flagged bash patterns: the destructive ones prompt on every rung, `yolo` included, and the merely dangerous ones (`curl | sh`, `reboot`, `nc -e`) prompt on every rung below it. There is no OS command sandbox. Schema default is **`auto`**. See [Approvals](../features/sandbox.md) and [Configuration](./configuration.md).

## Truncated tool output

Tool results truncate at configured budgets; the result text should state that truncation occurred and how to continue (limit, offset, narrower query). See [Bounded reads and search](../context/reads-search.md).

## Related

- [Observability](../observability/overview.md)
