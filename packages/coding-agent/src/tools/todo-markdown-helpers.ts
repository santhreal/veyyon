import { isTerminalTodoStatus, type TodoStatus } from "@veyyon/wire";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

import {
	appendItems,
	boundedTodoPreviewText,
	clonePhases,
	createBoundedTodoPreview,
	DEFAULT_INIT_PHASE,
	getTaskTargets,
	initPhases,
	nextActionableEntry,
	normalizeForTodoMatch,
	normalizeInProgressTask,
	prioritizeTodoItems,
	resolvePhaseOrError,
	resolveTaskOrError,
	TODO_ITEM_PREVIEW_WIDTH,
	TODO_REMINDER_PREVIEW_LIMIT,
	TODO_TOTAL_PREVIEW_WIDTH,
	type TodoItem,
	type TodoOpEntryValue,
	type TodoOpReport,
	type TodoParams,
	type TodoPhase,
	type TodoSchema,
} from "./todo-helpers";

export type { TodoStatus } from "@veyyon/wire";

export {
	boundedTodoPreviewText,
	createBoundedTodoPreview,
	type FuzzyTaskMatch,
	findPhaseFuzzy,
	findTaskFuzzy,
	getLatestTodoPhasesFromEntries,
	getLatestTodoPhasesSnapshotFromEntries,
	nextActionableTask,
	prioritizeTodoItems,
	TODO_ITEM_PREVIEW_WIDTH,
	TODO_REMINDER_PREVIEW_LIMIT,
	TODO_TOTAL_PREVIEW_WIDTH,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoOperation,
	type TodoOpReport,
	type TodoPhase,
	type TodoPhasesSnapshot,
	type TodoTaskReference,
	type TodoTaskStateCounts,
	type TodoTaskTelemetry,
	type TodoTaskTransition,
	type TodoTaskTransitionCounts,
	type TodoToolDetails,
	todoMatchesAnyDescription,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "./todo-helpers";

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, report: TodoOpReport): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, report);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, report.errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, report.errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, report.errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, report.errors);
		case "append":
			return appendItems(phases, entry, report.errors);
		case "view":
			return phases;
		default:
			entry.op satisfies never;
			report.errors.push(
				`Unknown op ${JSON.stringify(entry.op)}; expected init, start, done, rm, drop, append or view`,
			);
			return phases;
	}
}

export function adaptTodoWriteBatch(
	params: TodoSchema,
	currentPhases: readonly TodoPhase[],
): { ops: TodoParams[]; notes: string[] } {
	const incoming = params.todos ?? [];
	const notes: string[] = [];
	if (incoming.length === 0) return { ops: [], notes };
	const todos: typeof incoming = [];
	const collapsedByKey = new Map<string, { content: string; count: number }>();
	const seenIncoming = new Map<string, { content: string; count: number }>();
	for (const todo of incoming) {
		const key = normalizeForTodoMatch(todo.content) || todo.content;
		const first = seenIncoming.get(key);
		if (first) {
			first.count += 1;
			collapsedByKey.set(key, first);
			continue;
		}
		const entry = { content: todo.content, count: 1 };
		seenIncoming.set(key, entry);
		todos.push(todo);
	}
	for (const { content, count } of collapsedByKey.values()) {
		notes.push(
			`Collapsed ${count} items differing only in case or punctuation into "${boundedTodoPreviewText(content, TODO_ITEM_PREVIEW_WIDTH)}"; task targeting cannot tell them apart.`,
		);
	}

	const ops: TodoParams[] = [];
	const replace = params.merge === false;

	if (replace) {
		ops.push({ op: "init", list: [{ phase: params.phase ?? DEFAULT_INIT_PHASE, items: todos.map(t => t.content) }] });
	} else {
		const existing = new Set(
			currentPhases.flatMap(phase => phase.tasks.map(task => normalizeForTodoMatch(task.content) || task.content)),
		);
		const missing: string[] = [];
		for (const todo of todos) {
			const key = normalizeForTodoMatch(todo.content) || todo.content;
			if (existing.has(key)) continue;
			existing.add(key);
			missing.push(todo.content);
		}
		if (missing.length > 0) {
			const target = params.phase ?? currentPhases.at(-1)?.name ?? DEFAULT_INIT_PHASE;
			ops.push({ op: "append", phase: target, items: missing });
		}
	}

	for (const todo of todos) {
		switch (todo.status) {
			case "in_progress":
				ops.push({ op: "start", task: todo.content });
				break;
			case "completed":
				ops.push({ op: "done", task: todo.content });
				break;
			case "cancelled":
				ops.push({ op: "drop", task: todo.content });
				break;
			case "pending":
				break;
		}
	}
	return { ops, notes };
}

export function applyParams(phases: TodoPhase[], params: TodoParams): TodoOpReport & { phases: TodoPhase[] } {
	const report: TodoOpReport = { errors: [], notes: [] };
	const next = applyEntry(phases, params, report);
	normalizeInProgressTask(next);
	return { phases: next, ...report };
}

export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoParams[],
): TodoOpReport & { phases: TodoPhase[] } {
	const report: TodoOpReport = { errors: [], notes: [] };
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, report);
	}
	normalizeInProgressTask(next);
	return { phases: next, ...report };
}

export const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		for (const task of phases[i].tasks) {
			out.push(`- [${STATUS_TO_MARKER[task.status]}] ${task.content}`);
		}
	}
	return `${out.join("\n")}\n`;
}

