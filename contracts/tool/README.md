# @veyyon/tool

What a tool states about itself and what it returns.

A tool declares a spec, an approval tier and a result shape; the loop that schedules it, the host
that prompts for approval and the renderer that draws its result each read those declarations from
here. None of them is named. The package imports the message content blocks from `@veyyon/model`,
type-only, and nothing else.

## Exports

```ts
import type {
  ToolApproval,
  ToolApprovalDecision,
  ToolExample,
  ToolResult,
  ToolSpec,
  ToolTier,
  ToolUpdateCallback,
} from "@veyyon/tool";
```

## Model

- `ToolSpec` — the schema-independent declaration: `name`, `description`, `strict`, the
  `customFormat` grammar and `customWireName` a provider may emit, and the `examples` rendered into
  the wire description. `Tool<TParameters>` in `@veyyon/ai` extends it with `parameters`.
- `ToolExample`, `ToolCallExample`, `ToolCompareExample`, `ToolNoteExample` — one illustrative call,
  a bad/good pair, or a note.
- `ToolTier` — `read`, `write` or `exec`: the capability a tool exercises, which selects the approval
  modes that auto-approve it.
- `ToolApprovalDecision`, `ToolApproval` — a bare tier, a tier with a `reason`, an `override` and a
  `critical` floor, or a function of the parsed arguments returning either.
- `ToolResult<TDetails>` — the content blocks a tool returns, its `details`, and the `isError` and
  `useless` marks the loop and the compactor read.
- `ToolUpdateCallback<TDetails>` — the streaming update a running tool emits with a partial result.

## What stays behind

`Tool<TParameters>` and `TSchema` reference a schema library and stay in `@veyyon/ai`. `AgentTool`,
with `execute`, scheduling (`concurrency`, `interruptible`), intent handling and the stream matchers,
is the loop's own interface in `@veyyon/agent`, as are `renderCall` and `renderResult`, which hand a
tool a host theme; the host-agnostic `view` is `ToolViewRenderer` in `@veyyon/view`. `ToolSession`
in `@veyyon/coding-agent` is what the product hands a tool at execution and references the session,
the event bus and the extension API.
