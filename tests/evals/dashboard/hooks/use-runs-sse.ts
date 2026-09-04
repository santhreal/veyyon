import { useEffect, useState } from "react";
import type { RunRow } from "../../engine/store-shapes";
import { resolveRoute } from "../routes";

type EventSourceLike = {
	onmessage: ((ev: { data: string }) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	close: () => void;
};

type GlobalEventSourceEnv = typeof globalThis & {
	EventSource?: new (url: string) => EventSourceLike;
};

export interface RunsSubscription {
	/** The last payload the stream delivered, or null before the first one arrives. */
	runs: RunRow[] | null;
	/** What went wrong with the stream, so a stale table is not read as a live one. */
	error: string | null;
}

/** A payload that is not a list of runs is not a run list, whatever it parses to. */
function asRunRows(parsed: unknown): RunRow[] | null {
	if (!Array.isArray(parsed)) return null;
	for (const row of parsed) {
		if (typeof row !== "object" || row === null) return null;
		if (typeof (row as RunRow).jobName !== "string") return null;
	}
	return parsed as RunRow[];
}

export function useRunsSse(): RunsSubscription {
	const [runs, setRuns] = useState<RunRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const EventSourceClass = (globalThis as GlobalEventSourceEnv).EventSource;
		if (!EventSourceClass) {
			setError("this browser delivers no server-sent events, so the run list cannot update");
			return;
		}
		const es = new EventSourceClass(resolveRoute("GET", "/api/events"));
		es.onmessage = ev => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(ev.data);
			} catch {
				// A malformed frame is one frame, not the end of the subscription.
				setError("the manager sent a frame this page could not read");
				return;
			}
			const rows = asRunRows(parsed);
			if (!rows) {
				// Rendering a cast of whatever arrived used to blank the page on the first `.map`.
				setError("the manager sent something other than a run list");
				return;
			}
			setError(null);
			setRuns(rows);
		};
		es.onerror = () => {
			setError("the connection to the manager dropped; this list is the last update it sent");
		};
		return () => es.close();
	}, []);
	return { runs, error };
}
