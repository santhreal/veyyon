import type { ArmSummary, ExperimentDetail } from "../../wire";
import { TaskChips } from "./task-chips";
import { RoleTag } from "./ui";

/** Trial statuses that count as decided when comparing arms (error = fail). */
export function isDecided(s: string | undefined): s is string {
	return s === "pass" || s === "fail" || s === "error";
}

export interface TaskStat {
	passes: number;
	decided: number;
	/** Display names of the arms that passed the task. */
	passedBy: string[];
}

export function computeTaskStats(
	arms: ArmSummary[],
	matrix: ExperimentDetail["matrix"],
	tasks: string[],
): Map<string, TaskStat> {
	const stats = new Map<string, TaskStat>();
	for (const task of tasks) stats.set(task, { passes: 0, decided: 0, passedBy: [] });
	for (const arm of arms) {
		const cells = matrix[arm.arm] ?? {};
		for (const task of tasks) {
			const status = cells[task]?.status;
			if (!isDecided(status)) continue;
			const stat = stats.get(task);
			if (!stat) continue;
			stat.decided++;
			if (status === "pass") {
				stat.passes++;
				stat.passedBy.push(arm.run.label || arm.arm);
			}
		}
	}
	return stats;
}

export interface HeadToHead {
	arm: ArmSummary;
	/** Tasks the focused arm passed that this arm decided and failed. */
	focusWins: number;
	/** Tasks this arm passed that the focused arm decided and failed. */
	armWins: number;
	bothPass: number;
	bothFail: number;
	shared: number;
}

export function headToHead(
	focusCells: Record<string, { status: string; reward: number | null }>,
	arm: ArmSummary,
	cells: Record<string, { status: string; reward: number | null }>,
	tasks: string[],
): HeadToHead {
	let focusWins = 0;
	let armWins = 0;
	let bothPass = 0;
	let bothFail = 0;
	for (const task of tasks) {
		const f = focusCells[task]?.status;
		const o = cells[task]?.status;
		if (!isDecided(f) || !isDecided(o)) continue;
		const fPass = f === "pass";
		const oPass = o === "pass";
		if (fPass && oPass) bothPass++;
		else if (fPass) focusWins++;
		else if (oPass) armWins++;
		else bothFail++;
	}
	return { arm, focusWins, armWins, bothPass, bothFail, shared: focusWins + armWins + bothPass + bothFail };
}

/** Ordinal standing of the focused arm among arms with data, e.g. "#2/9 by pass%". */
export function rankLine(arms: ArmSummary[], focus: ArmSummary): string {
	const rank = (metric: (a: ArmSummary) => number | null, best: "high" | "low"): string => {
		const values = arms.map(metric).filter((v): v is number => v !== null);
		const own = metric(focus);
		if (own === null || values.length === 0) return "—";
		values.sort((a, b) => (best === "high" ? b - a : a - b));
		return `#${values.indexOf(own) + 1}/${values.length}`;
	};
	return `${rank(a => a.passPct, "high")} by pass% · ${rank(a => a.costPerTask, "low")} by $/task`;
}

/**
 * Focused-arm drilldown: head-to-head vs every sibling plus the task sets
 * that separate them (winnable misses, unique wins).
 */
