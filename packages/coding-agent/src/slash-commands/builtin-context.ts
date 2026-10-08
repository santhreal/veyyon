/**
 * Handlers for the `context` builtin slash commands.
 *
 * Split out of `builtin-registry.ts`, which is now the composition root: it imports the eight
 * domain maps and assembles them. The domain a command belongs to is decided in one place,
 * `builtin-categories.ts`, and `test/slash-commands/a-builtin-lives-in-the-domain-it-is-categorised-under.test.ts`
 * fails when this file and that map disagree, so the two cannot drift.
 */
import { parseCompactArgs } from "@veyyon/kernel/session/compact-modes";
import { formatShakeSummary, type ShakeMode } from "@veyyon/kernel/session/shake-types";
import { buildMemoryPayloadForDisplay, resolveMemoryBackend } from "../memory/backend";
import type { HandoffResult } from "../session/agent-session-types";
import { displayedContextUsage } from "../session/non-message-tokens";
import { argumentHandlerTui } from "./builtin-shared";
import type { BuiltinSlashCommandHandlers } from "./handler-types";
import { buildContextReportText } from "./helpers/context-report";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleTodoAcp } from "./helpers/todo";

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

/** Parse the `/shake` subcommand into a {@link ShakeMode}; empty defaults to elide. */
export function parseShakeMode(args: string): ShakeMode | { error: string } {
	const verb = args.trim().toLowerCase();
	if (verb === "" || verb === "elide") return "elide";
	if (verb === "images") return "images";
	return { error: `Unknown /shake mode "${verb}". Use elide or images.` };
}

