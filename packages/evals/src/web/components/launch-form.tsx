import { useCallback, useState } from "react";
import type { BenchmarkKind, LaunchRequest, LaunchResponse, RunRole } from "../../wire";
import { mutate } from "../api";
import { INPUT_CLASS } from "./ui";

export function LaunchForm({ onDone }: { onDone: () => void }) {
	const [msg, setMsg] = useState("");
	const submit = useCallback(
		async (ev: React.FormEvent<HTMLFormElement>) => {
			ev.preventDefault();
			const f = new FormData(ev.currentTarget);
			const body: LaunchRequest = {
				benchmark: (f.get("benchmark") as BenchmarkKind) || undefined,
				model: String(f.get("model") ?? ""),
			};
			if (f.get("jobName")) body.jobName = String(f.get("jobName"));
			if (f.get("dataset")) body.dataset = String(f.get("dataset"));
			if (f.get("tasks")) body.tasks = Number(f.get("tasks"));
			if (f.get("concurrency")) body.concurrency = Number(f.get("concurrency"));
			if (f.get("timeoutMultiplier")) body.timeoutMultiplier = Number(f.get("timeoutMultiplier"));
			if (f.get("include")) {
				body.include = String(f.get("include"))
					.split(",")
					.map(s => s.trim())
					.filter(Boolean);
			}
			if (f.get("goal")) body.goal = String(f.get("goal"));
			if (f.get("role")) body.role = String(f.get("role")) as RunRole;
			if (f.get("note")) body.note = String(f.get("note"));
			if (f.get("prewalkInto") || f.get("prewalk")) {
				body.prewalk = f.get("prewalkInto") ? { into: String(f.get("prewalkInto")) } : {};
			}
			setMsg("launching…");
			const out = await mutate<LaunchResponse>("POST", "/api/runs", undefined, {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			setMsg(out.error ? `error: ${out.error}` : `launched ${out.data?.jobName}`);
			if (!out.error) setTimeout(onDone, 800);
		},
		[onDone],
	);
	const input = INPUT_CLASS;
	return (
		<form onSubmit={submit} className="grid grid-cols-4 gap-2 border-b border-zinc-800 bg-zinc-900/70 p-4 text-sm">
			<select name="benchmark" className={input}>
				<option value="harbor">Harbor</option>
				<option value="edit">TypeScript edit</option>
				<option value="deepswe">DeepSWE arms</option>
			</select>
			<input name="model" placeholder="model (required)" required className={input} />
			<input name="dataset" placeholder="dataset (terminal-bench@2.0)" className={input} />
			<input name="jobName" placeholder="job name (exp-arm)" className={input} />
			<input name="tasks" type="number" placeholder="task/passages limit" className={input} />
			<input name="concurrency" type="number" placeholder="concurrency" className={input} />
			<input name="timeoutMultiplier" type="number" step="0.5" placeholder="timeout ×" className={input} />
			<input name="prewalkInto" placeholder="prewalk into (model)" className={input} />
			<label className="flex items-center gap-2 text-xs text-zinc-400">
				<input type="checkbox" name="prewalk" /> prewalk (default smol)
			</label>
			<input name="include" placeholder="include tasks, comma-sep" className={`${input} col-span-2`} />
			<input
				name="goal"
				placeholder="experiment goal (what question does this answer?)"
				className={`${input} col-span-2`}
			/>
			<select name="role" className={input}>
				<option value="">role: unset</option>
				<option value="baseline">baseline</option>
				<option value="variant">variant</option>
			</select>
			<input name="note" placeholder="arm note (e.g. prewalk flash)" className={input} />
			<div className="col-span-4 flex items-center gap-3">
				<button type="submit" className="rounded border border-zinc-600 px-3 py-1 hover:border-sky-400">
					launch
				</button>
				<span className="text-xs text-zinc-500">{msg}</span>
			</div>
		</form>
	);
}
