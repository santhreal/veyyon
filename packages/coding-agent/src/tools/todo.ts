import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { type SessionTelemetryDetail, sessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import type { Component } from "@veyyon/tui";
import { Text, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { formatCount, NON_ALNUM_RUN_RE, prompt } from "@veyyon/utils";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { isTerminalTodoStatus, isTodoListDone, TODO_DONE_SUMMARY, type TodoStatus } from "@veyyon/wire";
import { type } from "arktype";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";
import { framedBlock, renderStatusLine, renderTreeList } from "../tui";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { formatErrorDetail } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type { TodoStatus };
/** Operation names accepted by the todo tool and echoed in successful result details. */
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
/** Maximum raw characters and visible columns retained from one todo preview row. */
export const TODO_ITEM_PREVIEW_WIDTH = 160;
/** Maximum aggregate raw characters and visible columns retained across todo preview rows. */
export const TODO_TOTAL_PREVIEW_WIDTH = 480;

/**
 * Convert arbitrary todo text into one safe, bounded display row.
 *
 * The raw-character cap matters independently of terminal width: ANSI controls
 * and combining marks can consume model tokens without consuming display cells.
 */
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

/**
 * Emit todo preview rows against one shared aggregate budget.
 *
 * Every surface that projects the board for a reader needs the same three
 * caps: {@link TODO_ITEM_PREVIEW_WIDTH} per row, {@link TODO_TOTAL_PREVIEW_WIDTH}
 * across all rows, and a `… N more` tail naming what was withheld. It was
 * open-coded per surface, and the copy in the stop-time continuation reminder's
 * full-list echo applied only the per-row cap, so 300 open items rendered
 * 52,077 characters into the context window that had just been compacted.
 *
 * Callers own the row cap ({@link TODO_REMINDER_PREVIEW_LIMIT}) and the tail
 * wording, because those differ per surface; the budget arithmetic does not.
 */
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
		/** Append `prefix` + bounded `text`; false when the budget cannot fit another row. */
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

/** Stable display-only ordering that keeps actionable work ahead of closed history. */
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

/** Measurable task-state totals after a todo operation. `open` includes pending and in-progress work. */
export interface TodoTaskStateCounts {
	total: number;
	open: number;
	inProgress: number;
	dropped: number;
	completed: number;
}

/** Aggregate mutations caused by one operation, including automatic in-progress normalization. */
export interface TodoTaskTransitionCounts {
	total: number;
	added: number;
	removed: number;
	toPending: number;
	toInProgress: number;
	toDropped: number;
	toCompleted: number;
}

/**
 * Reference into the existing todo representation. Phase/task text is the
 * stable identity already used by todo operations; ordinals are supplemental
 * snapshot positions and are not identity.
 */
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

/**
 * Additive task-state telemetry. The canonical goal-verification policy gates
 * this entire record and progressively richer fields within it.
 */
export interface TodoTaskTelemetry {
	operation: TodoOperation;
	counts: TodoTaskStateCounts;
	transitions: TodoTaskTransitionCounts;
	/** Rich+: state before the operation. */
	before?: TodoTaskStateCounts;
	/** Rich+: references for phases changed directly or by normalization. */
	affectedPhases?: TodoTaskReference[];
	/** Rich+: references for tasks changed directly or by normalization. */
	affectedTasks?: TodoTaskReference[];
	/** Ultra only: individual added, removed, and status transitions. */
	taskTransitions?: TodoTaskTransition[];
}

export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	telemetry?: TodoTaskTelemetry;
	/**
	 * Non-fatal adjustments the tool made to a write that LANDED. Present only
	 * when the applied board differs in structure from what the caller sent.
	 * Never a failure: a result carrying notes has `isError` unset and the new
	 * board in `phases`.
	 */
	notes?: string[];
}

/**
 * The two OUTPUT channels of one todo operation. They are a single object with
 * two named arrays, rather than two `string[]` parameters, so a call site
 * cannot pass the wrong one: it writes `report.errors` or `report.notes` and
 * the name says which contract it is invoking.
 *
 * `errors` is fatal. Any entry discards the whole batch and the board is left
 * exactly as it was, so nothing the caller sent took effect.
 *
 * `notes` is not. The batch was applied; a note describes how the applied
 * result differs from the literal request. Silently returning a different board
 * than the one requested is the defect class this channel exists to close.
 */
export interface TodoOpReport {
	errors: string[];
	notes: string[];
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "append" | "view"').describe("operation to apply");

const InitListEntry = type({
	"phase?": type("string").describe("phase name; omitted entries continue the previous phase"),
	items: type("string").describe("task content").array().atLeastLength(1).describe("tasks for this phase"),
});

/**
 * Compatibility shape: models trained on the Claude/Cursor `TodoWrite` tool
 * emit a whole-board write (`{ merge, todos: [{ id, content, status }] }`)
 * instead of a single `{ op, ... }`. Accepting it here is what makes that call
 * land; the alternative was validating clean and then silently resolving to a
 * read-only `view`, so a completed board never got written.
 */
const TodoWriteEntry = type({
	"id?": type("string").describe("caller-side item id; veyyon keys tasks by content and ignores it"),
	content: type("string").describe("task content"),
	"activeForm?": type("string").describe("caller-side present-tense label; unused"),
	status: type('"pending" | "in_progress" | "completed" | "cancelled"').describe("desired task status"),
});

const todoSchema = type({
	"op?": TodoOp,
	"list?": InitListEntry.array().describe("phased task list (init)"),
	"task?": type("string").describe("task content"),
	"phase?": type("string").describe("phase name"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").describe("task content").array().describe("tasks to append"),
	"todos?": TodoWriteEntry.array().describe("compatibility whole-board write; prefer op"),
	"merge?": type("boolean").describe("compatibility: false replaces the board, true or omitted merges by content"),
}).describe("apply a single todo operation");

type TodoSchema = typeof todoSchema.infer;
type TodoParams = TodoSchema & { op: TodoOperation };
/** A single normalized todo op entry. */
type TodoOpEntryValue = TodoParams;

// =============================================================================
// State helpers
// =============================================================================

/**
 * Outcome of resolving free text against the board. `ambiguous` exists so a
 * caller can say which of several tasks it could not choose between instead of
 * reporting "not found", which would be a lie.
 */
type TodoTaskMatch =
	| { kind: "hit"; task: TodoItem; phase: TodoPhase }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve a task by content: exact text first, then a normalized comparison
 * ({@link normalizeForTodoMatch}: lowercased, punctuation and whitespace runs
 * collapsed to single spaces).
 *
 * Content is the only task identity the tool has, and it is free text the model
 * retypes from an earlier result. A trailing period, a capitalized first word,
 * or an en dash where a hyphen was is enough to miss exact equality, and a miss
 * is not a soft failure: the whole op batch is discarded and the board write is
 * lost. Two tasks whose normalized text is equal are reported as ambiguous
 * rather than resolved to the first, because no op could ever address the
 * second one.
 */
function matchTaskByContent(phases: TodoPhase[], content: string): TodoTaskMatch {
	for (const phase of phases) {
		const task = phase.tasks.find(candidate => candidate.content === content);
		if (task) return { kind: "hit", task, phase };
	}
	const key = normalizeForTodoMatch(content);
	// Punctuation-only text normalizes to nothing and would match every other
	// punctuation-only task, so it never resolves through the fallback.
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

/** Phase counterpart of {@link matchTaskByContent}, with the same fallback. */
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

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
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

interface IndexedTodoTask {
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
			// `open` is the COMPLEMENT of terminal, not a list of the two open
			// spellings. A status added to the vocabulary lands on the correct side
			// of this count without anyone remembering to come back here.
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
					// A new status needs its own tally before it can be counted here.
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

function getTaskTransitions(previous: readonly TodoPhase[], updated: readonly TodoPhase[]): TodoTaskTransition[] {
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
				// A new status needs its own tally before a transition into it can
				// be reported. Silently uncounted transitions read as "nothing
				// happened" in telemetry.
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
	return unique.size > 0 ? [...unique.values()] : undefined;
}

function buildTodoTelemetry(
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

function normalizeInProgressTask(phases: TodoPhase[]): void {
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

function nextActionableEntry(phases: readonly TodoPhase[]): { task: TodoItem; phase: TodoPhase } | undefined {
	let firstPending: { task: TodoItem; phase: TodoPhase } | undefined;
	let firstOpen: { task: TodoItem; phase: TodoPhase } | undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return { task, phase };
			// The preference order names two statuses; the FALLBACK asks the owner.
			// Naming only `pending` here meant a board whose open work sat in a
			// status added later reported no next task at all, while the summary
			// printed above it still counted that work as open.
			if (isTerminalTodoStatus(task.status)) continue;
			firstOpen ??= { task, phase };
			if (task.status === "pending") firstPending ??= { task, phase };
		}
	}
	return firstPending ?? firstOpen;
}

/** Return the active todo task, preferring an in-progress item over the first pending item. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	return nextActionableEntry(phases)?.task;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export interface TodoPhasesSnapshot {
	found: boolean;
	phases: TodoPhase[];
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

/** Minimum overlap (after normalization) required for a substring match.
 * Picked at six chars to admit single-word identifiers like "review" /
 * "Sonnet" without admitting tiny common substrings like "test" / "fix"
 * that would collide across unrelated todos. */
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value.toLowerCase().replace(NON_ALNUM_RUN_RE, " ").trim();
}

/**
 * Report whether `content` likely names the same work as any entry in
 * `descriptions`. Used by the sticky todo panel to light up a pending todo
 * when an in-flight subagent is doing the work for it, without requiring
 * the caller to flip the todo's status.
 *
 * Matching is normalize-then-equal first (lowercased; punctuation and
 * whitespace runs both collapsed to a single space; trimmed), with a
 * substring fallback in either direction so minor wording drift
 * ("Sonnet #2: bug scan" vs "Sonnet #2") still links up. The substring
 * fallback requires at least {@link TODO_DESCRIPTION_MIN_OVERLAP} chars on
 * the contained side.
 */
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

function resolveTaskOrError(
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

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
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

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap(phase => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, report: TodoOpReport): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error.
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		report.errors.push("Missing list for init operation");
		return [];
	}

	// Repeated phase entries are a common parallel-planning shape: merge them in
	// first-seen order so every task remains addressable through one phase, and
	// say so through `report.notes`. Rejecting them instead would discard the
	// whole init, and a caller that then forced the duplicate through would own
	// a board whose second same-named phase no phase op can ever reach, since
	// targeting resolves the first name match. Merging is therefore the only
	// outcome that leaves the board operable; the note is what keeps it from
	// being a silent rewrite of what the caller sent. A missing phase continues
	// the previous entry, which is the documented shape and not a merge.
	// Duplicate task contents remain invalid because task targeting is
	// content-based and could not distinguish them.
	//
	// Both the phase merge and the duplicate check compare normalized text
	// ({@link normalizeForTodoMatch}), the same comparison targeting falls back
	// to. Keying them on raw text instead would let `init` build a board holding
	// two rows that every later op sees as one, which is precisely the state
	// that cannot be edited.
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
		// Names the phase that collapsed, never its items: the board itself is
		// already in the result, and an unbounded echo is what made the todo
		// failures unreadable in the first place.
		report.notes.push(
			`Merged ${count} repeated "${boundedTodoPreviewText(name, TODO_ITEM_PREVIEW_WIDTH)}" phase entries into one phase; every task is addressable through it.`,
		);
	}
	return phases;
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	// Validate the whole batch before mutating so a failing op reports every
	// duplicate and leaves nothing half-applied. Collision is judged the same
	// way targeting resolves a task: two contents that normalize alike are one
	// task as far as every later op is concerned, so appending the second would
	// create a row nothing can address.
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
	}
}

function normalizeTodoParams(params: TodoSchema, errors: string[]): TodoParams | undefined {
	if (params.op) return params as TodoParams;
	if ((params.list && params.list.length > 0) || (params.items && params.items.length > 0)) {
		return { ...params, op: "init" };
	}
	if (params.list) {
		errors.push("Missing op; an empty list cannot initialize or clear todos. Use op explicitly");
		return undefined;
	}
	if (params.todos) {
		// Same door as the empty `list` above. `{ merge: false, todos: [] }` is
		// "replace my board with nothing", and the compat branch in `execute`
		// only fires on a non-empty `todos`, so without this arm the call fell
		// through to `view` and the clear was silently read instead of applied.
		errors.push("Missing op; an empty todos list cannot initialize or clear todos. Use op explicitly");
		return undefined;
	}
	if (!params.task && !params.phase && !params.items) {
		return { ...params, op: "view" };
	}
	errors.push("Missing op; pass op explicitly unless a non-empty list/items payload makes this an init");
	return undefined;
}

/**
 * Translate a Claude/Cursor `TodoWrite` whole-board write into the ordered
 * `{op,...}` batch veyyon applies, plus the notes describing any adjustment
 * made to what the caller sent.
 *
 * Items are keyed by `content`, not by the caller's `id`: content is already
 * veyyon's task identity (every op targets `task`), and the incoming ids come
 * from the caller's own board, which this session never stored. The caller's
 * `id` and `activeForm` are therefore read and dropped.
 *
 * `merge: false` replaces the board, so the batch opens with an `init` holding
 * every incoming item. Otherwise the batch opens with an `append` for the
 * items the board does not already carry, then applies each item's status.
 */
export function adaptTodoWriteBatch(
	params: TodoSchema,
	currentPhases: readonly TodoPhase[],
): { ops: TodoParams[]; notes: string[] } {
	const incoming = params.todos ?? [];
	const notes: string[] = [];
	if (incoming.length === 0) return { ops: [], notes };
	// The incoming list is deduped against itself before anything else, in both
	// branches, because task identity is normalized text
	// ({@link normalizeForTodoMatch}) everywhere else: two items differing only
	// in case or punctuation are one task to `init`, to `append` and to every
	// later op that targets by content. Left in, they make `init` report
	// `Duplicate task` and `append` report `already exists`, and either error
	// discards the operator's entire board write.
	//
	// First occurrence wins, for both the surviving text and its status. That
	// matches the order `init` already merges repeated phase entries in, and it
	// keeps the text the operator sees anchored to where the item first appears
	// in the list they sent rather than to whichever near-duplicate trailed it.
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
		// Names the survivor and the count, never every collapsed variant: the
		// board itself is already in the result, and an unbounded echo is what
		// made the todo failures unreadable in the first place.
		notes.push(
			`Collapsed ${count} items differing only in case or punctuation into "${boundedTodoPreviewText(content, TODO_ITEM_PREVIEW_WIDTH)}"; task targeting cannot tell them apart.`,
		);
	}

	const ops: TodoParams[] = [];
	const replace = params.merge === false;

	if (replace) {
		ops.push({ op: "init", list: [{ phase: params.phase ?? DEFAULT_INIT_PHASE, items: todos.map(t => t.content) }] });
	} else {
		// Presence is judged the way targeting resolves a task, so an item the
		// board already carries is not appended a second time.
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
			// Landing zone for items the board has never seen: an explicitly named
			// phase, else the last phase already in play, else the init default.
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
				// `init`/`append` already created it pending, and no op moves a task
				// back to pending, so a pending entry is a presence assertion only.
				break;
		}
	}
	return { ops, notes };
}

