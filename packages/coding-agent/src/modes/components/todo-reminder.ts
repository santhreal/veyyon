import { Box, Container, Spacer, Text } from "@veyyon/tui";
import { withIcon } from "../../modes/theme/icon-label";
import { theme } from "../../modes/theme/theme";
import {
	createBoundedTodoPreview,
	prioritizeTodoItems,
	TODO_REMINDER_PREVIEW_LIMIT,
	type TodoItem,
} from "../../tools/todo";

/**
 * Component that renders a todo completion reminder notification, committed into
 * the transcript like a TTSR notification so it stays anchored in history rather
 * than floating above the editor.
 * Shows when the agent stops with incomplete todos.
 */
export class TodoReminderComponent extends Container {
	#box: Box;

	constructor(
		private readonly todos: TodoItem[],
		private readonly attempt: number,
		private readonly maxAttempts: number,
	) {
		super();

		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	#rebuild(): void {
		this.#box.clear();

		const count = this.todos.length;
		const label = count === 1 ? "todo remains" : "todos remain";
		const header = withIcon(theme.icon.warning, `Continue: ${count} ${label} · ${this.attempt}/${this.maxAttempts}`);

		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const preview = createBoundedTodoPreview();
		const prefix = `  ${theme.checkbox.unchecked} `;
		for (const todo of prioritizeTodoItems(this.todos).slice(0, TODO_REMINDER_PREVIEW_LIMIT)) {
			if (!preview.push(prefix, todo.content)) break;
		}
		const lines = preview.lines;
		const hidden = count - lines.length;
		if (hidden > 0) lines.push(`  … ${hidden} more in todo state`);
		this.#box.addChild(new Text(theme.italic(lines.join("\n")), 0, 0));
	}
}
