import type { ArmSummary } from "../../engine/store-shapes";

export type SortKey = "arm" | "note" | "status" | "progress" | "eta" | "pass" | "cost" | "time";

export interface SortSpec {
	key: SortKey;
	dir: 1 | -1;
}

/** First-click direction per column: metrics start at "best first". */
export const SORT_START_DIR: Record<SortKey, 1 | -1> = {
	arm: 1,
	note: 1,
	status: 1,
	progress: -1,
	eta: 1,
	pass: -1,
	cost: 1,
	time: 1,
};

const STATUS_RANK: Record<string, number> = { running: 0, complete: 1, failed: 2, cancelled: 3 };

function armSortValue(a: ArmSummary, key: SortKey): string | number | null {
	switch (key) {
		case "arm":
			return (a.run.label || a.arm).toLowerCase();
		case "note":
			return (a.run.note || a.config).toLowerCase();
		case "status":
			return STATUS_RANK[a.run.status] ?? 9;
		case "progress":
			return a.run.nTotal > 0 ? a.run.done / a.run.nTotal : a.run.done > 0 ? 0 : null;
		case "eta":
			return a.projected?.etaMs ?? null;
		case "pass":
			return a.passPct;
		case "cost":
			return a.costPerTask;
		case "time":
			return a.meanTrialMs;
	}
}

/** Sorted copy of the arms; null metric values always sink to the bottom. */
export function sortedArms(arms: ArmSummary[], sort: SortSpec | null): ArmSummary[] {
	if (!sort) return arms;
	return [...arms].sort((x, y) => {
		const vx = armSortValue(x, sort.key);
		const vy = armSortValue(y, sort.key);
		if (vx === null || vy === null) return vx === null ? (vy === null ? 0 : 1) : -1;
		const cmp = typeof vx === "string" && typeof vy === "string" ? vx.localeCompare(vy) : Number(vx) - Number(vy);
		return sort.dir * cmp;
	});
}

/** Sortable column header; click cycles best-first → reversed → default order. */
export function SortHeader({
	label,
	col,
	sort,
	onSort,
}: {
	label: string;
	col: SortKey;
	sort: SortSpec | null;
	onSort: (col: SortKey) => void;
}) {
	const dir = sort !== null && sort.key === col ? sort.dir : null;
	return (
		<th className="py-1 pr-4" aria-sort={dir === null ? undefined : dir === 1 ? "ascending" : "descending"}>
			<button
				type="button"
				onClick={() => onSort(col)}
				title={`sort by ${label}`}
				className={`inline-flex items-center gap-1 hover:text-zinc-200 ${dir === null ? "" : "text-zinc-200"}`}
			>
				{label}
				<span aria-hidden="true" className={`text-[8px] ${dir === null ? "text-zinc-700" : "text-sky-400"}`}>
					{dir === null ? "↕" : dir === 1 ? "▲" : "▼"}
				</span>
			</button>
		</th>
	);
}
