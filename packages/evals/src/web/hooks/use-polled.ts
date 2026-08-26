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
): [T | null, () => void] {
	const [data, setData] = useState<T | null>(null);
	const [nonce, setNonce] = useState(0);
	const paramsKey = JSON.stringify(options?.params);
	const query = options?.query;

	useEffect(() => {
		void nonce; // manual refresh dependency
		if (!template) return;
		let live = true;
		const parsedParams = paramsKey ? (JSON.parse(paramsKey) as Record<string, string>) : undefined;
		const load = () =>
			getJson<T>(template, parsedParams, query)
				.then(d => live && setData(d))
				.catch(() => {});
		load();
		const timer = setInterval(load, intervalMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [template, intervalMs, nonce, paramsKey, query]);

	const refresh = useCallback(() => setNonce(n => n + 1), []);
	return [data, refresh];
}
