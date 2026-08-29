import type { SessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { truncateToWidth, visibleWidth } from "@veyyon/tui";
import { NON_ALNUM_RUN_RE } from "@veyyon/utils";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { isTerminalTodoStatus, type TodoStatus } from "@veyyon/wire";
import { type } from "arktype";
import type { SessionEntry } from "../session/session-entries";

export type { TodoStatus };
export type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export const TODO_REMINDER_PREVIEW_LIMIT = 5;
export const TODO_ITEM_PREVIEW_WIDTH = 160;
export const TODO_TOTAL_PREVIEW_WIDTH = 480;

export function boundedTodoPreviewText(text: string, maxWidth: number): string {
	const width = Math.max(1, Math.floor(maxWidth));
	const normalized = collapseWhitespace(sanitizeText(text));
	let rawBounded = normalized;
	if (rawBounded.length > width) {
		let end = Math.max(0, width - 1);
		const finalCodeUnit = rawBounded.charCodeAt(end - 1);
		if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end--;
		rawBounded = `${rawBounded.slice(0, end)}…`;
	}
	return truncateToWidth(rawBounded, width);
}

export function createBoundedTodoPreview(
	totalWidth: number = TODO_TOTAL_PREVIEW_WIDTH,
	itemWidth: number = TODO_ITEM_PREVIEW_WIDTH,
): {
	lines: string[];
	push: (prefix: string, text: string) => boolean;
} {
	let remaining = totalWidth;
	const lines: string[] = [];
	return {
		lines,
		push(prefix: string, text: string): boolean {
			const prefixWidth = Math.max(prefix.length, visibleWidth(prefix));
			const available = Math.min(itemWidth, remaining) - prefixWidth;
			if (available <= 0) return false;
			const line = `${prefix}${boundedTodoPreviewText(text, available)}`;
			lines.push(line);
			remaining -= Math.max(line.length, visibleWidth(line));
			return true;
		},
	};
}

export function prioritizeTodoItems<T extends TodoItem>(items: readonly T[]): T[] {
	const rank: Record<TodoStatus, number> = {
		in_progress: 0,
		pending: 1,
		completed: 2,
		abandoned: 3,
	};
	return items
		.map((item, index) => ({ item, index }))
		.sort((left, right) => rank[left.item.status] - rank[right.item.status] || left.index - right.index)
		.map(entry => entry.item);
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoTaskStateCounts {
	total: number;
	open: number;
	inProgress: number;
	dropped: number;
	completed: number;
}

export interface TodoTaskTransitionCounts {
	total: number;
	added: number;
	removed: number;
	toPending: number;
	toInProgress: number;
	toDropped: number;
	toCompleted: number;
}

export interface TodoTaskReference {
	phase: string;
	task?: string;
	phaseOrdinal?: number;
	taskOrdinal?: number;
}

export interface TodoTaskTransition {
	ref: TodoTaskReference;
	from?: TodoStatus;
	to?: TodoStatus;
}

export interface TodoTaskTelemetry {
	operation: TodoOperation;
	counts: TodoTaskStateCounts;
	transitions: TodoTaskTransitionCounts;
	before?: TodoTaskStateCounts;
	affectedPhases?: TodoTaskReference[];
	affectedTasks?: TodoTaskReference[];
	taskTransitions?: TodoTaskTransition[];
}

export interface TodoToolDetails {
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	telemetry?: TodoTaskTelemetry;
	notes?: string[];
}

export interface TodoOpReport {
	errors: string[];
	notes: string[];
}

export const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "append" | "view"').describe(
	"operation to apply",
);

export const InitListEntry = type({
	"phase?": type("string").describe("phase name; omitted entries continue the previous phase"),
	items: type("string").describe("task content").array().atLeastLength(1).describe("tasks for this phase"),
});

export const TodoWriteEntry = type({
	"id?": type("string").describe("caller-side item id; veyyon keys tasks by content and ignores it"),
	content: type("string").describe("task content"),
	"activeForm?": type("string").describe("caller-side present-tense label; unused"),
	status: type('"pending" | "in_progress" | "completed" | "cancelled"').describe("desired task status"),
});

export const todoSchema = type({
	"op?": TodoOp,
	"list?": InitListEntry.array().describe("phased task list (init)"),
	"task?": type("string").describe("task content"),
	"phase?": type("string").describe("phase name"),
	"items?": type("string").describe("task content").array().describe("tasks to append"),
	"todos?": TodoWriteEntry.array().describe("compatibility whole-board write; prefer op"),
	"merge?": type("boolean").describe("compatibility: false replaces the board, true or omitted merges by content"),
})
	.narrow((params, ctx) => {
		if (params.op !== undefined || params.todos !== undefined) return true;
		return ctx.reject({
			expected: 'an "op" naming the operation: init, start, done, rm, drop, append or view',
			actual: "no op",
			path: ["op"],
		});
	})
	.describe("apply a single todo operation");

export type TodoSchema = typeof todoSchema.infer;
export type TodoParams = TodoSchema & { op: TodoOperation };
export type TodoOpEntryValue = TodoParams;

export type TodoTaskMatch =
	| { kind: "hit"; task: TodoItem; phase: TodoPhase }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: string[] };