function applyParams(phases: TodoPhase[], params: TodoParams): TodoOpReport & { phases: TodoPhase[] } {
	const report: TodoOpReport = { errors: [], notes: [] };
	const next = applyEntry(phases, params, report);
	normalizeInProgressTask(next);
	return { phases: next, ...report };
}

/**
 * Apply an array of `todo`-style ops to existing phases. Used by /todo slash
 * command. `errors` non-empty means the caller must discard `phases`; `notes`
 * describes adjustments to a result that stands.
 */
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

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
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

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
};

/** Parse a Markdown checklist back into todo phases. */
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
			if (!task && !phase) return "Todo list cleared. Overall: 0/0 done, 0 open.";
			changed = task ? `Removed: ${task}.` : `Removed phase: ${phase}.`;
			break;
		case "view":
			throw new Error("view operations require the full todo summary");
	}

	const closed = tasks.filter(item => isTerminalTodoStatus(item.status)).length;
	const next = nextActionableEntry(phases);
	const nextText = next
		? ` Next: ${boundedTodoPreviewText(`${next.task.content} (${next.phase.name})`, TODO_ITEM_PREVIEW_WIDTH)}.`
		: " Next: none.";
	return `${changed}${nextText} Overall: ${closed}/${tasks.length} done, ${tasks.length - closed} open.`;
}

