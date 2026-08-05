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
