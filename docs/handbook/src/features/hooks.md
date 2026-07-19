# Hooks

A hook lets you run your own code at a moment in the session: before a tool call, after a message,
when a turn ends. You use one to enforce policy (block a dangerous command), add context, or record
what happened. The example below refuses any `bash` command containing `rm -rf`.

A hook is a TypeScript module. You put it under a hook path (for example `.veyyon/hooks/`), and Veyyon
loads it through the extension runner. The module default-exports a factory function that registers
handlers with `pi.on(...)`, one handler per event you care about.

CLI: `--hook` is an alias for `--extension` (paths merge into extension loading).

Full API and event list: repository `docs/hooks.md` and `packages/coding-agent/src/extensibility/hooks/`.

## Module shape

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

- register handlers with `pi.on(...)`
- send custom messages with `pi.sendMessage(...)`
- persist non-LLM state with `pi.appendEntry(...)`
- register slash commands with `pi.registerCommand(...)`
- register message renderers with `pi.registerMessageRenderer(...)`
- run shell commands with `pi.exec(...)`

## Discovery

Hook/extension paths are resolved as absolute, `~`-expanded, or relative to cwd. Discovery loads capability-registered modules, importable `.ts`/`.js` factories, plugin extension entry points, and explicit paths.

## Lifecycle (extension bus)

Handlers attach to the runtime event bus used by the extension runner (tool call, session, compaction, and related events as defined in `types.ts`). Exact event names and payloads are in `packages/coding-agent/src/extensibility/hooks/types.ts` and `docs/hooks.md`.

## Related

- [Custom hooks guide](./hooks-guide.md)
- Repository `docs/hooks.md`
