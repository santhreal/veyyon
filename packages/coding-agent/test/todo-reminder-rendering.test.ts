import { describe, expect, it } from "bun:test";
import {
	incompleteTodoItems,
	renderTodoContinuationReminder,
	renderTodoStatePreview,
	todoReminderFingerprint,
} from "@veyyon/coding-agent/session/todo-reminder";
import { boundedTodoPreviewText, TODO_ITEM_PREVIEW_WIDTH, type TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { visibleWidth } from "@veyyon/tui";

function largeTodoState(): TodoPhase[] {
	return [
		{
			name: "Implementation",
			tasks: [
				{ content: "Pending zero", status: "pending" },
				{ content: "Active one", status: "in_progress" },
				{ content: "Pending two", status: "pending" },
				{ content: "Pending three", status: "pending" },
				{ content: "Pending four", status: "pending" },
				{ content: "Pending five", status: "pending" },
				{ content: "Completed six", status: "completed" },
			],
		},
	];
}

describe("bounded todo continuation reminders", () => {
	/** A large todo plan must stay fully machine-owned while only a bounded preview reaches model context. */
	it("prioritizes one active item without serializing the remaining journal", () => {
		const phases = largeTodoState();
		const items = incompleteTodoItems(phases);
		const reminder = renderTodoContinuationReminder({
			items,
			attempt: 1,
			maxAttempts: 3,
		});

		expect(items).toHaveLength(6);
		expect(reminder).toContain("Continue working now. 6 todo item(s) remain.");
		expect(reminder).toContain("Active/next: Active one (Implementation)");
		expect(reminder).not.toContain("Pending zero");
		expect(reminder).not.toContain("Pending three");
		expect(reminder).not.toContain("Completed six");
		expect(phases).toEqual(largeTodoState());
	});

	/**
	 * Oversized task text must obey both the per-row and aggregate budgets while
	 * the authoritative todo objects remain byte-for-byte unchanged.
	 */
	it("bounds each model row and the aggregate task preview", () => {
		const phases: TodoPhase[] = [
			{
				name: "P".repeat(1_000),
				tasks: Array.from({ length: 6 }, (_, index) => ({
					content: `${index === 5 ? "Active" : "Pending"} ${"x".repeat(1_000)}`,
					status: index === 5 ? ("in_progress" as const) : ("pending" as const),
				})),
			},
		];
		const original = structuredClone(phases);
		const reminder = renderTodoContinuationReminder({
			items: incompleteTodoItems(phases),
			attempt: 1,
			maxAttempts: 3,
		});
		const taskLines = reminder.split("\n").filter(line => line.startsWith("Active/next:"));

		expect(taskLines).toHaveLength(1);
		expect(taskLines[0]).toContain("Active");
		expect(taskLines.every(line => Math.max(line.length, visibleWidth(line)) <= TODO_ITEM_PREVIEW_WIDTH)).toBe(true);

		const stateLines = renderTodoStatePreview(phases)
			.split("\n")
			.filter(line => line.startsWith("Active/next:"));
		expect(stateLines).toHaveLength(1);
		expect(stateLines.every(line => Math.max(line.length, visibleWidth(line)) <= TODO_ITEM_PREVIEW_WIDTH)).toBe(true);
		expect(phases).toEqual(original);
	});

	it("keeps 3-task and 300-task projections constant-size apart from exact count digits", () => {
		const phases = (count: number): TodoPhase[] => [
			{
				name: "Implementation",
				tasks: [
					{ content: "Active bounded item", status: "in_progress" },
					...Array.from({ length: count - 1 }, (_, index) => ({
						content: `JOURNAL_ENTRY_MUST_NOT_APPEAR_${index}`,
						status: "pending" as const,
					})),
				],
			},
		];
		const reminder = (count: number) =>
			renderTodoContinuationReminder({
				items: incompleteTodoItems(phases(count)),
				attempt: 1,
				maxAttempts: 3,
			});
		const smallReminder = reminder(3);
		const largeReminder = reminder(300);
		const smallState = renderTodoStatePreview(phases(3));
		const largeState = renderTodoStatePreview(phases(300));

		expect(largeReminder.length - smallReminder.length).toBe(2);
		expect(Buffer.byteLength(largeReminder) - Buffer.byteLength(smallReminder)).toBe(2);
		expect(largeState.length - smallState.length).toBe(4);
		expect(Buffer.byteLength(largeState) - Buffer.byteLength(smallState)).toBe(4);
		expect(largeReminder).not.toContain("JOURNAL_ENTRY_MUST_NOT_APPEAR");
		expect(largeState).not.toContain("JOURNAL_ENTRY_MUST_NOT_APPEAR");
	});

	/**
	 * EVERY branch of the reminder is capped, not just the default one. The scale
	 * assertion above only ever exercised the short form, so the `echoFullList`
	 * branch shipped applying the per-row cap and neither the aggregate ceiling
	 * nor the row cap: 300 open items of 4,000 characters each rendered 52,077
	 * characters across 606 lines, on the post-compaction stop where context is
	 * scarcest. Both branches are asserted here so a fifth branch added later
	 * without a budget fails this test rather than shipping.
	 */
	it("holds a hard character ceiling on every branch at 300 items of 4000 characters", () => {
		const items = Array.from({ length: 300 }, (_, index) => ({
			phase: `Phase ${index % 7}`,
			content: `${"x".repeat(4_000)} JOURNAL_ENTRY_${index}`,
			status: index === 3 ? ("in_progress" as const) : ("pending" as const),
		}));

		// Measured after the fix: 448 chars / 7 lines short form, 824 chars / 11
		// lines echoed. The bar sits just above the larger of the two so a
		// regression that drops a cap blows past it by orders of magnitude.
		for (const echoFullList of [undefined, true]) {
			const reminder = renderTodoContinuationReminder({ items, attempt: 1, maxAttempts: 3, echoFullList });
			expect(reminder.length).toBeLessThan(1_000);
			expect(Buffer.byteLength(reminder)).toBeLessThan(1_000);
			expect(reminder.split("\n").length).toBeLessThan(15);
		}

		// The echo names what it withheld rather than dropping it silently: 300
		// open items, 3 rows fit the aggregate budget.
		const echoed = renderTodoContinuationReminder({ items, attempt: 1, maxAttempts: 3, echoFullList: true });
		expect(echoed).toContain("  … 297 more item(s) retained in machine todo state.");
		expect(echoed).toContain("Continue working now. 300 todo item(s) remain.");
	});

	/** Control sequences, line breaks, tabs, and zero-width marks cannot bypass the raw or visual cap. */
	it("sanitizes adversarial todo text before applying the width boundary", () => {
		const output = boundedTodoPreviewText(`first\nsecond\t\u001B[31mred\u001B[0m${"\u0301".repeat(1_000)}`, 32);

		expect(output).not.toMatch(/[\n\t\u001B]/);
		expect(output.length).toBeLessThanOrEqual(32);
		expect(visibleWidth(output)).toBeLessThanOrEqual(32);
		expect(output).toStartWith("first second red");
	});

	/** Reminder language must command continued execution rather than frame the turn as a completed stop. */
	it("uses continuation language and reserves yielding for completion or a real blocker", () => {
		const reminder = renderTodoContinuationReminder({
			items: incompleteTodoItems(largeTodoState()),
			attempt: 1,
			maxAttempts: 3,
		});

		expect(reminder).toStartWith("<system-reminder>\nContinue working now.");
		expect(reminder).toContain("Resume the next unfinished item.");
		expect(reminder).toContain("Yield only when all todos are complete or a real blocker requires user input.");
		expect(reminder).not.toContain("You stopped");
		expect(reminder).not.toContain("marking complete");
	});

	/**
	 * The `echoFullList` branch is the once-per-context-window full-board echo,
	 * so it must reproduce the board's structure. Sorting the flat list by status
	 * interleaved phases, and the emit loop opens a header on every phase change,
	 * so the echo came back with repeated and out-of-order headers.
	 */
	it("echoes phases in board order with one header each and the active item first inside its phase", () => {
		const reminder = renderTodoContinuationReminder({
			items: [
				{ phase: "Plan", content: "draft spec", status: "pending" },
				{ phase: "Build", content: "wire adapter", status: "in_progress" },
				{ phase: "Build", content: "land tests", status: "pending" },
				{ phase: "Plan", content: "review spec", status: "pending" },
			],
			attempt: 1,
			maxAttempts: 3,
			echoFullList: true,
		});

		expect(reminder).toBe(
			[
				"<system-reminder>",
				"Continue working now. 4 todo item(s) remain.",
				"- Plan",
				"  [ ] draft spec",
				"  [ ] review spec",
				"- Build",
				"  [/] wire adapter",
				"  [ ] land tests",
				"Resume the next unfinished item. Do not stop to summarize this reminder or restate the todo list.",
				"Yield only when all todos are complete or a real blocker requires user input.",
				"(Continuation reminder 1/3)",
				"</system-reminder>",
			].join("\n"),
		);
		expect(reminder.split("\n").filter(line => line === "- Build")).toHaveLength(1);
		expect(reminder.split("\n").filter(line => line === "- Plan")).toHaveLength(1);
	});

	/** Fingerprints must change for phase, status, or content changes so a genuinely new state earns a new preview. */
	it("fingerprints the complete incomplete state without including completed items", () => {
		const original = incompleteTodoItems(largeTodoState());
		const changedStatus = original.map(item =>
			item.content === "Pending zero" ? { ...item, status: "in_progress" as const } : item,
		);
		const changedPhase = original.map(item =>
			item.content === "Pending zero" ? { ...item, phase: "Review" } : item,
		);

		expect(todoReminderFingerprint(original)).not.toBe(todoReminderFingerprint(changedStatus));
		expect(todoReminderFingerprint(original)).not.toBe(todoReminderFingerprint(changedPhase));
		expect(todoReminderFingerprint(original)).not.toContain("Completed six");
	});
});
