import type { RunRole, RunRow, RunStatus, TrialStatus } from "../../wire";

export const INPUT_CLASS = "rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm";

/**
 * One class per lifecycle and trial status. Keyed by both unions, so a new member of either fails
 * this file to compile rather than rendering in the fallback grey a chip uses for a label it has
 * never heard of.
 */
export const STATUS_CLASS: Record<RunStatus | TrialStatus, string> = {
	running: "text-sky-400 border-sky-400",
	complete: "text-emerald-400 border-emerald-400",
	failed: "text-red-400 border-red-400",
	cancelled: "text-zinc-500 border-zinc-500",
	pass: "text-emerald-400 border-emerald-400",
	fail: "text-red-400 border-red-400",
	error: "text-amber-400 border-amber-400",
};

/**
 * What a pane read, when it could not be read. A swallowed poll failure left the last good payload
 * on screen, or an empty frame that looks exactly like a store with nothing in it.
 */
export function StaleNotice({ error }: { error: string }) {
	return (
		<div className="border-b border-amber-900/60 bg-amber-950/40 px-4 py-1.5 text-xs text-amber-400">{error}</div>
	);
}

export function Chip({ label }: { label: RunStatus | TrialStatus }) {
	return (
		<span className={`inline-block rounded-full border px-2 text-xs leading-5 ${STATUS_CLASS[label]}`}>{label}</span>
	);
}

export function RoleTag({ role }: { role: RunRole }) {
	return (
		<span
			className={`ml-2 rounded-full border px-1.5 text-[10px] ${role === "baseline" ? "border-sky-500 text-sky-400" : "border-emerald-600 text-emerald-400"}`}
		>
			{role}
		</span>
	);
}

export function Progress({
	run,
}: {
	run: RunRow | { pass: number; fail: number; error: number; running: number; done: number; nTotal: number };
}) {
	const total = Math.max(run.nTotal, run.done + run.running, 1);
	const seg = (n: number) => `${(100 * n) / total}%`;
	// pass, fail and error are disjoint counts summing to `done`. Subtracting the errors from the
	// failures drew a bar short of the count printed beside it, and hid the failures entirely on a
	// run with more errors than failures.
	return (
		<span className="inline-flex items-center gap-2">
			<span className="inline-flex h-2 w-32 overflow-hidden rounded bg-zinc-800 align-middle">
				<i style={{ width: seg(run.pass) }} className="bg-emerald-500" />
				<i style={{ width: seg(run.fail) }} className="bg-red-500" />
				<i style={{ width: seg(run.error) }} className="bg-amber-500" />
				<i style={{ width: seg(run.running) }} className="bg-sky-500/60" />
			</span>
			<span className="text-xs text-zinc-500">
				{run.done}/{run.nTotal || "?"}
			</span>
		</span>
	);
}
