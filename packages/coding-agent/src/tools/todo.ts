import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import { sessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { formatCount, prompt } from "@veyyon/utils";
import { isTerminalTodoStatus, isTodoListDone, TODO_DONE_SUMMARY, type TodoStatus } from "@veyyon/wire";
import chalk from "chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from "../sdk";
import { framedBlock, renderStatusLine, renderTreeList } from "../tui";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { formatErrorDetail } from "./render-utils";

import {
	appendItems,
	boundedTodoPreviewText,
	buildTodoTelemetry,
	clonePhases,
	createBoundedTodoPreview,
	DEFAULT_INIT_PHASE,
	getCompletionTransitions,
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
	type TodoOperation,
	type TodoOpReport,
	type TodoParams,
	type TodoPhase,
	type TodoSchema,
	type TodoToolDetails,
	todoSchema,
} from "./todo-helpers";

export {
	boundedTodoPreviewText,
	createBoundedTodoPreview,
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
export type { TodoStatus } from "@veyyon/wire";

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

function applyParams(phases: TodoPhase[], params: TodoParams): TodoOpReport & { phases: TodoPhase[] } {
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

function formatOverall(tasks: readonly TodoItem[]): string {
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

function formatSummary(phases: TodoPhase[], report: TodoOpReport, readOnly = false, params?: TodoParams): string {
	const body = formatSummaryBody(phases, report.errors, readOnly, params);
	if (report.notes.length === 0) return body;
	const notes = boundedTodoPreviewText(report.notes.join(" "), TODO_TOTAL_PREVIEW_WIDTH);
	return `Applied with adjustments: ${notes}\n${body}`;
}

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

		if (params.todos && params.todos.length > 0) {
			return this.#executeCompatBatch(params, previousPhases);
		}
		if (params.todos) {
			const storage = this.session.getSessionFile() ? "session" : "memory";
			return {
				content: [
					{
						type: "text",
						text: formatSummary(
							previousPhases,
							{
								errors: [
									'An empty "todos" list cannot initialize or clear todos. Pass op explicitly: op "rm" clears the board',
								],
								notes: [],
							},
							true,
						),
					},
				],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const normalized = params as TodoParams;
		const readOnly = normalized.op === "view";
		const {
			phases: updated,
			errors,
			notes,
		} = readOnly
			? { phases: previousPhases, errors: [] as string[], notes: [] as string[] }
			: applyParams(clonePhases(previousPhases), normalized);
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const details: TodoToolDetails = { op: normalized.op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;
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

	#executeCompatBatch(params: TodoSchema, previousPhases: TodoPhase[]): AgentToolResult<TodoToolDetails> {
		const { ops, notes: adapterNotes } = adaptTodoWriteBatch(params, previousPhases);
		const { phases: updated, errors, notes: applyNotes } = applyOpsToPhases(previousPhases, ops);
		const notes = adapterNotes.concat(applyNotes);
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const storage = this.session.getSessionFile() ? "session" : "memory";
		if (!failed) this.session.setTodoPhases?.(updated);
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
			content: [{ type: "text", text: formatSummary(effective, { errors, notes: failed ? [] : notes }, false) }],
			details,
			isError: failed ? true : undefined,
		};
	}
}

type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	items?: string[];
};

type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

function normalizeTodoArg(args: TodoRenderArgs | undefined): TodoRenderOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops)) {
		return args.ops.filter((entry): entry is TodoRenderOp => !!entry && typeof entry === "object");
	}
	return typeof args.op === "string" ? [args] : [];
}

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

export function todoStrikeReveal(text: string, frame: number | undefined): string {
	const revealCount = strikeRevealCount(text, frame);
	if (revealCount === undefined) return strikethroughText(text);
	return partialStrikethrough(text, revealCount);
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
			const strikeFrame = completionKeys.has(item.content) ? frame : undefined;
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${todoStrikeReveal(safeContent, strikeFrame)}`);
		}
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.progress} ${safeContent}`);
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${strikethroughText(safeContent)}`);
		case "pending":
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${safeContent}`);
		default:
			item.status satisfies never;
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${safeContent}`);
	}
}

export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
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
		const allTasks: TodoItem[] = [];
		for (let pi = 0; pi < phases.length; pi++) {
			const phaseTasks = phases[pi]!.tasks;
			for (let ti = 0; ti < phaseTasks.length; ti++) allTasks.push(phaseTasks[ti]!);
		}
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

		if (!options.expanded) {
			const active = allTasks.find(task => task.status === "in_progress");
			const moved = active ?? completedTasks[completedTasks.length - 1];
			const phaseOf = phases.find(phase => phase.tasks.some(task => task.content === moved?.content));
			let completedCount = 0;
			for (let ti = 0; ti < allTasks.length; ti++) {
				if (allTasks[ti]!.status === "completed") completedCount++;
			}
			const parts = [uiTheme.fg("dim", formatCount("done", completedCount))];
			if (phaseOf && phases.length > 1) {
				parts.push(uiTheme.fg("muted", boundedTodoPreviewText(phaseOf.name, TODO_ITEM_PREVIEW_WIDTH)));
			}
			if (moved) {
				const mark = active ? uiTheme.checkbox.progress : uiTheme.checkbox.checked;
				const color = active ? "accent" : "success";
				parts.push(uiTheme.fg(color, `${mark} ${boundedTodoPreviewText(moved.content, TODO_ITEM_PREVIEW_WIDTH)}`));
			}
			return new Text(`${header} ${uiTheme.fg("dim", "·")} ${parts.join(uiTheme.fg("dim", " · "))}`, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const { expanded, spinnerFrame } = options;
			const multiPhase = phases.length > 1;
			let bodyLines: string[];
			if (!expanded && multiPhase) {
				const collapsedItems: Array<TodoItem & { phase: string }> = [];
				for (let pi = 0; pi < phases.length; pi++) {
					const p = phases[pi]!;
					for (let ti = 0; ti < p.tasks.length; ti++) {
						collapsedItems.push({ ...p.tasks[ti]!, phase: p.name });
					}
				}
				const collapsed = prioritizeTodoItems(collapsedItems);
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
					for (let li = 0; li < treeLines.length; li++) bodyLines.push(treeLines[li]!);
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