/** What the context builtins DO, keyed by the name each is declared under. */
export const CONTEXT_HANDLERS = {
	todo: {
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Manage the shared todo list · empty";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `Manage the shared todo list · ${pending + inProgress} open (${inProgress} in progress, ${completed} done)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			runtime.ctx.editor.setText("");
		},
	},
	context: {
		getTuiAutocompleteDescription: runtime => {
			// A session at rest measures nothing: measuring builds every tool's schema, and the first
			// keystroke of a launch opens this popup.
			const usage = displayedContextUsage(runtime.ctx.session);
			if (!usage) return "Show context usage breakdown";
			// Same vocabulary as the status-line gauge: tok/tok in one unit, and the
			// percentage names what it is instead of leaving "17%" to be read as
			// either consumption or room.
			const left = Math.max(0, 100 - Math.round(usage.percent));
			return `Show context usage breakdown · ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)} · ${left}% left`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			runtime.ctx.editor.setText("");
		},
	},
	compact: {
		getTuiAutocompleteDescription: runtime => {
			const usage = displayedContextUsage(runtime.ctx.session);
			return usage
				? `Compact the session context · ${Math.round(usage.percent)}% used`
				: "Compact the session context";
		},
		handle: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);
			// Retired non-handoff names still compact, and must never do so quietly.
			if (parsed.notice) await runtime.output(parsed.notice);
			const before = runtime.session.getContextUsage?.();
			const beforeTokens = before?.tokens;
			try {
				await runtime.session.compact(parsed.instructions, parsed.mode ? { mode: parsed.mode } : undefined);
			} catch (err) {
				// Compaction precondition failures (no model, already compacted, too
				// small) and provider errors propagate as plain Errors; surface them
				// via runtime.output so they don't fail the ACP prompt turn.
				return usage(`Compaction failed: ${errorMessage(err)}`, runtime);
			}
			const after = runtime.session.getContextUsage?.();
			const afterTokens = after?.tokens;
			if (beforeTokens != null && afterTokens != null) {
				const saved = beforeTokens - afterTokens;
				await runtime.output(`Compaction complete. Tokens: ${beforeTokens} -> ${afterTokens} (saved ${saved}).`);
			} else {
				await runtime.output("Compaction complete.");
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const parsed = parseCompactArgs(command.args);
			runtime.ctx.editor.setText("");
			if ("error" in parsed) {
				runtime.ctx.showWarning(parsed.error);
				return;
			}
			// Retired non-handoff names still compact, and must never do so quietly.
			if (parsed.notice) runtime.ctx.showWarning(parsed.notice);
			await runtime.ctx.handleCompactCommand(parsed.instructions, parsed.mode);
		},
	},
	shake: {
		handle: async (command, runtime) => {
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") return usage(mode.error, runtime);
			const result = await runtime.session.shake(mode);
			await runtime.output(formatShakeSummary(result));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const mode = parseShakeMode(command.args);
			if (typeof mode !== "string") {
				runtime.ctx.showWarning(mode.error);
				return;
			}
			await runtime.ctx.handleShakeCommand(mode);
		},
	},
	handoff: {
		/**
		 * The text-mode half of `/handoff`, so a client without a terminal can run the operation the
		 * `/compact handoff` refusal points it at.
		 *
		 * It mirrors the TUI guard rather than the TUI presentation: the streaming refusal and the
		 * cancellation wording are the same sentences, and what is dropped is the spinner, the
		 * transcript repaint and the editor reset, none of which exist here. `session.handoff` throws
		 * its preconditions ("Nothing to hand off"), so they surface as the failure line instead of
		 * as a success the caller would have to disbelieve.
		 */
		handle: async (command, runtime) => {
			if (runtime.session.isStreaming) {
				return usage("Wait for the current response to finish or abort it before handing off.", runtime);
			}
			let result: HandoffResult | undefined;
			try {
				result = await runtime.session.handoff(command.args.trim() || undefined);
			} catch (err) {
				const message = errorMessage(err);
				return usage(message === "Handoff cancelled" ? message : `Handoff failed: ${message}`, runtime);
			}
			if (!result) return usage("Handoff cancelled", runtime);
			// The transcript underneath the caller's session id was replaced, so anything deriving a
			// title from it is now stale.
			await runtime.notifyTitleChanged?.();
			await runtime.output(
				result.savedPath
					? `New session started with handoff context. Handoff document saved to: ${result.savedPath}`
					: "New session started with handoff context.",
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const customInstructions = command.args || undefined;
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleHandoffCommand(customInstructions);
		},
	},
	btw: { handleTui: argumentHandlerTui((ctx, question) => ctx.handleBtwCommand(question)) },
	tan: { handleTui: argumentHandlerTui((ctx, work) => ctx.handleTanCommand(work)) },
	rephrase: {
		handleTui: (_command, runtime) => {
			runtime.ctx.handleRephraseCommand();
		},
	},
	memory: {
		handle: async (command, runtime) => {
			const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
			const backend = await resolveMemoryBackend(runtime.settings);
			switch (verb) {
				case "view": {
					const payload = await buildMemoryPayloadForDisplay(
						backend,
						runtime.settings.getAgentDir(),
						runtime.settings,
						runtime.session,
					);
					await runtime.output(payload || "Memory payload is empty.");
					return commandConsumed();
				}
				case "clear":
				case "reset": {
					await backend.clear(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.session.refreshBaseSystemPrompt("slash-command");
					await runtime.output("Memory cleared.");
					return commandConsumed();
				}
				case "enqueue":
				case "rebuild": {
					await backend.enqueue(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output("Memory consolidation enqueued.");
					return commandConsumed();
				}
				case "stats":
				case "diagnose": {
					const hook = verb === "stats" ? backend.stats : backend.diagnose;
					const payload = await hook?.(runtime.settings.getAgentDir(), runtime.cwd, runtime.session);
					await runtime.output(payload ?? `Memory ${verb} is not available for the ${backend.id} backend.`);
					return commandConsumed();
				}
				case "mm":
					return usage(
						"Mental-model maintenance via /memory mm is unsupported in ACP mode; use the hindsight HTTP API directly.",
						runtime,
					);
				default:
					return usage("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild>", runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleMemoryCommand(command.text);
		},
	},
} satisfies Partial<BuiltinSlashCommandHandlers>;
