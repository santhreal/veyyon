import { useCallback, useState } from "react";
import { type ArmSummary, type ExperimentDetail, formatUsd } from "../../wire";
import { usePolled } from "../hooks/use-polled";
import { AddArmForm } from "./add-arm-form";
import { ArmEditorRow } from "./arm-editor-row";
import { ArmRow } from "./arm-row";
import { BarChart, metricBars } from "./bar-chart";
import { pickReferenceArm } from "./delta";
import { computeTaskStats, FocusPanel } from "./focus-panel";
import { GoalEditor } from "./goal-editor";
import { ScatterChart, type ScatterPt } from "./scatter-chart";
import { SORT_START_DIR, SortHeader, type SortKey, type SortSpec, sortedArms } from "./sort-header";
import { TaskMatrix } from "./task-matrix";
import { StaleNotice } from "./ui";

export function ExperimentPage({ id }: { id: string }) {
	const [adding, setAdding] = useState(false);
	const [sort, setSort] = useState<SortSpec | null>(null);
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [detail, refresh, detailError] = usePolled<ExperimentDetail>("/api/experiments/:id", 3000, {
		params: { id },
	});
	const toggleFocus = useCallback((key: string) => setFocusKey(f => (f === key ? null : key)), []);
	if (!detail) {
		// A dropped poll failure left this pane reading "loading…" for as long as the manager stayed
		// down, which is what an experiment that does not exist looks like.
		return (
			<div className="p-10 text-zinc-500">
				{detailError ? <span className="text-amber-500">{detailError}</span> : "loading…"}
			</div>
		);
	}
	const { arms, tasks, matrix, goal } = detail;

	const focusArm = focusKey ? (arms.find((a: ArmSummary) => a.arm === focusKey) ?? null) : null;
	const anchor = focusArm ?? pickReferenceArm(arms);
	const rows = sortedArms(arms, sort);
	const taskStats = computeTaskStats(arms, matrix, tasks);
	const cycleSort = (key: SortKey) =>
		setSort(s =>
			!s || s.key !== key
				? { key, dir: SORT_START_DIR[key] }
				: s.dir === SORT_START_DIR[key]
					? { key, dir: (s.dir * -1) as 1 | -1 }
					: null,
		);

	const passBars = metricBars(
		arms,
		a => a.passPct,
		p => p.passPct,
	);
	const costBars = metricBars(
		arms,
		a => a.costPerTask,
		p => p.costPerTask,
	);
	const timeBars = metricBars(
		arms,
		a => (a.meanTrialMs === null ? null : a.meanTrialMs / 60000),
		p => p.meanTrialMs / 60000,
	);
	const scatterPts: ScatterPt[] = [];
	for (const a of arms) {
		const proj = a.run.status === "running" ? a.projected : null;
		const cost = proj ? proj.costPerTask : a.costPerTask;
		const pass = proj ? proj.passPct : a.passPct;
		if (cost === null || pass === null) continue;
		scatterPts.push({
			key: a.arm,
			label: a.run.label || a.arm,
			role: a.run.role,
			projected: proj !== null,
			cost,
			pass,
		});
	}
	const anchorPass = anchor?.passPct ?? anchor?.projected?.passPct ?? null;
	const anchorCost = anchor?.costPerTask ?? anchor?.projected?.costPerTask ?? null;
	const anchorTimeMs = anchor?.meanTrialMs ?? anchor?.projected?.meanTrialMs ?? null;
	const scatterAnchor = anchor ? (scatterPts.find((p: ScatterPt) => p.key === anchor.arm) ?? null) : null;

	return (
		<div className="mx-auto max-w-7xl p-6">
			{detailError && <StaleNotice error={detailError} />}
			<div className="mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<h2 className="text-lg font-semibold">{id}</h2>
				<span className="text-xs text-zinc-500">
					{arms.length} arms · {tasks.length} tasks
					{anchor && (
						<>
							{" "}
							· Δ vs{" "}
							<span className={focusArm ? "text-sky-300" : "text-zinc-400"}>
								{anchor.run.label || anchor.arm}
							</span>
							<span className="text-zinc-600">{focusArm ? " (focused)" : " (ref)"}</span>
						</>
					)}
					{!focusArm && <span className="text-zinc-600"> · click an arm to focus it</span>}
				</span>
				<button
					type="button"
					onClick={() => setAdding(v => !v)}
					className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-xs hover:border-sky-400"
				>
					{adding ? "cancel" : "+ add arm"}
				</button>
			</div>
			<GoalEditor id={id} goal={goal} onSaved={refresh} />
			{adding && <AddArmForm experimentId={id} onDone={() => setAdding(false)} />}

			<table className="mb-6 w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-zinc-500">
						<SortHeader label="arm" col="arm" sort={sort} onSort={cycleSort} />
						<SortHeader label="description" col="note" sort={sort} onSort={cycleSort} />
						<SortHeader label="status" col="status" sort={sort} onSort={cycleSort} />
						<SortHeader label="progress" col="progress" sort={sort} onSort={cycleSort} />
						<SortHeader label="eta" col="eta" sort={sort} onSort={cycleSort} />
						<SortHeader label="pass%" col="pass" sort={sort} onSort={cycleSort} />
						<SortHeader label="$/task" col="cost" sort={sort} onSort={cycleSort} />
						<SortHeader label="mean" col="time" sort={sort} onSort={cycleSort} />
						<th />
					</tr>
				</thead>
				<tbody>
					{rows.map(arm =>
						editing === arm.run.jobName ? (
							<ArmEditorRow
								key={arm.run.jobName}
								arm={arm}
								experimentId={id}
								onSaved={() => {
									setEditing(null);
									refresh();
								}}
								onCancel={() => setEditing(null)}
							/>
						) : (
							<ArmRow
								key={arm.run.jobName}
								arm={arm}
								anchor={anchor}
								focused={focusKey === arm.arm}
								onFocus={() => toggleFocus(arm.arm)}
								onEdit={() => setEditing(arm.run.jobName)}
							/>
						),
					)}
				</tbody>
			</table>

			{focusArm && (
				<FocusPanel
					arms={arms}
					matrix={matrix}
					tasks={tasks}
					taskStats={taskStats}
					focus={focusArm}
					onFocus={toggleFocus}
					onClear={() => setFocusKey(null)}
				/>
			)}

			<section className="mb-6">
				<div className="mb-2 flex select-none flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[9px] text-zinc-500">
					<span className="flex items-center gap-1">
						<i aria-hidden="true" className="h-2 w-2 rounded-[1px] bg-sky-500" /> baseline
					</span>
					<span className="flex items-center gap-1">
						<i aria-hidden="true" className="h-2 w-2 rounded-[1px] bg-emerald-500" /> variant
					</span>
					<span className="flex items-center gap-1">
						<i aria-hidden="true" className="h-2 w-2 rounded-[1px] border border-dashed border-zinc-400" />{" "}
						projected (running)
					</span>
					{anchor && (
						<span className="flex items-center gap-1">
							<i aria-hidden="true" className="h-2.5 w-0 border-l border-dashed border-zinc-300/80" />{" "}
							{anchor.run.label || anchor.arm}
						</span>
					)}
				</div>
				<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
					<ScatterChart pts={scatterPts} anchor={scatterAnchor} focus={focusKey} onFocus={toggleFocus} />
					<BarChart
						title="success %"
						bars={passBars}
						best="high"
						format={v => `${v.toFixed(1)}%`}
						anchor={anchorPass}
						focus={focusKey}
						onFocus={toggleFocus}
					/>
					<BarChart
						title="$ / task"
						bars={costBars}
						best="low"
						format={formatUsd}
						anchor={anchorCost}
						focus={focusKey}
						onFocus={toggleFocus}
					/>
					<BarChart
						title="mean minutes / task"
						bars={timeBars}
						best="low"
						format={v => `${v.toFixed(1)}m`}
						anchor={anchorTimeMs === null ? null : anchorTimeMs / 60000}
						focus={focusKey}
						onFocus={toggleFocus}
					/>
				</div>
			</section>

			<TaskMatrix
				arms={rows}
				tasks={tasks}
				matrix={matrix}
				taskStats={taskStats}
				focus={focusArm}
				onFocus={toggleFocus}
			/>
		</div>
	);
}
