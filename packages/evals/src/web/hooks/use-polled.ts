import { errorMessage } from "@veyyon/utils/type-guards";
import { useCallback, useEffect, useState } from "react";
import { getJson } from "../api";

export interface PolledOptions {
	params?: Record<string, string>;
	query?: string;
}

/**
 * Poll a JSON endpoint on an interval (SSE covers the run list; details poll).
 * Returns the latest payload plus a manual refresh for after mutations.
 */
export function usePolled<T>(
	template: string | null,
	intervalMs: number,
	options?: PolledOptions,
): [T | null, () => void, string | null] {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const paramsKey = JSON.stringify(options?.params);
	const query = options?.query;

	useEffect(() => {
		void nonce; // manual refresh dependency
		if (!template) return;
		let live = true;
		const parsedParams = paramsKey ? (JSON.parse(paramsKey) as Record<string, string>) : undefined;
		// A swallowed failure left the last good payload on screen for as long as the manager stayed
		// down, so a dead pane read as a live one.
		const load = () =>
			getJson<T>(template, parsedParams, query)
				.then(d => {
					if (!live) return;
					setData(d);
					setError(null);
				})
				.catch((reason: unknown) => {
					if (live) setError(errorMessage(reason));
				});
		load();
		const timer = setInterval(load, intervalMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [template, intervalMs, nonce, paramsKey, query]);

	const refresh = useCallback(() => setNonce(n => n + 1), []);
	return [data, refresh, error];
}
