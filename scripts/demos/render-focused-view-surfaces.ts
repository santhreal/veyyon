/**
 * Render the real stack of session-scoped surfaces above the composer — the todo
 * HUD, the agent HUD, the pinned error banner and the quiet footline with its
 * running-agent count — for the MAIN view and for the view focused on an agent.
 *
 * Initializes an interactive mode session with mock todo phases, running subagents,
 * error banners, and composer shortcuts. Renders the combined todo container, subagent
 * container, error banner, status line, and composer shortcuts for the main view or a
 * focused subagent view as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-focused-view-surfaces.ts [--view main|focused] [--before] [--width 100] [--theme dark]
 */

import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../hosts/terminal/engine/test/virtual-terminal";
import { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { buildComposerShortcuts } from "../../packages/coding-agent/src/modes/terminal/components/composer/composer-shortcuts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/terminal/interactive-mode";
import { AgentRegistry, MAIN_AGENT_ID } from "../../packages/coding-agent/src/registry/agent-registry";
import { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../packages/coding-agent/src/task";
import { EventBus } from "../../packages/coding-agent/src/utils/event-bus";
import { renderDemo } from "./render-args";

await renderDemo(
	async ({ width, flag, hasFlag }) => {
		const view = flag("view", "main");
		const before = hasFlag("before");

		const mainDir = TempDir.createSync("@pi-focus-proof-main-");
		const childDir = TempDir.createSync("@pi-focus-proof-child-");
		const authStorage = await AuthStorage.create(path.join(mainDir.path(), "proofauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in the model registry");

		function makeSession(dir: TempDir, prompt: string): AgentSession {
			return new AgentSession({
				agent: new Agent({
					initialState: { model: model as never, systemPrompt: [prompt], tools: [], messages: [] },
				}),
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
		await mode.init();

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

		for (const [index, spawn] of [
			["AuthLoader", "Refactoring the auth flow"],
			["SchemaMigrator", "Migrating the users table"],
		].entries()) {
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

		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 160);
		await promise;

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
		mode.syncRunningAgentBadge({ requestRender: false });

		Object.defineProperty(mainSession, "isStreaming", { get: () => true, configurable: true });
		Object.defineProperty(mainSession, "queuedMessageCount", { get: () => 1, configurable: true });
		mode.refreshComposerShortcuts();

		if (view === "focused") {
			await mode.focusAgentSession("AuthLoader");
			if (before) {
				mode.setTodos(mainSession.getTodoPhases());
				mode.showPinnedError("Provider returned 529 overloaded — the turn did not complete");
				mode.statusLine.setAgentCount(2);
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
			...mode.agentContainer.render(width),
			...mode.errorBannerContainer.render(width),
			mode.statusLine.renderQuietLine(width) ?? "",
			...mode.composerShortcuts.render(width),
		];

		mode.stop();
		await mainSession.dispose();
		await childSession.dispose();
		authStorage.close();
		mainDir.removeSync();
		childDir.removeSync();
		return block;
	},
	{ settings: true, defaultTheme: "dark" },
);
