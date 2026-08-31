import { useCallback, useState } from "react";
import type { AddArmRequest, LaunchResponse, RunRole } from "../../engine/store-shapes";
import { mutate } from "../api";
import { INPUT_CLASS } from "./ui";

/**
 * Launch a new arm into an existing experiment. The server inherits the
 * experiment's dataset and exact task sample from a sibling arm, so only the
 * arm-specific knobs (name, model, role, note, optional prewalk) are collected here.
 */
export function AddArmForm({ experimentId, onDone }: { experimentId: string; onDone: () => void }) {
	const [msg, setMsg] = useState("");
	const submit = useCallback(
		async (ev: React.FormEvent<HTMLFormElement>) => {
			ev.preventDefault();
			const f = new FormData(ev.currentTarget);
			const body: AddArmRequest = { arm: String(f.get("arm") ?? ""), model: String(f.get("model") ?? "") };
			const role = f.get("role");
			if (role) body.role = String(role) as RunRole;
			const note = f.get("note");
			if (note) body.note = String(note);
			if (f.get("prewalkInto") || f.get("prewalk")) {
				body.prewalk = f.get("prewalkInto") ? { into: String(f.get("prewalkInto")) } : {};
			}
			setMsg("launching…");
			const out = await mutate<LaunchResponse>(
				"POST",
				"/api/experiments/:id/arms",
				{ id: experimentId },
				{
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			setMsg(out.error ? `error: ${out.error}` : `launched ${out.data?.jobName}`);
			if (!out.error) setTimeout(onDone, 900);
		},
		[experimentId, onDone],
	);
	return (
		<form
			onSubmit={submit}
			className="mb-4 grid grid-cols-4 gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm"
		>
			<input name="arm" placeholder="arm name (e.g. opus48)" required className={INPUT_CLASS} />
			<input name="model" placeholder="model (provider/model)" required className={INPUT_CLASS} />
			<select name="role" className={INPUT_CLASS} defaultValue="">
				<option value="">role: unset</option>
				<option value="baseline">baseline</option>
				<option value="variant">variant</option>
			</select>
			<input name="note" placeholder="note (what this arm tests)" className={INPUT_CLASS} />
			<input name="prewalkInto" placeholder="prewalk into (model, optional)" className={INPUT_CLASS} />
			<label className="flex items-center gap-1 text-xs text-zinc-400">
				<input type="checkbox" name="prewalk" /> prewalk (default smol)
			</label>
			<div className="col-span-4 flex items-center gap-3">
				<button type="submit" className="rounded border border-zinc-600 px-3 py-1 hover:border-sky-400">
					launch arm
				</button>
				<span className="text-xs text-zinc-500">inherits dataset + task sample from existing arms · {msg}</span>
			</div>
		</form>
	);
}