export function FocusPanel({
	arms,
	matrix,
	tasks,
	taskStats,
	focus,
	onFocus,
	onClear,
}: {
	arms: ArmSummary[];
	matrix: ExperimentDetail["matrix"];
	tasks: string[];
	taskStats: Map<string, TaskStat>;
	focus: ArmSummary;
	onFocus: (key: string) => void;
	onClear: () => void;
}) {
	const name = focus.run.label || focus.arm;
	const focusCells = matrix[focus.arm] ?? {};
	const rivals = arms
		.filter(a => a.arm !== focus.arm)
		.map(a => headToHead(focusCells, a, matrix[a.arm] ?? {}, tasks))
		.sort((a, b) => b.armWins - b.focusWins - (a.armWins - a.focusWins));
	const fumbles: Array<{ task: string; passedBy: string[] }> = [];
	const uniques: string[] = [];
	for (const task of tasks) {
		const own = focusCells[task]?.status;
		if (!isDecided(own)) continue;
		const stat = taskStats.get(task);
		if (!stat) continue;
		if (own === "pass") {
			if (stat.passes === 1 && stat.decided > 1) uniques.push(task);
		} else if (stat.passes > 0) {
			fumbles.push({ task, passedBy: stat.passedBy });
		}
	}
	return (
		<section className="mb-6 rounded-lg border border-sky-500/25 bg-zinc-900/60 p-4">
			<div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h3 className="font-semibold text-sky-300">◉ {name}</h3>
				{focus.run.role && <RoleTag role={focus.run.role} />}
				<span className="text-xs text-zinc-500">{rankLine(arms, focus)}</span>
				<a
					href={`#/runs/${encodeURIComponent(focus.run.jobName)}`}
					className="text-xs text-zinc-500 underline hover:text-zinc-300"
				>
					trials
				</a>
				<button
					type="button"
					onClick={onClear}
					className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
				>
					clear focus
				</button>
			</div>
			<div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">head-to-head</div>
					<div className="mb-1.5 text-[10px] text-zinc-600">
						first mark = {name} · over tasks both arms decided · error counts as fail
					</div>
					<table className="w-full text-xs">
						<thead>
							<tr className="text-left text-[10px] text-zinc-600">
								<th className="py-0.5 pr-2 font-normal">vs</th>
								<th className="pr-2 font-normal" title="wins minus losses for the focused arm">
									net
								</th>
								<th className="pr-2 font-normal" title={`${name} passed · rival failed`}>
									✓·✗
								</th>
								<th className="pr-2 font-normal" title={`rival passed · ${name} failed`}>
									✗·✓
								</th>
								<th className="pr-2 font-normal" title="both passed">
									✓·✓
								</th>
								<th className="pr-2 font-normal" title="both failed">
									✗·✗
								</th>
							</tr>
						</thead>
						<tbody>
							{rivals.map(r => {
								const net = r.focusWins - r.armWins;
								return (
									<tr key={r.arm.arm} className="border-t border-zinc-800/60">
										<td className="py-1 pr-2">
											<button
												type="button"
												onClick={() => onFocus(r.arm.arm)}
												title={`switch focus to ${r.arm.run.label || r.arm.arm}`}
												className="underline decoration-zinc-700 underline-offset-2 hover:text-sky-300"
											>
												{r.arm.run.label || r.arm.arm}
											</button>
										</td>
										{r.shared === 0 ? (
											<td colSpan={5} className="pr-2 text-zinc-600">
												no shared decided tasks yet
											</td>
										) : (
											<>
												<td
													className={`pr-2 tabular-nums ${net > 0 ? "text-emerald-400" : net < 0 ? "text-red-400" : "text-zinc-500"}`}
												>
													{net > 0 ? `+${net}` : net}
												</td>
												<td className="pr-2 tabular-nums text-emerald-500">{r.focusWins}</td>
												<td className="pr-2 tabular-nums text-red-400">{r.armWins}</td>
												<td className="pr-2 tabular-nums text-zinc-500">{r.bothPass}</td>
												<td className="pr-2 tabular-nums text-zinc-600">{r.bothFail}</td>
											</>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<div className="min-w-0">
					<TaskChips
						heading={`${name} failed · another arm passed`}
						tone="fail"
						jobName={focus.run.jobName}
						empty="none — no winnable misses on this sample"
						items={fumbles.map(f => ({
							task: f.task,
							title: `passed by ${f.passedBy.join(", ")}`,
							badge: `✓${f.passedBy.length}`,
						}))}
					/>
					<TaskChips
						heading={`only ${name} passed`}
						tone="win"
						jobName={focus.run.jobName}
						empty="none"
						items={uniques.map(t => ({ task: t, title: `${name} is the only arm that passed` }))}
					/>
				</div>
			</div>
		</section>
	);
}
