import type { ArmProjection, ArmSummary, RunRole } from "../../engine/store-shapes";

/** One horizontal bar per arm; running arms chart their projected value. */
export interface MetricBar {
	key: string;
	label: string;
	role: RunRole;
	/** Value is a projection (arm still running) rather than a final observation. */
	projected: boolean;
	value: number;
}

export function metricBars(
	arms: ArmSummary[],
	actual: (arm: ArmSummary) => number | null,
	projected: (proj: ArmProjection) => number | null,
): MetricBar[] {
	const bars: MetricBar[] = [];
	for (const arm of arms) {
		const proj = arm.run.status === "running" ? arm.projected : null;
		const value = proj ? projected(proj) : actual(arm);
		if (value === null) continue;
		bars.push({ key: arm.arm, label: arm.run.label || arm.arm, role: arm.run.role, projected: proj !== null, value });
	}
	return bars;
}

const BAR_FILL: Record<RunRole, string> = {
	baseline: "bg-sky-500/85",
	variant: "bg-emerald-500/85",
	"": "bg-zinc-500/85",
};

const BAR_PROJECTED: Record<RunRole, string> = {
	baseline: "border border-dashed border-sky-400/70 bg-sky-400/15",
	variant: "border border-dashed border-emerald-400/70 bg-emerald-400/15",
	"": "border border-dashed border-zinc-400/70 bg-zinc-400/15",
};

/** Named horizontal bars, best value first, with a dashed tick at the anchor value. */
export function BarChart({
	title,
	bars,
	best,
	format,
	anchor,
	focus,
	onFocus,
}: {
	title: string;
	bars: MetricBar[];
	best: "high" | "low";
	format: (v: number) => string;
	anchor: number | null;
	focus: string | null;
	onFocus: (key: string) => void;
}) {
	const sorted = [...bars].sort((a, b) => (best === "high" ? b.value - a.value : a.value - b.value));
	const max = Math.max(...bars.map(b => b.value), anchor ?? 0);
	const anchorLeft = anchor !== null && max > 0 ? Math.min((100 * anchor) / max, 100) : null;
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
			<div className="mb-2 flex items-baseline justify-between">
				<h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h3>
				<span className="text-[9px] text-zinc-600">
					{best === "high" ? "higher is better" : "lower is better"} · best first
				</span>
			</div>
			{sorted.length === 0 ? (
				<div className="py-6 text-center text-xs text-zinc-600">no decided trials yet</div>
			) : (
				<div className="flex flex-col gap-px">
					{sorted.map(b => {
						const focusedBar = focus === b.key;
						const dim = focus !== null && !focusedBar;
						return (
							<button
								key={b.key}
								type="button"
								onClick={() => onFocus(b.key)}
								title={`${b.label} · ${format(b.value)}${b.projected ? " (projected)" : ""} — click to ${focusedBar ? "unfocus" : "focus"}`}
								className={`grid w-full grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_4rem] items-center gap-x-2 rounded px-1 py-[2.5px] text-left hover:bg-zinc-800/50 ${dim ? "opacity-40" : ""}`}
							>
								<span
									className={`truncate text-right text-[11px] ${focusedBar ? "text-sky-300" : "text-zinc-400"}`}
								>
									{b.label}
								</span>
								<span className="relative h-[13px] overflow-hidden rounded-[2px] bg-zinc-800/60">
									<span
										className={`absolute inset-y-0 left-0 rounded-[2px] ${b.projected ? BAR_PROJECTED[b.role] : BAR_FILL[b.role]}`}
										style={{ width: `${max > 0 ? (100 * b.value) / max : 0}%` }}
									/>
									{anchorLeft !== null && (
										<span
											aria-hidden="true"
											className="absolute inset-y-0 border-l border-dashed border-zinc-300/70"
											style={{ left: `calc(${anchorLeft}% - ${anchorLeft > 99 ? 1 : 0}px)` }}
										/>
									)}
								</span>
								<span className="text-[10px] tabular-nums text-zinc-400">
									{b.projected && <span className="text-zinc-600">→</span>}
									{format(b.value)}
								</span>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