export const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
};

export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];

		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			continue;
		}

		const taskMatch = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`);
				continue;
			}
			currentPhase.tasks.push({ content: taskMatch[2].trim(), status });
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	normalizeInProgressTask(phases);
	return { phases, errors };
}

export function formatOverall(tasks: readonly TodoItem[]): string {
	let done = 0;
	let dropped = 0;
	for (const task of tasks) {
		if (task.status === "completed") done++;
		else if (isTerminalTodoStatus(task.status)) dropped++;
	}
	const open = tasks.length - done - dropped;
	return `Overall: ${done}/${tasks.length} done, ${dropped > 0 ? `${dropped} dropped, ` : ""}${open} open.`;
}

function formatMutationSummary(phases: TodoPhase[], params: TodoParams): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	const task = params.task ? boundedTodoPreviewText(params.task, TODO_ITEM_PREVIEW_WIDTH) : undefined;
	const phase = params.phase ? boundedTodoPreviewText(params.phase, TODO_ITEM_PREVIEW_WIDTH) : undefined;

	let changed: string;
	switch (params.op) {
		case "init":
			changed = `Initialized ${tasks.length} tasks in ${phases.length} ${phases.length === 1 ? "phase" : "phases"}.`;
			break;
		case "start":
			changed = `Started: ${task}.`;
			break;
		case "done":
			changed = task ? `Completed: ${task}.` : `Completed phase: ${phase}.`;
			break;
		case "drop":
			changed = task ? `Dropped: ${task}.` : `Dropped phase: ${phase}.`;
			break;
		case "append":
			changed = `Added ${params.items?.length ?? 0} ${(params.items?.length ?? 0) === 1 ? "task" : "tasks"} to ${phase}.`;
			break;
		case "rm":
			if (!task && !phase) return `Todo list cleared. ${formatOverall([])}`;
			changed = task ? `Removed: ${task}.` : `Removed phase: ${phase}.`;
			break;
		case "view":
			throw new Error("view operations require the full todo summary");
	}

	const next = nextActionableEntry(phases);
	const nextText = next
		? ` Next: ${boundedTodoPreviewText(`${next.task.content} (${next.phase.name})`, TODO_ITEM_PREVIEW_WIDTH)}.`
		: " Next: none.";
	return `${changed}${nextText} ${formatOverall(tasks)}`;
}

export function formatSummary(
	phases: TodoPhase[],
	report: TodoOpReport,
	readOnly = false,
	params?: TodoParams,
): string {
	const body = formatSummaryBody(phases, report.errors, readOnly, params);
	if (report.notes.length === 0) return body;
	const notes = boundedTodoPreviewText(report.notes.join(" "), TODO_TOTAL_PREVIEW_WIDTH);
	return `Applied with adjustments: ${notes}\n${body}`;
}

export const TODO_PREVIEW_MARKERS: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[/]",
	completed: "[X]",
	abandoned: "[-]",
};

function formatSummaryBody(
	phases: TodoPhase[],
	errors: string[],
	readOnly: boolean,
	params?: TodoParams,
): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	const errorSummary =
		errors.length > 0 ? `Errors: ${boundedTodoPreviewText(errors.join("; "), TODO_TOTAL_PREVIEW_WIDTH)}` : undefined;
	if (tasks.length === 0) {
		if (errorSummary) return errorSummary;
		if (!readOnly && params && params.op !== "view") return formatMutationSummary(phases, params);
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	if (!readOnly && errors.length === 0 && params && params.op !== "view") {
		return formatMutationSummary(phases, params);
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.filter(task => !isTerminalTodoStatus(task.status)),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	const currentIdx = phases.findIndex(phase => phase.tasks.some(task => !isTerminalTodoStatus(task.status)));

	const lines: string[] = [];
	if (errorSummary) lines.push(errorSummary);
	lines.push(remainingTasks.length === 0 ? "Remaining items: none." : `Remaining items: ${remainingTasks.length}.`);
	lines.push(formatOverall(tasks));
	if (currentIdx === -1) {
		lines.push(
			`Active phase: none (all ${phases.length} ${phases.length === 1 ? "phase is" : "phases are"} closed).`,
		);
	} else {
		const current = phases[currentIdx];
		const done = current.tasks.filter(task => isTerminalTodoStatus(task.status)).length;
		const workedAhead = phases.some(
			(phase, idx) => idx > currentIdx && phase.tasks.some(task => isTerminalTodoStatus(task.status)),
		);
		lines.push(
			`Active phase ${currentIdx + 1}/${phases.length} "${boundedTodoPreviewText(current.name, TODO_ITEM_PREVIEW_WIDTH)}" (${done}/${current.tasks.length})${
				workedAhead
					? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
					: "."
			}`,
		);
	}
	const previewItems = prioritizeTodoItems(
		phases.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name }))),
	);
	const preview = createBoundedTodoPreview();
	for (const item of previewItems.slice(0, TODO_REMINDER_PREVIEW_LIMIT)) {
		const marker = TODO_PREVIEW_MARKERS[item.status];
		if (!preview.push(`- ${marker} `, `${item.content} (${item.phase})`)) break;
	}
	for (let li = 0; li < preview.lines.length; li++) lines.push(preview.lines[li]!);
	const hidden = tasks.length - preview.lines.length;
	if (hidden > 0) lines.push(`- … ${hidden} more item(s) retained in machine todo state.`);
	return lines.join("\n");
}
