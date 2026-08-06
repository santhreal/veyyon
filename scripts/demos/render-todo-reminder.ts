/**
 * The todo reminder as the composer draws it, with a list long enough to clip.
 *
 * The reminder is not a list view: it shows the in-progress item and a count,
 * and the interesting question is what it does when the list is longer than the
 * room it has. Twelve items with the in-progress one at the end is the case
 * that exercises both, and reading the component cannot answer it because the
 * clipping happens at render width.
 *
 * Run:
 *
 *     bun scripts/demos/render-todo-reminder.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/todo-reminder --width 100
 *
 * `--theme <name>` renders another theme; the default is titanium.
 */
import { TodoReminderComponent } from "../../packages/coding-agent/src/modes/components/todo-reminder";
import type { TodoItem } from "../../packages/coding-agent/src/tools/todo";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

const todos: TodoItem[] = Array.from({ length: 12 }, (_, index) => ({
	content:
		index === 11 ? "Run the focused reminder and compaction suites" : `Pending implementation item ${index + 1}`,
	status: index === 11 ? "in_progress" : "pending",
}));

const component = new TodoReminderComponent(todos, 1, 3);
process.stdout.write(`${component.render(width).join("\n")}\n`);
