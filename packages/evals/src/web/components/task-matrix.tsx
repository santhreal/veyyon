import { useState } from "react";
import type { ArmSummary, ExperimentDetail } from "../../wire";
import { isDecided, type TaskStat } from "./focus-panel";
import { shortTask } from "./task-chips";

export type TaskFilter = "all" | "split" | "focus-fail" | "focus-pass";

export const CELL_CLASS: Record<string, string> = {
	pass: "bg-emerald-500",
	fail: "bg-red-500",
	error: "bg-amber-500",
	running: "bg-sky-500 animate-pulse",
};

/** Per-task outcome grid with filters; a focused arm highlights its column. */
export function TaskMatrix({
	arms,
	tasks,
	matrix,
	taskStats,
	focus,
	onFocus,
}: {
	arms: ArmSummary[];
	tasks: string[];
	matrix: ExperimentDetail["matrix"];
	taskStats: Map<string, TaskStat>;
	focus: ArmSummary | null;
	onFocus: (key: string) => void;
}) {
	const [filter, setFilter] = useState<TaskFilter>("all");
	const [hardestFirst, setHardestFirst] = useState(false);
	const effective: TaskFilter = !focus && (filter === "focus-fail" || filter === "focus-pass") ? "all" : filter;
	const focusCells = focus ? (matrix[focus.arm] ?? {}) : null;
	const splitCount = tasks.filter(t => {
		const s = taskStats.get(t);
		return s !== undefined && s.passes > 0 && s.passes < s.decided;
	}).length;
	const visible = tasks.filter(task => {
		switch (effective) {
			case "all":
				return true;
			case "split": {
				const s = taskStats.get(task);
				return s !== undefined && s.passes > 0 && s.passes < s.decided;
			}
			case "focus-fail": {
				const s = focusCells?.[task]?.status;
				return isDecided(s) && s !== "pass";
			}
			case "focus-pass":
				return focusCells?.[task]?.status === "pass";
			default:
				return false;
		}
	});
	if (hardestFirst) {
		const rate = (t: string) => {
			const s = taskStats.get(t);
			return s !== undefined && s.decided > 0 ? s.passes / s.decided : Number.POSITIVE_INFINITY;
		};
		visible.sort((a, b) => rate(a) - rate(b) || a.localeCompare(b));
	}
	const chip = (id: TaskFilter, label: string, title?: string) => (
		<button
			key={id}
			type="button"
			title={title}
			onClick={() => setFilter(id)}
			className={`rounded px-2 py-0.5 ${effective === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
		>
			{label}
		</button>
	);
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
			<div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]">
				<span className="mr-2 text-xs text-zinc-400">task matrix</span>
				{chip("all", `all ${tasks.length}`)}
				{chip("split", `split ${splitCount}`, "tasks where arms disagree")}
				{focus &&
					chip(
						"focus-fail",
						`✗ ${focus.run.label || focus.arm}`,
						`tasks ${focus.run.label || focus.arm} failed or errored`,
					)}
				{focus &&
					chip("focus-pass", `✓ ${focus.run.label || focus.arm}`, `tasks ${focus.run.label || focus.arm} passed`)}
				<button
					type="button"
					onClick={() => setHardestFirst(v => !v)}
					className="ml-auto text-zinc-500 hover:text-zinc-300"
					title="toggle task ordering"
				>
					sort: {hardestFirst ? "hardest first" : "name"}
				</button>
			</div>
			<div className="overflow-x-auto">
				<table className="text-xs">
					<thead>
						<tr>
							<th className="pr-1 text-left font-normal text-zinc-500">task</th>
							<th className="pr-3 text-right font-normal text-zinc-600" title="arms passing / arms decided">
								✓
							</th>
							{arms.map(arm => (
								<th key={arm.arm} className="px-1 text-left font-normal" style={{ writingMode: "vertical-rl" }}>
									<button
										type="button"
										onClick={() => onFocus(arm.arm)}
										title={focus?.arm === arm.arm ? "clear focus" : `focus ${arm.run.label || arm.arm}`}
										className={`${focus?.arm === arm.arm ? "text-sky-300" : "text-zinc-500"} hover:text-sky-200`}
									>
										{arm.run.label || arm.arm}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{visible.map(task => {
							const stat = taskStats.get(task);
							return (
								<tr key={task} className="hover:bg-zinc-900/70">
									<td className="whitespace-nowrap pr-1 text-zinc-400" title={task}>
										{shortTask(task)}
									</td>
									<td className="pr-3 text-right tabular-nums text-zinc-600">
										{stat !== undefined && stat.decided > 0 ? `${stat.passes}/${stat.decided}` : "—"}
									</td>
									{arms.map(arm => {
										const cell = matrix[arm.arm]?.[task];
										return (
											<td
												key={arm.arm}
												className={`px-1 py-0.5 ${focus?.arm === arm.arm ? "bg-sky-400/10" : ""}`}
											>
												<a
													href={`#/runs/${encodeURIComponent(arm.run.jobName)}`}
													title={`${arm.run.label || arm.arm} · ${task}: ${cell ? cell.status : "pending"}${cell && cell.reward !== null ? ` · reward ${cell.reward.toFixed(2)}` : ""}`}
													className={`block h-3.5 w-3.5 rounded-sm ${cell ? (CELL_CLASS[cell.status] ?? "bg-zinc-600") : "bg-zinc-800"}`}
												/>
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
				{visible.length === 0 && (
					<div className="py-4 text-center text-xs text-zinc-600">no tasks match this filter</div>
				)}
			</div>
		</div>
	);
}
