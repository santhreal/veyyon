import { withIcon } from "../../modes/theme/icon-label";
import { theme } from "../../modes/theme/theme";
import {
	createBoundedTodoPreview,
	prioritizeTodoItems,
	TODO_REMINDER_PREVIEW_LIMIT,
	type TodoItem,
} from "../../tools/todo";
import { type TranscriptNote, TranscriptNoteComponent } from "./transcript-note";

/**
 * The todo completion reminder, committed into the transcript so it stays anchored in
 * history rather than floating above the editor. Shows when the agent stops with
 * incomplete todos.
 *
 * It is a {@link TranscriptNoteComponent}: a warning rail, a raised surface and its
 * own width, rather than the full-width inverse slab it used to be.
 */
export class TodoReminderComponent extends TranscriptNoteComponent {
	constructor(todos: TodoItem[], attempt: number, maxAttempts: number) {
		super(TodoReminderComponent.#note(todos, attempt, maxAttempts));
	}

	static #note(todos: TodoItem[], attempt: number, maxAttempts: number): TranscriptNote {
		const count = todos.length;
		const label = count === 1 ? "todo remains" : "todos remain";
		const headline = withIcon(
			theme.icon.warning,
			`Continue: ${count} ${label} ${theme.sep.dot.trim()} ${attempt}/${maxAttempts}`,
		);

		const preview = createBoundedTodoPreview();
		const prefix = `${theme.checkbox.unchecked} `;
		for (const todo of prioritizeTodoItems(todos).slice(0, TODO_REMINDER_PREVIEW_LIMIT)) {
			if (!preview.push(prefix, todo.content)) break;
		}
		const rows = preview.lines.map(row => theme.italic(theme.fg("text", row)));
		const hidden = count - preview.lines.length;
		if (hidden > 0) rows.push(theme.italic(theme.fg("muted", `… ${hidden} more in todo state`)));

		return { tone: "warning", headline, rows };
	}
}