function matchTaskByContent(phases: TodoPhase[], content: string): TodoTaskMatch {
	for (const phase of phases) {
		const task = phase.tasks.find(candidate => candidate.content === content);
		if (task) return { kind: "hit", task, phase };
	}
	const key = normalizeForTodoMatch(content);
	if (!key) return { kind: "none" };
	const matches: Array<{ task: TodoItem; phase: TodoPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (normalizeForTodoMatch(task.content) === key) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return { kind: "hit", ...matches[0] };
	if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map(match => match.task.content) };
	return { kind: "none" };
}

function matchPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined | "ambiguous" {
	const exact = phases.find(phase => phase.name === name);
	if (exact) return exact;
	const key = normalizeForTodoMatch(name);
	if (!key) return undefined;
	const matches = phases.filter(phase => normalizeForTodoMatch(phase.name) === key);
	if (matches.length === 1) return matches[0];
	return matches.length > 1 ? "ambiguous" : undefined;
}

function cloneTask(task: TodoItem): TodoItem {
	return { content: task.content, status: task.status };
}

export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

export function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

export interface IndexedTodoTask {
	ref: TodoTaskReference;
	status: TodoStatus;
}

function countTodoTaskStates(phases: readonly TodoPhase[]): TodoTaskStateCounts {
	const counts: TodoTaskStateCounts = {
		total: 0,
		open: 0,
		inProgress: 0,
		dropped: 0,
		completed: 0,
	};
	for (const phase of phases) {
		for (const task of phase.tasks) {
			counts.total++;
			if (!isTerminalTodoStatus(task.status)) counts.open++;
			switch (task.status) {
				case "pending":
					break;
				case "in_progress":
					counts.inProgress++;
					break;
				case "abandoned":
					counts.dropped++;
					break;
				case "completed":
					counts.completed++;
					break;
				default:
					task.status satisfies never;
			}
		}
	}
	return counts;
}

function indexTodoTasks(phases: readonly TodoPhase[]): Map<string, IndexedTodoTask> {
	const indexed = new Map<string, IndexedTodoTask>();
	for (const [phaseIndex, phase] of phases.entries()) {
		for (const [taskIndex, task] of phase.tasks.entries()) {
			indexed.set(todoTransitionKey(phase.name, task.content), {
				ref: {
					phase: phase.name,
					task: task.content,
					phaseOrdinal: phaseIndex + 1,
					taskOrdinal: taskIndex + 1,
				},
				status: task.status,
			});
		}
	}
	return indexed;
}

