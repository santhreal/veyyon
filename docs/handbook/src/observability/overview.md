# Observability

## Interactive and CLI usage

- Status line token and cost segments during interactive sessions
- `veyyon stats` (CLI) and `/usage` (TUI) via `@veyyon/stats` when enabled
- Structured logging in the coding-agent logger

## OpenTelemetry

When `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, the process exports agent-loop traces over OTLP/protobuf. See [Soundness and telemetry](../repair/soundness.md) and `packages/coding-agent/src/telemetry-export.ts`.

## Session debugging

`/dump`, `/context`, `/debug`, and standalone tool CLIs such as `veyyon grep` for inspecting what the agent would see.

## Recording raw provider traffic

When a model behaves in a way you cannot explain from the transcript, record the
exact HTTP exchange. Set `VEYYON_REQ_DEBUG=1` before starting veyyon:

```sh
VEYYON_REQ_DEBUG=1 veyyon
```

Every request writes two files into the directory you started veyyon from:

- `rr-session-N.json`, the request: method, URL, headers, and body. A JSON body
  is stored parsed under `body`; anything else is stored as `bodyText`, or as
  `bodyBase64` when it is not valid UTF-8.
- `rr-session-N.res.log`, the response: the status line and headers, then the
  raw body bytes exactly as they arrived, including every streaming chunk.

`N` counts up from 1 each time veyyon starts, and existing files are never
overwritten, so a second run in the same directory continues past the numbers
already there.

Two things are worth knowing before you turn it on. The files land in your
working directory rather than a cache directory, because you usually want to
read them next to the project you were working in; they are created readable by
you alone, and the repo `.gitignore` already covers `rr-session-*` so a stray
`git add` cannot pick one up. And a dump is the request as it went on the wire,
including file contents and whatever a provider echoed back, so treat it as
sensitive and delete it when you are done.

Credential headers do not go in. `Authorization`, `Cookie`, any header whose
name carries `api-key`, `auth-token`, `access-token` or `secret`, and their
response-side counterparts are written as `<redacted N chars>`: you can still
see that the header was sent and how long the value was, which is what a
debugging session needs, without the key itself sitting in a file you might
attach to a bug report. Bodies are recorded verbatim, so an OAuth token
exchange still puts a refresh token in the file.

Recording never interferes with the session it records. If a log cannot be
written, because the disk is full or the directory is read-only, veyyon logs an
error naming the file and the cause, stops recording that response, and lets the
response through untouched. You get your answer and a truncated log, not a
failed request.
