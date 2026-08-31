import { type ArmSummary, formatEta, formatMinutes, formatUsd } from "../../engine/store-shapes";
import { Delta } from "./delta";
import { Chip, Progress, RoleTag } from "./ui";

/** One arm row: click to focus, hover reveals the metadata editor trigger. */
export function ArmRow({
	arm,
	anchor,
	focused,
	onFocus,
	onEdit,
}: {
	arm: ArmSummary;
	anchor: ArmSummary | null;
	focused: boolean;
	onFocus: () => void;
	onEdit: () => void;
}) {
	const name = arm.run.label || arm.arm;
	const isAnchor = anchor?.arm === arm.arm;
	return (
		<tr
			onClick={ev => {
				if ((ev.target as HTMLElement).closest("a,button,input,select,textarea")) return;
				onFocus();
			}}
			className={`group cursor-pointer border-t border-zinc-800/70 ${focused ? "bg-sky-400/[0.07]" : "hover:bg-zinc-900/60"}`}
		>
			<td className="py-1.5 pr-4 font-medium">
				<button
					type="button"
					onClick={onFocus}
					title={focused ? "clear focus" : "focus this arm to compare it against the others"}
					className={`text-left hover:text-sky-300 ${focused ? "text-sky-300" : ""}`}
				>
					{name}
				</button>
				{arm.run.label && (
					<span className="ml-1.5 text-[10px] text-zinc-600" title={`job ${arm.run.jobName}`}>
						{arm.recordedArm}
					</span>
				)}
				{arm.run.role && <RoleTag role={arm.run.role} />}
				{isAnchor && !focused && (
					<span
						className="ml-1 text-[10px] text-zinc-500"
						title="reference arm (highest-pass baseline); deltas are measured against it"
					>
						ref
					</span>
				)}
			</td>
			<td className="max-w-md truncate pr-4 text-xs text-zinc-400" title={`${arm.run.note} · ${arm.config}`}>
				{arm.run.note || arm.config || "—"}
			</td>
			<td className="pr-4">
				<Chip label={arm.run.status} />
			</td>
			<td className="pr-4">
				<Progress run={arm.run} />
			</td>
			<td className="pr-4 text-sky-300">{arm.projected ? formatEta(arm.projected.etaMs) : "—"}</td>
			<td className="pr-4 tabular-nums">
				{arm.passPct !== null ? `${arm.passPct.toFixed(0)}%` : "—"}
				{arm.projected && <span className="text-zinc-500"> →{arm.projected.passPct.toFixed(0)}%</span>}
				{anchor && !isAnchor && <Delta value={arm.passPct} reference={anchor.passPct} mode="points" higherBetter />}
			</td>
			<td className="pr-4 tabular-nums">
				{formatUsd(arm.costPerTask)}
				{arm.projected && <span className="text-zinc-500"> Σ{formatUsd(arm.projected.totalCostUsd)}</span>}
				{anchor && !isAnchor && (
					<Delta value={arm.costPerTask} reference={anchor.costPerTask} mode="relative" higherBetter={false} />
				)}
			</td>
			<td className="pr-4 tabular-nums">
				{arm.meanTrialMs !== null ? formatMinutes(arm.meanTrialMs) : "—"}
				{anchor && !isAnchor && (
					<Delta value={arm.meanTrialMs} reference={anchor.meanTrialMs} mode="relative" higherBetter={false} />
				)}
			</td>
			<td className="whitespace-nowrap py-1.5 text-right">
				<button
					type="button"
					onClick={onEdit}
					aria-label={`edit ${name} name and description`}
					title="rename · describe · set role"
					className="mr-2 rounded px-1 text-xs text-zinc-500 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
				>
					✎
				</button>
				<a
					className="text-xs text-zinc-500 underline hover:text-zinc-300"
					href={`#/runs/${encodeURIComponent(arm.run.jobName)}`}
				>
					trials
				</a>
			</td>
		</tr>
	);
}
