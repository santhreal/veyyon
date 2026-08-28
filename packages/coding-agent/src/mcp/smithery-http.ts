import { withTimeoutSignal } from "../utils/fetch-timeout";

/** How long any single Smithery HTTP request may take. One value for the three entrypoints that talk to Smithery, because they are one */
export const SMITHERY_HTTP_TIMEOUT_MS = 10_000;

/** An abort signal that fires at the Smithery deadline, optionally combined with the caller's own. */
export function smitheryTimeoutSignal(signal?: AbortSignal): AbortSignal {
	return withTimeoutSignal(SMITHERY_HTTP_TIMEOUT_MS, signal);
}
