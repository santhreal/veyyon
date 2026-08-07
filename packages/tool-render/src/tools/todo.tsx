/** `todo` — phased task-list ops and the resulting board. */
import { formatCount } from "@veyyon/utils/format";
import { asTodoStatus, isTodoListDone, TODO_DONE_SUMMARY, type TodoStatus } from "@veyyon/wire";
import type { ReactNode } from "react";
import { Badges, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

const TASK_ICONS: Record<TodoStatus, string> = {
	completed: "✓",
	in_progress: "→",
	abandoned: "✕",
	pending: "○",
};

const ROMAN_PAIRS: ReadonlyArray<readonly [number, string]> = [
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

/** One-based roman numeral for phase headers (I, II, III, IV, …). */
function roman(n: number): string {
	if (n <= 0) return "";
	let out = "";
	let rem = n;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/**
 * Normalize call args to a flat op list. The current `todo` contract sends a
 * single top-level op `{op,...}`; legacy transcripts still carry the batched
 * `{ops:[...]}` shape. Non-record entries (streaming deltas) are dropped.
 */
function toOps(args: ToolRenderProps["args"]): unknown[] {
	if (Array.isArray(args.ops)) return args.ops;
	return typeof args.op === "string" ? [args] : [];
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const ops = toOps(args);
	const counts: Record<string, number> = {};
	const order: string[] = [];
	let firstTask: string | null = null;
	for (const entry of ops) {
		if (!isRecord(entry)) continue;
		const op = str(entry.op) ?? "update";
		if (counts[op] === undefined) {
			counts[op] = 0;
			order.push(op);
		}
		counts[op]++;
		if (firstTask === null) {
			firstTask = str(entry.task) ?? str(entry.phase);
			if (firstTask === null && Array.isArray(entry.list)) {
				const head = entry.list.find(isRecord);
				if (head && Array.isArray(head.items)) firstTask = str(head.items[0]);
			}
		}
	}
	const labels = order.map(op => (counts[op] > 1 ? `${op}×${counts[op]}` : op));
	return (
		<>
			<Badges items={labels.length > 0 ? labels : ["update"]} />
			{firstTask !== null && <span> {truncate(normalizeWs(firstTask), 60)}</span>}
		</>
	);
}

/** One arg op as a labeled row: op name + the task/phase/list it touches. */
function opRow(entry: unknown, key: number): ReactNode {
	if (!isRecord(entry)) return null;
	const parts: string[] = [];
	const task = str(entry.task);
	const phase = str(entry.phase);
	if (task !== null) parts.push(task);
	if (phase !== null) parts.push(phase);
	if (Array.isArray(entry.items) && entry.items.length > 0) {
		parts.push(formatCount("item", entry.items.length));
	}
	if (Array.isArray(entry.list) && entry.list.length > 0) {
		let tasks = 0;
		for (const phaseEntry of entry.list) {
			if (isRecord(phaseEntry) && Array.isArray(phaseEntry.items)) tasks += phaseEntry.items.length;
		}
		parts.push(`${formatCount("phase", entry.list.length)} · ${tasks} tasks`);
	}
	return (
		<Row key={key} k={str(entry.op) ?? "update"}>
			{truncate(normalizeWs(parts.join(" · ")), 160)}
		</Row>
	);
}

function Board({ phases }: { phases: unknown[] }): ReactNode {
	const board: Array<{ name: string; tasks: Array<{ status: TodoStatus; content: string }> }> = [];
	for (const phase of phases) {
		if (!isRecord(phase)) continue;
		const tasks: Array<{ status: TodoStatus; content: string }> = [];
		if (Array.isArray(phase.tasks)) {
			for (const task of phase.tasks) {
				if (!isRecord(task)) continue;
				tasks.push({ status: asTodoStatus(task.status), content: str(task.content) ?? "" });
			}
		}
		board.push({ name: str(phase.name) ?? "", tasks });
	}
	if (board.length === 0) return null;
	// Same derivation the TUI card uses, from the same owner, so an exported
	// transcript and the live terminal never disagree about whether a plan is
	// finished. Recomputed from the phases in the result on every render; the
	// export carries no "was collapsed" bit to read back.
	if (isTodoListDone(board)) {
		let done = 0;
		for (const phase of board) done += phase.tasks.length;
		const summary = `${TASK_ICONS.completed} ${TODO_DONE_SUMMARY} · ${formatCount("task", done)}`;
		return (
			<div className="tv-todo">
				<div className="tv-todo-done">{summary}</div>
			</div>
		);
	}
	const rendered: ReactNode[] = [];
	for (let i = 0; i < board.length; i++) {
		const phase = board[i];
		rendered.push(
			<div key={`p${i}`} className="tv-todo-phase">
				{roman(i + 1)}. {phase.name}
			</div>,
		);
		for (let t = 0; t < phase.tasks.length; t++) {
			const task = phase.tasks[t];
			rendered.push(
				<div key={`p${i}t${t}`} className={`tv-task tv-task--${task.status}`}>
					<span className="tv-task-icon">{TASK_ICONS[task.status]}</span>
					<span>{task.content}</span>
				</div>,
			);
		}
	}
	return <div className="tv-todo">{rendered}</div>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const ops = toOps(args);
	const rec = detailsRecord(result);
	const phases = rec && Array.isArray(rec.phases) && !result?.isError ? rec.phases : null;
	return (
		<>
			{ops.length > 0 && <div className="tv-list">{ops.map(opRow)}</div>}
			{phases !== null ? <Board phases={phases} /> : <ResultText result={result} maxLines={8} />}
		</>
	);
}

export const todoRenderer: ToolRenderer = { Summary, Body };