/**
 * Render the model-facing result text. Notes ride ABOVE the body and are
 * phrased as an applied adjustment, never as a failure: the board printed
 * underneath is the board that landed. Errors keep their own "Errors:" line and
 * mean the opposite, that nothing landed.
 */
function formatSummary(phases: TodoPhase[], report: TodoOpReport, readOnly = false, params?: TodoParams): string {
	const body = formatSummaryBody(phases, report.errors, readOnly, params);
	if (report.notes.length === 0) return body;
	const notes = boundedTodoPreviewText(report.notes.join(" "), TODO_TOTAL_PREVIEW_WIDTH);
	return `Applied with adjustments: ${notes}\n${body}`;
}

/**
 * Bracket markers for the model-facing board preview. A table rather than a
 * ternary chain so a status added to the vocabulary stops the build here
 * instead of silently borrowing the pending marker and reading as open work.
 */
const TODO_PREVIEW_MARKERS: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[/]",
	completed: "[X]",
	abandoned: "[-]",
};

function formatSummaryBody(phases: TodoPhase[], errors: string[], readOnly: boolean, params?: TodoParams): string {
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
	// Open and closed are complements of one owner's decision, so
	// `closed + open === total` holds for any status the vocabulary grows.
	const closedAll = tasks.filter(task => isTerminalTodoStatus(task.status)).length;
	lines.push(`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open.`);
	if (currentIdx === -1) {
		lines.push(
			`Active phase: none (all ${phases.length} ${phases.length === 1 ? "phase is" : "phases are"} closed).`,
		);
	} else {
		const current = phases[currentIdx];
		const done = current.tasks.filter(task => isTerminalTodoStatus(task.status)).length;
		// The active phase is the EARLIEST one still holding open work, so the
		// in-progress pointer can sit in a phase whose successors already have
		// completed tasks. Explain that worked-ahead case explicitly.
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
	lines.push(...preview.lines);
	const hidden = tasks.length - preview.lines.length;
	if (hidden > 0) lines.push(`- … ${hidden} more item(s) retained in machine todo state.`);
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof todoSchema.infer>[] = [
		{
			caption: "Initial setup (multi-phase)",
			call: {
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
					{ phase: "Auth", items: ["Port credential store", "Wire OAuth providers"] },
					{ phase: "Verification", items: ["Run cargo test"] },
				],
			},
		},
		{
			caption: "Complete one task",
			call: { op: "done", task: "Wire workspace" },
		},
	];
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/todo"].text);
	}

	async execute(
		_toolCallId: string,
		params: TodoSchema,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);

		// A `TodoWrite`-shaped whole-board write expands to an ordered op batch
		// before the single-op path runs. Without this branch the call validates
		// clean, falls through to `view`, and the board write is silently lost.
		if (params.todos && params.todos.length > 0) {
			return this.#executeCompatBatch(params, previousPhases);
		}
		const normalizationErrors: string[] = [];
		const normalized = normalizeTodoParams(params, normalizationErrors);
		if (!normalized) {
			const storage = this.session.getSessionFile() ? "session" : "memory";
			return {
				content: [
					{ type: "text", text: formatSummary(previousPhases, { errors: normalizationErrors, notes: [] }, true) },
				],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = normalized.op === "view";
		const {
			phases: updated,
			errors,
			notes,
		} = readOnly
			? { phases: previousPhases, errors: [] as string[], notes: [] as string[] }
			: applyParams(clonePhases(previousPhases), normalized);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const details: TodoToolDetails = { op: normalized.op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;
		// A note describes an adjustment to a write that LANDED, so it is dropped
		// when the batch failed: there is nothing applied for it to describe.
		if (!failed && notes.length > 0) details.notes = notes;
		const telemetryDetail = sessionTelemetryDetail(
			this.session.settings.get("session.instrumentation"),
			"goal-verification",
		);
		if (telemetryDetail !== "none") {
			details.telemetry = buildTodoTelemetry(normalized.op, previousPhases, effective, telemetryDetail);
		}

		return {
			content: [
				{
					type: "text",
					text: formatSummary(effective, { errors, notes: failed ? [] : notes }, readOnly, normalized),
				},
			],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}

	/**
	 * Apply an adapted `TodoWrite` batch. The whole batch is atomic for the same
	 * reason a single op is: a half-applied board makes the natural retry hit
	 * "already exists" for the ops that did land.
	 */
	#executeCompatBatch(params: TodoSchema, previousPhases: TodoPhase[]): AgentToolResult<TodoToolDetails> {
		const { ops, notes: adapterNotes } = adaptTodoWriteBatch(params, previousPhases);
		const { phases: updated, errors, notes: applyNotes } = applyOpsToPhases(previousPhases, ops);
		// Adjustments the adapter made to the caller's list come first: they
		// explain the shape the ops below were built from.
		const notes = [...adapterNotes, ...applyNotes];
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const storage = this.session.getSessionFile() ? "session" : "memory";
		if (!failed) this.session.setTodoPhases?.(updated);
		// The batch's leading op is the honest single-word label for it: `init`
		// when the write replaced the board, `append` when it introduced tasks,
		// otherwise the first status change. A synthetic "batch" op would be a
		// value the schema does not accept.
		const batchOp: TodoOperation = ops[0]?.op ?? "view";
		const details: TodoToolDetails = { op: batchOp, phases: effective, storage };
		const completedTasks = failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (completedTasks.length > 0) details.completedTasks = completedTasks;
		if (!failed && notes.length > 0) details.notes = notes;
		const telemetryDetail = sessionTelemetryDetail(
			this.session.settings.get("session.instrumentation"),
			"goal-verification",
		);
		if (telemetryDetail !== "none") {
			details.telemetry = buildTodoTelemetry(batchOp, previousPhases, effective, telemetryDetail);
		}
		return {
			// No `params` argument: a whole-board write has no single mutation
			// line, so the full board summary is the accurate report.
			content: [{ type: "text", text: formatSummary(effective, { errors, notes: failed ? [] : notes }, false) }],
			details,
			isError: failed ? true : undefined,
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	items?: string[];
};

/** New single-op shape `{op,...}`; legacy `{ops:[...]}` still seen in old transcripts. */
type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

/**
 * Normalize streaming/legacy render args to a flat op list. Accepts the new
 * top-level `{op,...}` shape (returned as a one-element list), the legacy
 * `{ops:[...]}` batch from old transcripts/collab-web, and partially-parsed
 * streaming deltas (non-array `ops`, non-object entries) without crashing.
 */
function normalizeTodoArg(args: TodoRenderArgs | undefined): TodoRenderOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops)) {
		return args.ops.filter((entry): entry is TodoRenderOp => !!entry && typeof entry === "object");
	}
	return typeof args.op === "string" ? [args] : [];
}

// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/** Display-only phase header: `I. Foundation`. State and prompts never see this. */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${name}`;
}

export const TODO_STRIKE_HOLD_FRAMES = 2;
export const TODO_STRIKE_REVEAL_FRAMES = 12;
export const TODO_STRIKE_TOTAL_FRAMES = TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;
const EMPTY_COMPLETION_KEYS = new Set<string>();
const STRIKE_START = "\x1b[9m";
const STRIKE_END = "\x1b[29m";

function strikethroughText(text: string): string {
	return `${STRIKE_START}${text}${STRIKE_END}`;
}

function partialStrikethrough(text: string, visibleChars: number): string {
	if (visibleChars <= 0) return text;
	const chars = [...text];
	if (visibleChars >= chars.length) return strikethroughText(text);
	return `${strikethroughText(chars.slice(0, visibleChars).join(""))}${chars.slice(visibleChars).join("")}`;
}

function strikeRevealCount(text: string, frame: number | undefined): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= TODO_STRIKE_HOLD_FRAMES) return 0;
	const chars = [...text];
	if (chars.length === 0) return undefined;
	const revealFrame = Math.min(frame - TODO_STRIKE_HOLD_FRAMES, TODO_STRIKE_REVEAL_FRAMES);
	return Math.ceil((chars.length * revealFrame) / TODO_STRIKE_REVEAL_FRAMES);
}

