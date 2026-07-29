/**
 * Child process for `failclosedguardhunt-shutdown-flush.test.ts`.
 *
 * Not a suite: it ends in `process.exit(0)` from inside the code under test, so
 * it cannot run in the parent's test runner. The parent spawns it and inspects
 * the marker file this leaves behind.
 *
 * Reaches the headless `ExtensionCommandContext.shutdown` the supported way: a
 * session with no extension runner publishes its own command context, and a
 * custom command is how a caller gets hold of it.
 */

import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@veyyon/coding-agent/extensibility/custom-commands";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";

const markerPath = process.argv[2];
if (!markerPath) throw new Error("child requires a marker path argument");
const disposeDelayMs = Number(process.argv[3] ?? "50");

const model = getBundledModel("openai", "gpt-4o-mini");
if (!model) throw new Error("expected bundled gpt-4o-mini");

// The custom-command path never reads the registry, and a real one needs auth
// storage on disk.
const modelRegistry = {} as ModelRegistry;

const customCommands: LoadedCustomCommand[] = [
	{
		path: "shutdown-command.ts",
		resolvedPath: "/test/shutdown-command.ts",
		source: "project",
		command: {
			name: "bye",
			description: "invokes ctx.shutdown()",
			execute(_args, ctx) {
				// `HookCommandContext` does not declare `shutdown`, but the object
				// AgentSession passes is spread from `ExtensionCommandContext`,
				// which does. Narrow rather than assert, so the day that stops
				// being true this fails loudly here instead of silently skipping
				// the very call the test exists to make.
				if (!("shutdown" in ctx) || typeof ctx.shutdown !== "function") {
					throw new Error("command context is missing shutdown()");
				}
				ctx.shutdown();
			},
		},
	},
];

const session = new AgentSession({
	agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
	sessionManager: SessionManager.inMemory(),
	settings: Settings.isolated({}),
	modelRegistry,
	customCommands,
});

// Stand in for the real flush. An own property shadows the prototype method, so
// the `this.dispose()` inside `shutdown` resolves here. The delay is what makes
// the ordering observable: a shutdown that abandons the flush exits before this
// ever writes, and the marker stays absent.
session.dispose = async (): Promise<void> => {
	await Bun.sleep(disposeDelayMs);
	await Bun.write(markerPath, "disposed");
};

await session.prompt("/bye");

// `shutdown()` returns immediately by design: it hands the flush to a promise
// chain that exits once dispose settles. So wait, rather than racing it. If the
// process is still alive after this, shutdown never exited and the marker below
// records that instead of the flush.
await Bun.sleep(10_000);
await Bun.write(markerPath, "shutdown-did-not-exit");
process.exit(3);
