import { useEffect, useState } from "react";
import type { RunRow } from "../../wire";
import { resolveRoute } from "../routes";

type GlobalEventSourceEnv = typeof globalThis & {
	EventSource?: new (url: string) => {
		onmessage: ((ev: { data: string }) => void) | null;
		close: () => void;
	};
};

export function useRunsSse(): RunRow[] | null {
	const [runs, setRuns] = useState<RunRow[] | null>(null);
	useEffect(() => {
		const EventSourceClass = (globalThis as GlobalEventSourceEnv).EventSource;
		if (!EventSourceClass) return;
		const es = new EventSourceClass(resolveRoute("GET", "/api/events"));
		es.onmessage = ev => {
			try {
				setRuns(JSON.parse(ev.data) as RunRow[]);
			} catch {
				// Malformed payloads must not throw or tear down the subscription
			}
		};
		return () => es.close();
	}, []);
	return runs;
}