function getTaskTransitions(
	previous: readonly TodoPhase[],
	updated: readonly TodoPhase[],
): TodoTaskTransition[] {
	const before = indexTodoTasks(previous);
	const after = indexTodoTasks(updated);
	const transitions: TodoTaskTransition[] = [];
	for (const [key, task] of before) {
		const next = after.get(key);
		if (!next) {
			transitions.push({ ref: task.ref, from: task.status });
		} else if (next.status !== task.status) {
			transitions.push({ ref: next.ref, from: task.status, to: next.status });
		}
	}
	for (const [key, task] of after) {
		if (!before.has(key)) transitions.push({ ref: task.ref, to: task.status });
	}
	return transitions;
}

function countTaskTransitions(transitions: readonly TodoTaskTransition[]): TodoTaskTransitionCounts {
	const counts: TodoTaskTransitionCounts = {
		total: transitions.length,
		added: 0,
		removed: 0,
		toPending: 0,
		toInProgress: 0,
		toDropped: 0,
		toCompleted: 0,
	};
	for (const transition of transitions) {
		if (transition.from === undefined) {
			counts.added++;
			continue;
		}
		if (transition.to === undefined) {
			counts.removed++;
			continue;
		}
		switch (transition.to) {
			case "pending":
				counts.toPending++;
				break;
			case "in_progress":
				counts.toInProgress++;
				break;
			case "abandoned":
				counts.toDropped++;
				break;
			case "completed":
				counts.toCompleted++;
				break;
			default:
				transition.to satisfies never;
		}
	}
	return counts;
}

function uniqueTaskReferences(
	transitions: readonly TodoTaskTransition[],
	phaseOnly: boolean,
): TodoTaskReference[] | undefined {
	const unique = new Map<string, TodoTaskReference>();
	for (const { ref } of transitions) {
		const key = phaseOnly ? ref.phase : todoTransitionKey(ref.phase, ref.task ?? "");
		if (!unique.has(key)) {
			unique.set(key, phaseOnly ? { phase: ref.phase, phaseOrdinal: ref.phaseOrdinal } : ref);
		}
	}
	return unique.size > 0 ? Array.from(unique.values()) : undefined;
}

