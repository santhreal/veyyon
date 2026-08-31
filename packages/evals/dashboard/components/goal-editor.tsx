import { errorMessage } from "@veyyon/utils/type-guards";
import { useState } from "react";
import { putExperimentMeta } from "../api";
import { INPUT_CLASS } from "./ui";

/** Inline editor for the experiment's goal/description. */
export function GoalEditor({ id, goal, onSaved }: { id: string; goal: string; onSaved: () => void }) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	if (!editing) {
		return (
			<div className="group mb-4 flex max-w-4xl items-start gap-2">
				<p className={`text-sm ${goal ? "text-zinc-400" : "text-zinc-600"}`}>{goal || "no description"}</p>
				<button
					type="button"
					onClick={() => setEditing(true)}
					aria-label="edit experiment description"
					title="edit description"
					className="rounded px-1 text-xs text-zinc-600 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
				>
					✎
				</button>
			</div>
		);
	}
	const save = async (form: HTMLFormElement) => {
		const f = new FormData(form);
		setBusy(true);
		setErr("");
		try {
			await putExperimentMeta(id, { goal: String(f.get("goal") ?? "").trim() });
			onSaved();
			setEditing(false);
		} catch (e) {
			setErr(errorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="mb-4 max-w-4xl"
			onSubmit={ev => {
				ev.preventDefault();
				void save(ev.currentTarget);
			}}
			onKeyDown={ev => {
				if (ev.key === "Escape") setEditing(false);
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
					ev.preventDefault();
					void save(ev.currentTarget);
				}
			}}
		>
			<textarea
				name="goal"
				defaultValue={goal}
				rows={3}
				autoFocus
				placeholder="what question does this experiment answer?…"
				className={`${INPUT_CLASS} w-full`}
			/>
			<div className="mt-1 flex items-center gap-2 text-xs">
				<button
					type="submit"
					disabled={busy}
					className="rounded border border-zinc-600 px-2 py-0.5 hover:border-sky-400"
				>
					{busy ? "saving…" : "save"}
				</button>
				<button
					type="button"
					onClick={() => setEditing(false)}
					className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:border-zinc-500"
				>
					cancel
				</button>
				<span className="text-zinc-600">⌘↵ save · esc cancel</span>
				{err && <span className="text-red-400">{err}</span>}
			</div>
		</form>
	);
}
