# Observability for repair and sessions

## Usage and sessions

- `/usage` in the TUI and `veyyon stats` on the CLI — token and usage views
- Status line token accounting (`token_*`, `context_pct`, `cost`)
- Coding-agent structured logger

## OpenTelemetry

When `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, the process registers an OTLP/protobuf trace exporter and exports agent-loop spans (`invoke_agent`, `chat`, `execute_tool`, …). Standard `OTEL_*` env vars apply (`OTEL_SERVICE_NAME`, headers, `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER=none`). Transport is `http/protobuf` only. See `packages/coding-agent/src/telemetry-export.ts`.

## Related

- [Observability](../observability/overview.md)
- [Repair cascade](./cascade.md)
