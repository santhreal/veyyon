import {
	boundedTodoPreviewText,
	createBoundedTodoPreview,
	prioritizeTodoItems,
	TODO_ITEM_PREVIEW_WIDTH,
	TODO_REMINDER_PREVIEW_LIMIT,
	TODO_TOTAL_PREVIEW_WIDTH,
	type TodoItem,
	type TodoPhase,
} from "../tools/todo";

export interface IncompleteTodoItem {
	phase: string;
	content: string;
	status: Extract<TodoItem["status"], "pending" | "in_progress">;
}

export function incompleteTodoItems(phases: readonly TodoPhase[]): IncompleteTodoItem[] {
	const items: IncompleteTodoItem[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "pending" && task.status !== "in_progress") continue;
			items.push({ phase: phase.name, content: task.content, status: task.status });
		}
	}
	return items;
}

export function todoReminderFingerprint(items: readonly IncompleteTodoItem[]): string {
	return JSON.stringify(items);
}

/** Render a bounded model-facing projection while the full phases remain machine-owned. */
export function renderTodoStatePreview(phases: readonly TodoPhase[]): string {
	const items = prioritizeTodoItems(incompleteTodoItems(phases));
	const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const closed = total - items.length;
	const lines = [`Overall: ${closed}/${total} done, ${items.length} open.`];
	const item = items[0];
	if (!item) return lines[0];

	const marker = item.status === "in_progress" ? "[/]" : "[ ]";
	const prefix = `Active/next: ${marker} `;
	const text = boundedTodoPreviewText(`${item.content} (${item.phase})`, TODO_ITEM_PREVIEW_WIDTH - prefix.length);
	lines.push(`${prefix}${text}`);
	return lines.join("\n");
}

/**
 * Render the stop-time continuation reminder.
 *
 * `echoFullList` spends the once-per-context-window allowance: the first
 * reminder after a compaction boundary repeats the whole open list, because
 * the model may no longer be able to see it. Later reminders in the same
 * window drop to the single active item, since re-pasting a list already in
 * context buys nothing and costs it on every escalation step.
 */
export function renderTodoContinuationReminder(options: {
	items: readonly IncompleteTodoItem[];
	attempt: number;
	maxAttempts: number;
	previewItemWidth?: number;
	echoFullList?: boolean;
}): string {
	const { items, attempt, maxAttempts } = options;
	const itemWidth = Math.min(
		TODO_ITEM_PREVIEW_WIDTH,
		Math.max(3, options.previewItemWidth ?? TODO_ITEM_PREVIEW_WIDTH),
	);
	const lines = ["<system-reminder>", `Continue working now. ${items.length} todo item(s) remain.`];

	if (options.echoFullList) {
		// Group by phase in board order, and prioritize WITHIN each phase.
		// `prioritizeTodoItems` over the flat list sorts by status, which
		// interleaves phases; the emit loop opens a header on every phase change,
		// so a board of [p1 pending, p2 in_progress, p1 pending] came out with
		// repeated and out-of-order headers, a structure the board does not have,
		// in the one reminder whose entire job is re-establishing the board.
		//
		// Phases are NOT reordered by status either, for the same reason: this
		// echo restores what the board looks like, and hoisting the phase holding
		// the active item would restore a different one. The in_progress-first
		// intent survives where it is unambiguous, at the head of its own phase,
		// and the non-echo branch below still leads with the globally active item.
		const byPhase = new Map<string, IncompleteTodoItem[]>();
		for (const entry of items) {
			const bucket = byPhase.get(entry.phase);
			if (bucket) bucket.push(entry);
			else byPhase.set(entry.phase, [entry]);
		}
		// Grouped first, then clamped, so the `… N more` tail counts the items a
		// reader would expect it to. This branch previously applied only the
		// per-row cap, and 300 open items rendered 52,077 characters into the
		// context window that had just been compacted, which is exactly when the
		// budget is scarcest. The shared emitter owns the aggregate ceiling;
		// {@link TODO_REMINDER_PREVIEW_LIMIT} caps the item rows, and phase
		// headers ride the same width budget without consuming that count.
		const preview = createBoundedTodoPreview(TODO_TOTAL_PREVIEW_WIDTH, itemWidth);
		let shown = 0;
		outer: for (const [phase, bucket] of byPhase) {
			let headerIndex: number | undefined;
			for (const entry of prioritizeTodoItems(bucket)) {
				if (shown >= TODO_REMINDER_PREVIEW_LIMIT) break outer;
				if (headerIndex === undefined) {
					if (!preview.push("- ", phase)) break outer;
					headerIndex = preview.lines.length - 1;
				}
				const marker = entry.status === "in_progress" ? "[/]" : "[ ]";
				if (!preview.push(`  ${marker} `, entry.content)) {
					// A budget that ran out between a header and its first row would
					// leave a bare heading promising items that were never emitted.
					if (preview.lines.length - 1 === headerIndex) preview.lines.pop();
					break outer;
				}
				shown++;
			}
		}
		lines.push(...preview.lines);
		const hidden = items.length - shown;
		if (hidden > 0) lines.push(`  … ${hidden} more item(s) retained in machine todo state.`);
	} else {
		const item = prioritizeTodoItems(items)[0];
		const prefix = "Active/next: ";
		if (item && itemWidth > prefix.length) {
			const text = boundedTodoPreviewText(`${item.content} (${item.phase})`, itemWidth - prefix.length);
			lines.push(`${prefix}${text}`);
		}
	}
	lines.push(
		"Resume the next unfinished item. Do not stop to summarize this reminder or restate the todo list.",
		"Yield only when all todos are complete or a real blocker requires user input.",
		`(Continuation reminder ${attempt}/${maxAttempts})`,
		"</system-reminder>",
	);
	return lines.join("\n");
}