export function buildTodoTelemetry(
	operation: TodoOperation,
	previous: readonly TodoPhase[],
	effective: readonly TodoPhase[],
	detail: Exclude<SessionTelemetryDetail, "none">,
): TodoTaskTelemetry {
	const taskTransitions = getTaskTransitions(previous, effective);
	const telemetry: TodoTaskTelemetry = {
		operation,
		counts: countTodoTaskStates(effective),
		transitions: countTaskTransitions(taskTransitions),
	};
	if (detail === "rich" || detail === "ultra") {
		telemetry.before = countTodoTaskStates(previous);
		telemetry.affectedPhases = uniqueTaskReferences(taskTransitions, true);
		telemetry.affectedTasks = uniqueTaskReferences(taskTransitions, false);
	}
	if (detail === "ultra" && taskTransitions.length > 0) telemetry.taskTransitions = taskTransitions;
	return telemetry;
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap(phase => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(task => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(task => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

export function nextActionableEntry(phases: readonly TodoPhase[]): { task: TodoItem; phase: TodoPhase } | undefined {
	let firstPending: { task: TodoItem; phase: TodoPhase } | undefined;
	let firstOpen: { task: TodoItem; phase: TodoPhase } | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return { task, phase };
			if (isTerminalTodoStatus(task.status)) continue;
			firstOpen ??= { task, phase };
			if (task.status === "pending") firstPending ??= { task, phase };
		}
	}
	return firstPending ?? firstOpen;
}

export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	return nextActionableEntry(phases)?.task;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export interface TodoPhasesSnapshot {
	found: boolean;
	phases: TodoPhase[];
}

export interface FuzzyTaskMatch {
	task: TodoItem;
	phase: TodoPhase;
}

export function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const exact = phases.find(phase => phase.name.toLowerCase() === q);
	if (exact) return exact;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(q));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

export function findTaskFuzzy(phases: TodoPhase[], query: string): FuzzyTaskMatch | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: FuzzyTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const active = matches.filter(m => m.task.status === "in_progress" || m.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

export function getLatestTodoPhasesSnapshotFromEntries(entries: SessionEntry[]): TodoPhasesSnapshot {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const data = entry.data as { phases?: unknown } | undefined;
			if (data && Array.isArray(data.phases)) {
				return { found: true, phases: clonePhases(data.phases as TodoPhase[]) };
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
		if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;

		const details = message.details as { phases?: unknown } | undefined;
		if (!details || !Array.isArray(details.phases)) continue;

		return { found: true, phases: clonePhases(details.phases as TodoPhase[]) };
	}

	return { found: false, phases: [] };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	return getLatestTodoPhasesSnapshotFromEntries(entries).phases;
}

export const TODO_DESCRIPTION_MIN_OVERLAP = 6;

export function normalizeForTodoMatch(value: string): string {
	return value.toLowerCase().replace(NON_ALNUM_RUN_RE, " ").trim();
}

export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

export function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const match = matchTaskByContent(phases, content);
	if (match.kind === "ambiguous") {
		errors.push(
			`Task "${content}" matches ${match.candidates.length} tasks (${match.candidates.map(candidate => `"${candidate}"`).join(", ")}); pass the exact text of the one you mean`,
		);
		return undefined;
	}
	if (match.kind === "none") {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
		return undefined;
	}
	return { task: match.task, phase: match.phase };
}

export function resolvePhaseOrError(
	phases: TodoPhase[],
	name: string | undefined,
	errors: string[],
): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = matchPhaseByName(phases, name);
	if (phase === "ambiguous") {
		errors.push(`Phase "${name}" matches more than one phase; pass the exact name of the one you mean`);
		return undefined;
	}
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

export function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? phase.tasks.slice() : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

export const DEFAULT_INIT_PHASE = "Tasks";

export function initPhases(entry: TodoOpEntryValue, report: TodoOpReport): TodoPhase[] {
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		report.errors.push("Missing list for init operation");
		return [];
	}

	const phases: TodoPhase[] = [];
	const byName = new Map<string, TodoPhase>();
	const entriesPerPhase = new Map<string, number>();
	const seenTasks = new Set<string>();
	let previousPhaseName = DEFAULT_INIT_PHASE;
	for (const listEntry of list) {
		const namedPhase = listEntry.phase?.trim();
		const phaseName = namedPhase || previousPhaseName;
		previousPhaseName = phaseName;
		const phaseKey = normalizeForTodoMatch(phaseName) || phaseName;
		let phase = byName.get(phaseKey);
		if (!phase) {
			phase = { name: phaseName, tasks: [] };
			byName.set(phaseKey, phase);
			phases.push(phase);
		} else if (namedPhase) {
			entriesPerPhase.set(phaseKey, (entriesPerPhase.get(phaseKey) ?? 1) + 1);
		}
		for (const content of listEntry.items) {
			const taskKey = normalizeForTodoMatch(content) || content;
			if (seenTasks.has(taskKey)) report.errors.push(`Duplicate task "${content}" in init list`);
			seenTasks.add(taskKey);
			phase.tasks.push({ content, status: "pending" });
		}
	}
	for (const [phaseKey, count] of entriesPerPhase) {
		const name = byName.get(phaseKey)?.name ?? phaseKey;
		report.notes.push(
			`Merged ${count} repeated "${boundedTodoPreviewText(name, TODO_ITEM_PREVIEW_WIDTH)}" phase entries into one phase; every task is addressable through it.`,
		);
	}
	return phases;
}

export function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of entry.items) {
		const key = normalizeForTodoMatch(content) || content;
		if (seen.has(key) || matchTaskByContent(phases, content).kind !== "none") {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(key);
	}
	if (hasDuplicate) return phases;

	const existingPhase = matchPhaseByName(phases, entry.phase);
	if (existingPhase === "ambiguous") {
		errors.push(`Phase "${entry.phase}" matches more than one phase; pass the exact name of the one you mean`);
		return phases;
	}
	let phase = existingPhase;
	if (!phase) {
		phase = { name: entry.phase, tasks: [] };
		phases.push(phase);
	}

	for (const content of entry.items) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}
