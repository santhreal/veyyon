/** Short task id for chips and the matrix: drops the dataset prefix and the `repo__` stutter. */
export function shortTask(task: string): string {
	const base = task.slice(task.lastIndexOf("/") + 1);
	const us = base.lastIndexOf("__");
	return us >= 0 ? base.slice(us + 2) : base;
}

/** Task chips for the focus panel (winnable misses / unique wins). */
export function TaskChips({
	heading,
	items,
	tone,
	jobName,
	empty,
}: {
	heading: string;
	items: Array<{ task: string; title: string; badge?: string }>;
	tone: "fail" | "win";
	jobName: string;
	empty: string;
}) {
	return (
		<div className="mb-4">
			<div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
				{heading} <span className="text-zinc-600 normal-case">({items.length})</span>
			</div>
			{items.length === 0 ? (
				<div className="text-xs text-zinc-600">{empty}</div>
			) : (
				<div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
					{items.map(item => (
						<a
							key={item.task}
							href={`#/runs/${encodeURIComponent(jobName)}`}
							title={`${item.task} — ${item.title}`}
							className={`rounded border px-1.5 py-0.5 text-[11px] ${
								tone === "fail"
									? "border-red-500/30 text-red-300/90 hover:border-red-400"
									: "border-emerald-500/30 text-emerald-300/90 hover:border-emerald-400"
							}`}
						>
							{shortTask(item.task)}
							{item.badge && <span className="ml-1 text-[9px] text-zinc-500">{item.badge}</span>}
						</a>
					))}
				</div>
			)}
		</div>
	);
}
