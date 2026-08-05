import { beforeAll, describe, expect, it } from "bun:test";
import { TodoReminderComponent } from "@veyyon/coding-agent/modes/components/todo-reminder";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TodoItem } from "@veyyon/coding-agent/tools/todo";

function render(todos: TodoItem[]): string {
	return Bun.stripANSI(new TodoReminderComponent(todos, 1, 3).render(100).join("\n"));
}

beforeAll(async () => {
	await initTheme(false);
});

describe("TodoReminderComponent", () => {
	/** The visible reminder must keep the active task and hidden count without drawing a fifty-row wall. */
	it("renders a bounded actionable preview", () => {
		const todos: TodoItem[] = Array.from({ length: 12 }, (_, index) => ({
			content: `Pending ${index + 1}`,
			status: index === 11 ? "in_progress" : "pending",
		}));

		const output = render(todos);

		expect(output).toContain("Continue: 12 todos remain · 1/3");
		expect(output).toContain("Pending 12");
		expect(output).toContain("… 7 more in todo state");
		expect(output).not.toContain("Pending 5");
		expect(output).not.toContain("You stopped");
	});

	/**
	 * The component must cap both one pathological row and the aggregate preview,
	 * without truncating or mutating the machine-owned todo array.
	 */
	it("bounds oversized todo text and reports items omitted by the total budget", () => {
		const todos: TodoItem[] = Array.from({ length: 6 }, (_, index) => ({
			content: `${index === 5 ? "Active" : "Pending"} ${"x".repeat(1_000)} END-${index}`,
			status: index === 5 ? "in_progress" : "pending",
		}));
		const original = structuredClone(todos);

		const output = render(todos);

		expect(output).toContain("Active");
		expect(output).not.toContain("END-5");
		expect(output).toContain("… 3 more in todo state");
		expect(todos).toEqual(original);
	});

	/** Multi-line/control-heavy task text must render as one sanitized, bounded preview value. */
	it("sanitizes adversarial task text before rendering", () => {
		const output = render([
			{
				content: `first\nsecond\t\u001B[31mred\u001B[0m${"\u0301".repeat(1_000)}`,
				status: "in_progress",
			},
		]);

		expect(output).toContain("first second red");
		expect(output).not.toMatch(/[\t\u001B]/);
		expect(output).not.toContain("\nsecond");
	});

	/** Singular grammar must remain direct continuation guidance for the final open task. */
	it("renders one remaining task without a hidden-count line", () => {
		const output = render([{ content: "Run the smoke test", status: "in_progress" }]);

		expect(output).toContain("Continue: 1 todo remains · 1/3");
		expect(output).toContain("Run the smoke test");
		expect(output).not.toContain("more in todo state");
	});
});
