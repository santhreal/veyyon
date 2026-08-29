import { phasesToMarkdown, type TodoPhase } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";

export type TodoCommandControllerContext = Pick<
	InteractiveModeContext,
	"agent" | "session" | "sessionManager" | "setTodos" | "showError" | "showStatus" | "showWarning" | "ui"
>;

export const USAGE = [
	"Usage: /todo <verb> [args]",
	"  /todo                              Show current todos",
	"  /todo edit                         Open todos in $EDITOR",
	"  /todo copy                         Copy todos as Markdown to clipboard",
	"  /todo export [<path>]              Write todos to file (default: TODO.md)",
	"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
	"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /todo start  <task>                Mark task in_progress (fuzzy content match)",
	"  /todo done   [<task|phase>]        Mark task/phase/all completed",
	"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /todo rm     [<task|phase>]        Remove task/phase/all",
	"  /todo help                         Show this help",
].join("\n");

export function buildSystemReminder(action: string, phases: TodoPhase[], removed = false): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `The user manually modified the todo list (${action}).`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current todo list:", "", md, "</system-reminder>");
	return lines.join("\n");
}
