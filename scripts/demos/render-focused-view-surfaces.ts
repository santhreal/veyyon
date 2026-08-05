/**
 * Render the real stack of session-scoped surfaces above the composer — the todo
 * HUD, the subagent HUD, the pinned error banner and the quiet footline with its
 * running-agent count — for the MAIN view and for the view focused on an agent.
 *
 * This boots the real `InteractiveMode` against a real `AgentSession`, a real
 * `TUI` and a real `VirtualTerminal`, then focuses a real registered child the
 * same way `/agents` does, and prints the containers' own bytes. Nothing here is
 * a mock-up of the block: it is the block.
 *
 * The proof is a DIFFERENTIAL. Three variants:
 *
 *     --view main              the driving session, unchanged by the fix (control)
 *     --view focused --before  what the focused view painted BEFORE the fix
 *     --view focused           what it paints AFTER
 *
 * `--before` re-applies the pre-fix data flow to the same real components: the
 * todo board re-derived from the DRIVING session (`#loadTodoList` read `session`,
 * not `viewSession`), the pinned banner left in place (`clearTransientSessionUi`
 * never cleared the container), and the count badge left at the whole
 * conversation's tally. It is a reproduction of the defect, not a drawing of it.
 *
 * Run (FORCE_COLOR is required — piped output has no TTY and a colourless proof
 * cannot show a fill or a contrast bug):
 *
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-focused-view-surfaces.ts --view main |
 *       bun scripts/demos/render-proof.ts --out /tmp/focus/main --width 100 --scale 3
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-focused-view-surfaces.ts --view focused --before |
 *       bun scripts/demos/render-proof.ts --out /tmp/focus/focused-before --width 100 --scale 3
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-focused-view-surfaces.ts --view focused |
 *       bun scripts/demos/render-proof.ts --out /tmp/focus/focused-after --width 100 --scale 3
 *
 * Look at both grounds of every pair.
 */

import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { buildComposerShortcuts } from "../../packages/coding-agent/src/modes/components/composer-shortcuts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive-mode";
import { initTheme, setTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "../../packages/coding-agent/src/registry/agent-registry";
import { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { AuthStorage } from "../../packages/coding-agent/src/session/auth-storage";
import { SessionManager } from "../../packages/coding-agent/src/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../packages/coding-agent/src/task";
import { EventBus } from "../../packages/coding-agent/src/utils/event-bus";
import { VirtualTerminal } from "../../packages/tui/test/virtual-terminal";
import { flag, hasFlag, renderWidth } from "./render-args";

const view = flag("view", "main");
const before = hasFlag("before");
const width = renderWidth();

const mainDir = TempDir.createSync("@pi-focus-proof-main-");
const childDir = TempDir.createSync("@pi-focus-proof-child-");

await Settings.init({ inMemory: true, cwd: mainDir.path(), overrides: { "startup.quiet": true } });
await initTheme();
await setTheme("dark");

const authStorage = await AuthStorage.create(path.join(mainDir.path(), "proofauth.db"));
const modelRegistry = new ModelRegistry(authStorage);
const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected claude-sonnet-4-5 in the model registry");

function makeSession(dir: TempDir, prompt: string): AgentSession {
	return new AgentSession({
		agent: new Agent({ initialState: { model: model as never, systemPrompt: [prompt], tools: [], messages: [] } }),
		sessionManager: SessionManager.create(dir.path(), dir.path()),
		settings: Settings.isolated({ "startup.quiet": true }),
		modelRegistry,
	});
}

const mainSession = makeSession(mainDir, "Main");
const childSession = makeSession(childDir, "AuthLoader");

const eventBus = new EventBus();
const mode = new InteractiveMode(mainSession, "proof", undefined, undefined, undefined, eventBus);
const terminal = new VirtualTerminal(width, 30);
mode.ui = new TUI(terminal);
await mode.init({ suppressWelcomeIntro: true });

// The driving session's own state: a todo board, two detached spawns, and a
// failed turn pinned above the composer.
mainSession.setTodoPhases([
	{
		name: "Todos",
		tasks: [
			{ content: "Scope the focus leak across every session surface", status: "completed" },
			{ content: "Re-derive the todo board at the focus choke point", status: "in_progress" },
			{ content: "Prove the restored main view byte for byte", status: "pending" },
		],
	},
]);
await mode.reloadTodos();

for (const [index, spawn] of (
	[
		["AuthLoader", "Refactoring the auth flow"],
		["SchemaMigrator", "Migrating the users table"],
	] as const
).entries()) {
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: spawn[0],
		index,
		agent: "task",
		agentSource: "bundled",
		description: spawn[1],
		status: "started",
		parentToolCallId: `call-${spawn[0]}`,
		detached: true,
	});
}
// Drain the observer coalesce window (SUBAGENT_OBSERVER_UI_COALESCE_MS = 100).
await Bun.sleep(160);

mode.showPinnedError("Provider returned 529 overloaded — the turn did not complete");

for (const id of ["AuthLoader", "SchemaMigrator"]) {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: id === "AuthLoader" ? childSession : null,
		status: "running",
	});
}
mode.syncRunningSubagentBadge({ requestRender: false });

// A busy driving session with a queued message, so the composer chip band has
// both chips to lose: `esc interrupt` and the dequeue key.
Object.defineProperty(mainSession, "isStreaming", { get: () => true, configurable: true });
Object.defineProperty(mainSession, "queuedMessageCount", { get: () => 1, configurable: true });
mode.refreshComposerShortcuts();

if (view === "focused") {
	await mode.focusAgentSession("AuthLoader");
	if (before) {
		// The pre-fix data flow, replayed onto the same real components.
		mode.setTodos(mainSession.getTodoPhases());
		mode.showPinnedError("Provider returned 529 overloaded — the turn did not complete");
		mode.statusLine.setSubagentCount(2);
		mode.composerShortcuts.setShortcuts(
			buildComposerShortcuts(mode.keybindings, {
				busy: true,
				hasDraft: false,
				hasQueue: true,
				canBackgroundBash: false,
				focused: false,
			}),
		);
	}
}

const block = [
	...mode.todoContainer.render(width),
	...mode.subagentContainer.render(width),
	...mode.errorBannerContainer.render(width),
	mode.statusLine.renderQuietLine(width) ?? "",
	...mode.composerShortcuts.render(width),
];
process.stdout.write(`${block.join("\n")}\n`);

mode.stop();
await mainSession.dispose();
await childSession.dispose();
authStorage.close();
mainDir.removeSync();
childDir.removeSync();
process.exit(0);
