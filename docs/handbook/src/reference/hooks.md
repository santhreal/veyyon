# Hooks

A hook is an extension module registered under the `hooks` capability. It is loaded by the extension loader, its handlers bind to the extension runner, and its tool interception runs through `ExtensionToolWrapper`.

## Runtime loading

- `--hook` is treated as an alias for `--extension` (CLI paths are merged into `additionalExtensionPaths`)
- JS/TS hook factories discovered through `hookCapability` (for example `~/.veyyon/profiles/<name>/agent/hooks/pre/*.ts`; hooks are user-level only, a working tree's `.veyyon/hooks/` is not read) are loaded as extension modules so their `pi.on(...)` handlers bind to the runtime event bus
- a plugin's `hooks` manifest entry is loaded the same way
- tools are wrapped by `ExtensionToolWrapper`
- context transforms and lifecycle emissions go through `ExtensionRunner`

## Key files

- `src/extensibility/hooks/types.ts`: hook context, event types, and result contracts
- `src/extensibility/hooks/index.ts`: type exports
- `src/extensibility/extensions/loader.ts`: discovery and module loading
- `src/extensibility/extensions/runner.ts`: event dispatch, command lookup, error signaling
- `src/extensibility/extensions/wrapper.ts`: approval, pre/post tool interception

## What a hook module is

A hook module must default-export a factory:

```ts
import type { HookAPI } from "@veyyon/coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName === "bash" &&
      String(event.input.command ?? "").includes("rm -rf")
    ) {
      return { block: true, reason: "blocked by policy" };
    }
  });
}
```

The factory can:

- register event handlers with `pi.on(...)`
- send persistent custom messages with `pi.sendMessage(...)`
- persist non-LLM state with `pi.appendEntry(...)`
- register slash commands via `pi.registerCommand(...)`
- register custom message renderers via `pi.registerMessageRenderer(...)`
- run shell commands via `pi.exec(...)`
- author schemas/helpers with injected `pi.zod`, `pi.typebox`, and package exports via `pi.pi`

## Discovery and loading

A session loads JS/TS hook factories discovered by `hookCapability` through the extension runner. `discoverExtensionPaths(configuredPaths, cwd)` does:

1. Load native extension modules from the capability registry
2. Load importable `.ts`/`.js` hook factories from the hook capability registry
3. Append plugin extension entry points and plugin `hooks` entries
4. Append explicitly configured paths

`loadExtensions` then imports each path and expects a `default` function. A CommonJS module (`module.exports = factory`) is accepted.

### Path resolution

- absolute path: used as-is
- `~` path: expanded
- relative path: resolved against `cwd`

## Event surfaces

Hook events are strongly typed in `types.ts`.

### Session events

- `session_start`
- `session_before_switch` → can return `{ cancel?: boolean }`
- `session_switch`
- `session_before_branch` → can return `{ cancel?: boolean; skipConversationRestore?: boolean }`
- `session_branch`
- `session_before_compact` → can return `{ cancel?: boolean; compaction?: CompactionResult }`
- `session_compacting` → can return `{ context?: string[]; prompt?: string; preserveData?: Record<string, unknown> }`
- `session_compact`
- `session_before_tree` → can return `{ cancel?: boolean; summary?: { summary: string; details?: unknown } }`
- `session_tree`
- `session_shutdown`

### Agent/context events

- `context` → can return `{ messages?: Message[] }`
- `before_agent_start` → can return `{ message?: { customType; content; display; details; attribution? } }`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `auto_compaction_start`
- `auto_compaction_end`
- `auto_retry_start`
- `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`

### Tool events (pre/post model)

- `tool_call` (pre-execution) → can return `{ block?: boolean; reason?: string }`
- `tool_result` (post-execution) → can return `{ content?; details?; isError? }`

```text
Tool interception flow

approval policy
   │
   ├─ denied ──> throw (no handler runs)
   │
   ▼
tool_call handlers
   │
   ├─ any { block: true }, a throw, or a timeout? ── yes ──> throw (tool blocked)
   │
   └─ no
      │
      ▼
   execute underlying tool
      │
      ├─ success ──> tool_result handlers can override { content, details, isError }
      │
      └─ error   ──> emit tool_result(isError=true); an override returns as an isError result,
                     otherwise the original error is rethrown
```

## Execution model and mutation semantics

`ExtensionToolWrapper.execute()` in `src/extensibility/extensions/wrapper.ts` runs every tool call.

### 1) Approval

The approval policy (`tools.approvalMode`, `tools.approval.<tool>`) is checked before any handler runs. A denied call throws `Tool call denied by user: <tool>` and reaches no handler.

### 2) Pre-execution: `tool_call`

- if any handler returns `{ block: true }`, execution stops and the returned `reason` becomes the thrown error text
- if a handler throws or times out, the call is blocked with a reason that names the extension path

### 3) Tool execution

The underlying tool executes if not blocked. A cancellation (abort or deadline) propagates as thrown and reaches no `tool_result` handler.

### 4) Post-execution: `tool_result`

After execution, the wrapper emits `tool_result` with `toolName`, `toolCallId`, `input`, `content`, `details` and `isError`. A tool that threw is emitted with `isError: true` and the error message as its text content.

If a handler returns overrides:

- `content` replaces the result content
- `details` replaces the result details
- `isError` replaces the error state: a handler can rewrite a failed call's content while keeping it an error, flip a failure to success, or flag a success as an error

When no handler returns an override, a failed call rethrows its original error.

### What hooks can mutate

- LLM context for a single call via `context` (`messages` replacement chain)
- tool output content, details and error state via `tool_result`
- pre-agent injected message via `before_agent_start`
- cancellation/custom compaction/tree behavior via `session_before_*` and `session_compacting`

### What hooks cannot mutate

- raw tool input parameters in-place (only block/allow on `tool_call`)
- the approval decision, which is taken before any handler runs

## Ordering and conflict behavior

### Discovery-level ordering

Capability providers are priority-sorted (higher first). Dedupe is by capability key, first wins.

For `hooks`, capability key is `${type}:${tool}:${name}`. Shadowed duplicates from lower-priority providers are marked and excluded from effective discovered list.

### Load order

`discoverExtensionPaths` lists native extension modules, then discovered hook factories, then plugin extension entry points, then configured paths, deduped by resolved absolute path. File order within a discovered directory is `readdir` order.

### Runtime handler order

Inside `ExtensionRunner`, handlers run in load order, then in registration order within a module.

- `tool_call`: the first `{ block: true }` short-circuits; a handler that throws or does not answer within the handler timeout blocks the call with a reason that names the extension path
- `tool_result`: each handler receives the event as modified by the handlers before it; the last value set for `content`, `details` and `isError` wins

Command conflicts: a name two extensions register is reported once per session to the operator channel, and the later registration wins. A name that collides with a built-in command is reported the same way.

## UI interactions (`HookContext.ui`)

`HookUIContext` includes:

- `select`, `confirm`, `input`, `editor`
- `notify`
- `setStatus`
- `custom`
- `setEditorText`, `getEditorText`
- `theme` getter

`ctx` includes `hasUI`, `cwd`, `sessionManager`, `modelRegistry`, current `model`, `isIdle()`, `abort()`, and `hasQueuedMessages()`.

When running with no UI, the default no-op context behavior is:

- `select/input/editor` return `undefined`
- `confirm` returns `false`
- `notify`, `setStatus`, `setEditorText` are no-ops
- `getEditorText` returns `""`

### Status line behavior

Hook status text set via `ctx.ui.setStatus(key, text)` is:

- stored per key
- sorted by key name
- sanitized (ANSI/VT escape sequences stripped; control characters mapped to spaces; repeated spaces collapsed; trimmed)
- joined and width-truncated for display

## Error propagation and fallback

### Load-time

- an import that throws, a missing default export, or a factory that throws → captured in `LoadExtensionsResult.errors` and reported to the operator channel
- loading continues for other modules

### Event-time

`ExtensionRunner` catches a handler error for most events and emits it to error listeners (`extensionPath`, `event`, `error`), then continues.

`emitToolCall(...)` is stricter: a handler that throws or times out blocks the tool call, with a reason that names the extension path.

## Realistic API examples

### Block unsafe bash commands

```ts
import type { HookAPI } from "@veyyon/coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input.command ?? "");
    if (!cmd.includes("rm -rf")) return;

    if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI)" };
    const ok = await ctx.ui.confirm("Dangerous command", `Allow: ${cmd}`);
    if (!ok) return { block: true, reason: "user denied command" };
  });
}
```

### Redact tool output on post-execution

```ts
import type { HookAPI } from "@veyyon/coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read" || event.isError) return;

    const redacted = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      return {
        ...chunk,
        text: chunk.text.replaceAll(/API_KEY=\S+/g, "API_KEY=[REDACTED]"),
      };
    });

    return { content: redacted };
  });
}
```

### Modify model context per LLM call

```ts
import type { HookAPI } from "@veyyon/coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.on("context", async (event) => {
    const filtered = event.messages.filter(
      (msg) => !(msg.role === "custom" && msg.customType === "debug-only"),
    );
    return { messages: filtered };
  });
}
```

### Register slash command with command-safe context methods

```ts
import type { HookAPI } from "@veyyon/coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
  pi.registerCommand("handoff", {
    description: "Create a new session with setup message",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [
              { type: "text", text: "Continue from prior session summary." },
            ],
            timestamp: Date.now(),
          });
        },
      });
    },
  });
}
```

## Export surface

`src/extensibility/hooks/index.ts` and the package subpath `@veyyon/coding-agent/extensibility/hooks` export the hook types only: `HookAPI`, `HookContext`, `HookCommandContext`, `HookUIContext`, the event and result types, and `ExecOptions`/`ExecResult`. There is no hook loader, runner or tool wrapper; the extension runner loads and drives a hook module.

The package root (`@veyyon/coding-agent`) re-exports `HookAPI` and `HookContext`.
