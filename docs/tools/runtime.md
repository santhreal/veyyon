# runtime

> Execute kernel code cells or supervise shared project processes in a unified runtime.

## Source
- Entry: `packages/coding-agent/src/tools/runtime.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/runtime.md`
- Collaborators: `packages/coding-agent/src/tools/eval.ts`, `packages/coding-agent/src/tools/launch.ts`

## Enablement

Set `tools.unifiedRuntime: true`. The default `false` keeps the separate `eval` and `launch` tools.

## Operations
The `runtime` tool unifies evaluation kernel execution (`op: "exec"`) and process management (`op: "start" | "list" | "logs" | "wait" | "send" | "stop" | "restart" | "describe"`).
