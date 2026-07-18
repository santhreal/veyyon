# Approvals and errors

File writes and shell commands are gated by `tools.approvalMode` and related policy (execpolicy rules, project trust). There is no OS-level command sandbox.

## Behavior

- Approval mode selects which tiers (read / write / exec) auto-run vs prompt
- Denied or failed policy checks return to the model; they do not widen permissions
- Tool output records truncation when limits apply
- Invalid config and unrepairable tool arguments surface errors instead of silent defaults

## Details

- [Approvals](../features/sandbox.md)
- [Configuration](../using/configuration.md)
- [Repair](../repair/overview.md)
- [Observability](../observability/overview.md)
