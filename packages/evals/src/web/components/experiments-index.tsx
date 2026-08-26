import { formatCount } from "@veyyon/utils/format";
import { type ExperimentSummary, formatUsd } from "../../wire";
import { usePolled } from "../hooks/use-polled";
import { Progress } from "./ui";

export function ExperimentsIndex() {
	const [experiments] = usePolled<ExperimentSummary[]>("/api/experiments", 3000);
	return <ExperimentsList experiments={experiments} />;
}

/**
 * The three states this view has. An empty store rendered an empty grid, which on screen is
 * a page with a nav bar and nothing under it — the same thing a failed fetch looks like.
 */
export function ExperimentsList({ experiments }: { experiments: ExperimentSummary[] | null }) {
	if (!experiments) return <div className="p-10 text-zinc-500">loading…</div>;
	if (experiments.length === 0) {
		return (
			<div className="p-10 text-zinc-500">
				no experiments yet. Launch a run with <span className="text-zinc-300">new run</span> to create one.
			</div>
		);
	}
	return (
		<div className="mx-auto grid max-w-5xl gap-3 p-6">
			{experiments.map(exp => (
				<a
					key={exp.id}
					href={`#/exp/${encodeURIComponent(exp.id)}`}
					className="flex min-w-0 items-center gap-6 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 px-5 py-4 hover:border-zinc-600"
				>
					<div className="w-40 shrink-0">
						<div className="font-semibold">{exp.id}</div>
						<div className="text-xs text-zinc-500">
							{formatCount("arm", exp.arms)}
							{exp.runningArms > 0 && <span className="text-sky-400"> · {exp.runningArms} live</span>}
						</div>
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs text-zinc-400" title={exp.goal}>
							{exp.goal || "—"}
						</div>
						<div className="text-xs text-zinc-600">{exp.datasets.join(", ")}</div>
					</div>
					<Progress run={{ ...exp, running: 0 }} />
					<div className="ml-auto flex gap-6 text-sm">
						<span className="text-emerald-400">
							{exp.done > 0 ? `${Math.round((100 * exp.pass) / exp.done)}%` : "—"}
						</span>
						<span>{formatUsd(exp.costUsd)}</span>
					</div>
				</a>
			))}
		</div>
	);
}
