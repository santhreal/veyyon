import { errorMessage } from "@veyyon/utils";
import { useState } from "react";
import type { ArmSummary, RunRole } from "../../wire";
import { putExperimentMeta } from "../api";
import { INPUT_CLASS } from "./ui";

/** Full-width row editor for one arm's display name, role, and description. */
export function ArmEditorRow({
	arm,
	experimentId,
	onSaved,
	onCancel,
}: {
	arm: ArmSummary;
	experimentId: string;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const save = async (form: HTMLFormElement) => {
		const f = new FormData(form);
		setBusy(true);
		setErr("");
		try {
			await putExperimentMeta(experimentId, {
				runs: {
					[arm.run.jobName]: {
						label: String(f.get("label") ?? "").trim(),
						note: String(f.get("note") ?? "").trim(),
						role: String(f.get("role") ?? "") as RunRole,
					},
				},
			});
			onSaved();
		} catch (e) {
			setErr(errorMessage(e));
			setBusy(false);
		}
	};
	return (
		<tr className="border-t border-zinc-800/70 bg-zinc-900/70">
			<td colSpan={9} className="px-1 py-2">
				<form
					className="flex flex-wrap items-center gap-2 text-sm"
					onSubmit={ev => {
						ev.preventDefault();
						void save(ev.currentTarget);
					}}
					onKeyDown={ev => {
						if (ev.key === "Escape") onCancel();
					}}
				>
					<label className="flex items-center gap-1.5 text-xs text-zinc-500">
						name
						<input
							name="label"
							defaultValue={arm.run.label}
							placeholder={arm.run.jobName.slice(arm.run.jobName.indexOf("-") + 1)}
							autoFocus
							spellCheck={false}
							className={`${INPUT_CLASS} w-44`}
						/>
					</label>
					<label className="flex items-center gap-1.5 text-xs text-zinc-500">
						role
						<select name="role" defaultValue={arm.run.role} className={INPUT_CLASS}>
							<option value="">unset</option>
							<option value="baseline">baseline</option>
							<option value="variant">variant</option>
						</select>
					</label>
					<label className="flex min-w-64 flex-1 items-center gap-1.5 text-xs text-zinc-500">
						description
						<input
							name="note"
							defaultValue={arm.run.note}
							placeholder="what does this arm test?…"
							className={`${INPUT_CLASS} w-full`}
						/>
					</label>
					<button
						type="submit"
						disabled={busy}
						className="rounded border border-zinc-600 px-2 py-1 text-xs hover:border-sky-400"
					>
						{busy ? "saving…" : "save"}
					</button>
					<button
						type="button"
						onClick={onCancel}
						className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-500"
					>
						cancel
					</button>
					<span className="w-full text-[10px] text-zinc-600">
						display name only — job dir stays <span className="text-zinc-500">{arm.run.jobName}</span>
						{err && <span className="ml-2 text-red-400">{err}</span>}
					</span>
				</form>
			</td>
		</tr>
	);
}
