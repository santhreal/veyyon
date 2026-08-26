import type { RunRole, RunRow } from "../../wire";

export const INPUT_CLASS = "rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm";

export const STATUS_CLASS: Record<string, string> = {
	running: "text-sky-400 border-sky-400",
	complete: "text-emerald-400 border-emerald-400",
	failed: "text-red-400 border-red-400",
	cancelled: "text-zinc-500 border-zinc-500",
	pass: "text-emerald-400 border-emerald-400",
	fail: "text-red-400 border-red-400",
	error: "text-amber-400 border-amber-400",
};

export function Chip({ label }: { label: string }) {
	return (
		<span
			className={`inline-block rounded-full border px-2 text-xs leading-5 ${STATUS_CLASS[label] ?? "text-zinc-400 border-zinc-500"}`}
		>
			{label}
		</span>
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
	return (
		<span className="inline-flex items-center gap-2">
			<span className="inline-flex h-2 w-32 overflow-hidden rounded bg-zinc-800 align-middle">
				<i style={{ width: seg(run.pass) }} className="bg-emerald-500" />
				<i style={{ width: seg(Math.max(0, run.fail - run.error)) }} className="bg-red-500" />
				<i style={{ width: seg(run.error) }} className="bg-amber-500" />
				<i style={{ width: seg(run.running) }} className="bg-sky-500/60" />
			</span>
			<span className="text-xs text-zinc-500">
				{run.done}/{run.nTotal || "?"}
			</span>
		</span>
	);
}
