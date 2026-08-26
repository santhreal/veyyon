import type { ArmSummary } from "../../wire";

/**
 * The comparison anchor for an experiment: the completed baseline arm with the
 * highest pass rate (the "ceiling" a prewalk arm tries to preserve). Ties
 * break toward the cheaper arm. Returns null when no baseline has finished data.
 */
export function pickReferenceArm(arms: ArmSummary[]): ArmSummary | null {
	let ref: ArmSummary | null = null;
	for (const a of arms) {
		if (a.run.role !== "baseline" || a.passPct === null) continue;
		if (
			ref === null ||
			a.passPct > (ref.passPct ?? -1) ||
			(a.passPct === ref.passPct && (a.costPerTask ?? Infinity) < (ref.costPerTask ?? Infinity))
		) {
			ref = a;
		}
	}
	return ref;
}

/**
 * Signed, colour-coded offset of a metric from the reference arm. `points`
 * shows absolute percentage-point difference (pass rate); `relative` shows a
 * percentage change (cost, time). `higherBetter` decides which direction is green.
 */
export function Delta({
	value,
	reference,
	mode,
	higherBetter,
}: {
	value: number | null;
	reference: number | null;
	mode: "points" | "relative";
	higherBetter: boolean;
}) {
	if (value === null || reference === null) return null;
	const raw =
		mode === "points" ? value - reference : reference === 0 ? Number.NaN : ((value - reference) / reference) * 100;
	if (!Number.isFinite(raw) || Math.abs(raw) < 0.5) {
		return <span className="ml-1 text-[10px] text-zinc-600">≈</span>;
	}
	const good = higherBetter ? raw > 0 : raw < 0;
	const body = `${raw > 0 ? "+" : "−"}${Math.abs(raw).toFixed(0)}${mode === "relative" ? "%" : ""}`;
	return (
		<span className={`ml-1 whitespace-nowrap text-[10px] ${good ? "text-emerald-500" : "text-red-400"}`}>
			({body})
		</span>
	);
}
