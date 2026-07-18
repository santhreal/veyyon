# Custom hooks guide

Hooks run at points in the session lifecycle (before/after tools, session start, compaction, and related events). They are **TypeScript modules** that default-export a factory and register handlers with `pi.on(...)`.

Reference: [Hooks](./hooks.md) and repository `docs/hooks.md`.

## Minimal example

Place a file under a discovered hooks directory (for example `.veyyon/hooks/policy.ts`):

```ts
import type { HookAPI } from "@veyyon/coding-agent/extensibility/hooks";

export default function (pi: HookAPI): void {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			const cmd = String(event.input.command ?? "");
			if (/\brm\s+-rf\b/.test(cmd)) {
				return { block: true, reason: "destructive rm blocked by project hook" };
			}
		}
	});
}
```

Load via discovery or pass the path with `--extension` / `--hook`.

## Typical uses

- Block or annotate specific tools before they run
- Inject project policy text when a session starts
- Audit tool usage outside the TUI
- Register project-local slash commands

## Events

Event names and payloads are defined in `packages/coding-agent/src/extensibility/hooks/types.ts`. Common surfaces include tool call, permission-related gates (via the approval path), session lifecycle, and compaction. See `docs/hooks.md` for the typed list and return shapes (`block`, reasons, message injection).

## Related

- [Hooks](./hooks.md)
- [Approvals](./sandbox.md)