function formatTodoLine(
	item: TodoItem,
	uiTheme: Theme,
	prefix: string,
	completionKeys: Set<string>,
	frame: number | undefined,
): string {
	const safeContent = boundedTodoPreviewText(item.content, TODO_ITEM_PREVIEW_WIDTH);
	const checkbox = uiTheme.checkbox;
	switch (item.status) {
		case "completed": {
			const revealCount = completionKeys.has(item.content) ? strikeRevealCount(safeContent, frame) : undefined;
			const content =
				revealCount === undefined ? strikethroughText(safeContent) : partialStrikethrough(safeContent, revealCount);
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${content}`);
		}
		case "in_progress":
			// Its own glyph, not the pending box in a different colour, and the
			// same one the HUD above the composer draws for this state.
			return uiTheme.fg("accent", `${prefix}${checkbox.progress} ${safeContent}`);
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${strikethroughText(safeContent)}`);
		case "pending":
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${safeContent}`);
		default:
			// A new status needs its own glyph and colour before the card can draw
			// it. Falling through to the pending box would paint closed work as
			// open, which is the collapse defect wearing a per-row disguise.
			item.status satisfies never;
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${safeContent}`);
	}
}

export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// `args` is the raw partially-parsed JSON from the streaming tool-call
		// delta and may not satisfy `TodoRenderArgs` at runtime:
		// `parseStreamingJson` can hand back `{ op: 1 }` mid-delta, or a legacy
		// `{ ops: "[" }` shape before fields stream. `normalizeTodoArg` guards
		// both the new single-op and legacy batch shapes so a malformed delta
		// never breaks the TUI render loop (#2005).
		const opsList = normalizeTodoArg(args);
		const visibleOps = opsList.slice(0, TODO_REMINDER_PREVIEW_LIMIT);
		const ops =
			visibleOps.length === 0
				? ["update"]
				: visibleOps.map(e => {
						const parts = [boundedTodoPreviewText(e.op ?? "update", 32)];
						if (e.task) parts.push(boundedTodoPreviewText(e.task, TODO_ITEM_PREVIEW_WIDTH));
						if (e.phase) parts.push(boundedTodoPreviewText(e.phase, TODO_ITEM_PREVIEW_WIDTH));
						if (Array.isArray(e.items) && e.items.length) {
							parts.push(`${formatCount("item", e.items.length)}`);
						}
						return parts.join(" ");
					});
		if (opsList.length > visibleOps.length)
			ops.push(`… ${formatCount("operation", opsList.length - visibleOps.length)} more`);
		// No body worth boxing while the call streams — a lone status line reads
		// cleaner than an empty frame. The container renders it without chrome.
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Todo", meta: ops },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(content => content.type === "text")?.text ?? "Todo operation failed";
			const header = renderStatusLine({ icon: "error", title: "Todo" }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		// A board with work on it and nothing left open is one green line: the
		// card is history the moment it is finished, and a finished plan redrawn
		// in full on every later turn is the bulk of a long transcript.
		//
		// Derived here, on the phases this render was handed, and stored nowhere.
		// The collapse is not a mode the widget can be left in — the next `append`
		// puts a pending task on the board and the full list comes straight back.
		if (isTodoListDone(phases)) {
			const doneTasks = phases.reduce((count, phase) => count + phase.tasks.length, 0);
			const summary = `${uiTheme.checkbox.checked} ${TODO_DONE_SUMMARY} · ${formatCount("task", doneTasks)}`;
			return new Text(uiTheme.fg("success", summary), 0, 0);
		}
		const completedTasks = result.details?.completedTasks ?? [];
		const completionKeysByPhase = new Map<string, Set<string>>();
		for (const task of completedTasks) {
			let keys = completionKeysByPhase.get(task.phase);
			if (!keys) {
				keys = new Set<string>();
				completionKeysByPhase.set(task.phase, keys);
			}
			keys.add(task.content);
		}
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.todo", "accent"),
				title: "Todo",
				meta: [formatCount("task", allTasks.length)],
			},
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = boundedTodoPreviewText(
				result.content?.find(content => content.type === "text")?.text ?? "No todos",
				TODO_TOTAL_PREVIEW_WIDTH,
			);
			return new Text(`${header}\n  ${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const { expanded, spinnerFrame } = options;
			const multiPhase = phases.length > 1;
			let bodyLines: string[];
			if (!expanded && multiPhase) {
				const collapsed = prioritizeTodoItems(
					phases.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name }))),
				);
				bodyLines = renderTreeList(
					{
						items: collapsed,
						expanded: false,
						maxCollapsed: TODO_REMINDER_PREVIEW_LIMIT,
						itemType: "todo",
						truncateFrom: "end",
						renderItem: todo => {
							const completionKeys = completionKeysByPhase.get(todo.phase) ?? EMPTY_COMPLETION_KEYS;
							const line = formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame);
							const phase = boundedTodoPreviewText(todo.phase, TODO_ITEM_PREVIEW_WIDTH);
							return `${line} ${uiTheme.fg("dim", `(${phase})`)}`;
						},
					},
					uiTheme,
				);
			} else {
				bodyLines = [];
				for (let p = 0; p < phases.length; p++) {
					const phase = phases[p];
					if (multiPhase) {
						const name = boundedTodoPreviewText(phase.name, TODO_ITEM_PREVIEW_WIDTH);
						bodyLines.push(uiTheme.fg("accent", chalk.bold(formatPhaseDisplayName(name, p + 1))));
					}
					const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_COMPLETION_KEYS;
					const treeLines = renderTreeList(
						{
							items: expanded ? phase.tasks : prioritizeTodoItems(phase.tasks),
							expanded,
							maxCollapsed: TODO_REMINDER_PREVIEW_LIMIT,
							itemType: "todo",
							truncateFrom: "end",
							renderItem: todo => formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame),
						},
						uiTheme,
					);
					bodyLines.push(...treeLines);
				}
			}
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
