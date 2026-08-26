import { useCallback, useEffect, useRef, useState } from "react";
import {
	formatMinutes,
	formatUsd,
	type RunDetailResponse,
	type TraceDetailResponse,
	type TraceRow,
	type TranscriptEntry,
} from "../../wire";
import { authedFetch } from "../api";
import { usePolled } from "../hooks/use-polled";
import { useRunsSse } from "../hooks/use-runs-sse";
import { Chip, Progress } from "./ui";

export function RunsPage({ selected }: { selected: string | null }) {
	const runs = useRunsSse();
	const [detail] = usePolled<RunDetailResponse>(selected ? "/api/runs/:name" : null, 2500, {
		params: selected ? { name: selected } : undefined,
	});
	const [trace, setTrace] = useState<string | null>(null);
	const [traceData] = usePolled<TraceDetailResponse>(
		selected && trace ? "/api/runs/:name/traces/:trace" : null,
		2500,
		{ params: selected && trace ? { name: selected, trace } : undefined, query: "?tail=60" },
	);
	const traceRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!traceData) return;
		const el = traceRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [traceData]);
	const cancel = useCallback(async (name: string) => {
		if (confirm(`stop ${name}?`)) await authedFetch("POST", "/api/runs/:name/cancel", { name });
	}, []);
	const resume = useCallback(async (name: string) => {
		if (!confirm(`resume ${name}? completed trials are kept; interrupted, pending, and errored ones re-run`)) return;
		const res = await authedFetch("POST", "/api/runs/:name/resume", { name });
		if (!res.ok) alert((await res.json().catch(() => null))?.error ?? `resume failed (${res.status})`);
	}, []);

	if (!runs) return <div className="p-10 text-zinc-500">loading…</div>;
	return (
		<div className="grid h-[calc(100vh-49px)] grid-cols-[minmax(420px,44%)_1fr]">
			<section className="overflow-auto border-r border-zinc-800">
				<table className="w-full text-sm">
					<thead className="sticky top-0 bg-zinc-900 text-xs text-zinc-500">
						<tr>
							<th className="px-3 py-1.5 text-left">run</th>
							<th className="text-left">status</th>
							<th className="text-left">progress</th>
							<th className="text-left">spend</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{runs.map(r => (
							<tr
								key={r.jobName}
								onClick={() => (location.hash = `#/runs/${encodeURIComponent(r.jobName)}`)}
								className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900 ${r.jobName === selected ? "bg-zinc-900" : ""}`}
							>
								<td className="px-3 py-1.5" title={r.models}>
									{r.jobName}
									<div className="text-[10px] uppercase tracking-wide text-zinc-600">{r.benchmark}</div>
									{(r.note || r.role) && (
										<div className="text-[11px] text-zinc-500">
											{r.role && (
												<span className={r.role === "baseline" ? "text-sky-500" : "text-emerald-500"}>
													{r.role}
												</span>
											)}
											{r.role && r.note ? " · " : ""}
											{r.note}
										</div>
									)}
								</td>
								<td>
									<Chip label={r.status} />
								</td>
								<td>
									<Progress run={r} />
								</td>
								<td>{formatUsd(r.costUsd)}</td>
								<td>
									{r.status === "running" ? (
										<button
											type="button"
											onClick={ev => {
												ev.stopPropagation();
												void cancel(r.jobName);
											}}
											className="rounded border border-zinc-700 px-2 text-xs hover:border-red-500 hover:text-red-400"
										>
											stop
										</button>
									) : (
										r.benchmark === "harbor" &&
										(r.done < r.nTotal || r.error > 0) && (
											<button
												type="button"
												onClick={ev => {
													ev.stopPropagation();
													void resume(r.jobName);
												}}
												className="rounded border border-zinc-700 px-2 text-xs hover:border-emerald-500 hover:text-emerald-400"
											>
												resume
											</button>
										)
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<section className="flex flex-col overflow-hidden">
				{detail ? (
					<>
						<div className="border-b border-zinc-800 px-4 py-2 text-sm">
							<span className="font-semibold">{detail.run.jobName}</span> <Chip label={detail.run.status} />{" "}
							<span className="text-xs text-zinc-500">
								{detail.run.benchmark} · {detail.run.dataset} · {detail.run.models}
								{detail.run.score !== null ? ` · score ${(100 * detail.run.score).toFixed(1)}%` : ""}
								{detail.run.prewalk ? ` → ${detail.run.prewalk}` : ""}
							</span>
							<div className="mt-1 flex gap-3 text-xs text-zinc-400">
								{Object.entries(detail.run.metrics).map(([key, value]) => (
									<span key={key}>
										{key.replaceAll("_", " ")}:{" "}
										{value === null || value === undefined ? "—" : `${(100 * value).toFixed(1)}%`}
									</span>
								))}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-auto">
							<table className="w-full text-sm">
								<tbody>
									{detail.traces.map((t: TraceRow) => (
										<tr
											key={t.name}
											onClick={() => setTrace(t.name)}
											className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900 ${t.name === trace ? "bg-zinc-900" : ""}`}
										>
											<td className="px-4 py-1">{t.task}</td>
											<td>
												<Chip label={t.status} />
											</td>
											<td>{t.reward === null ? "—" : t.reward.toFixed(3)}</td>
											<td>{formatUsd(t.costUsd)}</td>
											<td>{t.durationMs ? formatMinutes(t.durationMs) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{trace && (
							<div ref={traceRef} className="h-2/5 overflow-auto border-t border-zinc-800 bg-zinc-950/60">
								{(traceData?.entries ?? []).map((e: TranscriptEntry, i: number) => (
									// Index key: a tail window whose entries carry no ids.
									<div key={i} className="border-b border-zinc-900 px-4 py-2">
										<div className="text-xs text-zinc-500">
											{e.kind === "assistant" ? (e.model ?? "assistant") : (e.tool ?? e.kind)}
											{e.isError ? " · error" : ""}
										</div>
										{e.text && (
											<pre
												className={`whitespace-pre-wrap text-xs ${e.kind === "toolResult" ? "text-zinc-500" : ""} ${e.isError ? "text-red-400" : ""}`}
											>
												{e.text}
											</pre>
										)}
										{e.tools && e.tools.length > 0 && (
											<div className="text-xs text-sky-400">→ {e.tools.join(", ")}</div>
										)}
									</div>
								))}
							</div>
						)}
					</>
				) : (
					<div className="p-10 text-zinc-500">select a run</div>
				)}
			</section>
		</div>
	);
}
