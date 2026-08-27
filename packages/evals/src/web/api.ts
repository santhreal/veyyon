import type { ApiErrorResponse, ApiTokenResponse, ExperimentMetaUpdate, HttpMethod } from "../wire";
import { resolveRoute } from "./routes";

let cachedAuthToken = "";

function reason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * How long the dashboard waits for the manager before it reports it as unreachable.
 *
 * Every request here was unbounded. A manager wedged on a locked SQLite file, or a laptop that slept
 * through a run, left the page waiting on a promise that never settled: no rows, no error, a spinner
 * that stayed. The poll behind it never fired again either, because it waits for the request it
 * started.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One request, bounded, with the timeout named in the failure. A caller's own signal still cancels:
 * whichever fires first ends the request, and only the bound produces the timeout message.
 */
export async function fetchWithin(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
	const bound = AbortSignal.timeout(timeoutMs);
	const signal = init?.signal ? AbortSignal.any([init.signal, bound]) : bound;
	try {
		return await fetch(url, { ...init, signal });
	} catch (err) {
		if (bound.aborted) {
			const bounds = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
			throw new Error(`the manager did not answer ${url} within ${bounds}`);
		}
		throw err;
	}
}

/**
 * The session token every mutating request carries.
 *
 * A failure here used to be swallowed and the request sent with no token, which the manager rejects
 * with 401 — so a launch reported an authentication error as its own failure and a cancel reported
 * nothing at all. The reason the token could not be obtained is stated instead.
 */
export async function getAuthToken(): Promise<string> {
	if (cachedAuthToken) return cachedAuthToken;
	let res: Response;
	try {
		res = await fetchWithin(resolveRoute("GET", "/api/token"));
	} catch (err) {
		throw new Error(`the manager did not answer a request for a session token: ${reason(err)}`);
	}
	if (!res.ok) throw new Error(`the manager refused to issue a session token (${res.status})`);
	let data: ApiTokenResponse;
	try {
		data = (await res.json()) as ApiTokenResponse;
	} catch (err) {
		throw new Error(`the manager's session token could not be read: ${reason(err)}`);
	}
	if (!data.token) throw new Error("the manager issued an empty session token");
	cachedAuthToken = data.token;
	return cachedAuthToken;
}

/**
 * Drop the cached session token.
 *
 * The manager mints a new one when it restarts, so a token this page cached before the restart is
 * rejected by every later request. Holding it left every action failing with 401 until the page was
 * reloaded by hand.
 */
export function forgetAuthToken(): void {
	cachedAuthToken = "";
}

/** What a mutating request did: its parsed body, or the reason it changed nothing. */
export interface MutationOutcome<T> {
	data: T | null;
	error: string | null;
}

/**
 * Send one mutating request and report what it did.
 *
 * Every caller reached for `authedFetch` and then had to decide what an unreadable body, a rejected
 * token or a non-JSON error page meant; one of them dropped the response entirely, so a cancel the
 * manager rejected looked exactly like one it performed. The outcome is decided in one place: the
 * body on success, a stated reason otherwise, and never a throw at the click handler.
 */
export async function mutate<T>(
	method: HttpMethod,
	template: string,
	params?: Record<string, string>,
	init?: Omit<RequestInit, "method">,
): Promise<MutationOutcome<T>> {
	let res: Response;
	try {
		res = await authedFetch(method, template, params, init);
		// A token minted by a manager that has since restarted is rejected. Exactly one retry with a
		// freshly issued token: a second rejection is the manager's answer, not a stale token.
		if (res.status === 401) {
			forgetAuthToken();
			res = await authedFetch(method, template, params, init);
		}
	} catch (err) {
		return { data: null, error: reason(err) };
	}
	const body = (await res.json().catch(() => null)) as (T & Partial<ApiErrorResponse>) | null;
	if (!res.ok) return { data: null, error: body?.error ?? `${template}: the manager answered ${res.status}` };
	if (body === null) return { data: null, error: `${template}: the manager's answer could not be read` };
	return { data: body, error: null };
}

export async function authedFetch(
	method: HttpMethod,
	template: string,
	params?: Record<string, string>,
	init?: Omit<RequestInit, "method">,
): Promise<Response> {
	const url = resolveRoute(method, template, params);
	if (method === "GET") {
		return fetchWithin(url, { ...init, method });
	}
	const token = await getAuthToken();
	const headers = new Headers(init?.headers);
	if (token && !headers.has("x-evals-token") && !headers.has("authorization")) {
		headers.set("x-evals-token", token);
	}
	return fetchWithin(url, { ...init, method, headers });
}

export async function getJson<T>(template: string, params?: Record<string, string>, query?: string): Promise<T> {
	let url = resolveRoute("GET", template, params);
	if (query) url += query;
	const res = await fetchWithin(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return (await res.json()) as T;
}

/** PUT experiment metadata: goal and/or per-run label/note/role. */
export async function putExperimentMeta(id: string, body: ExperimentMetaUpdate): Promise<void> {
	const res = await authedFetch(
		"PUT",
		"/api/experiments/:id",
		{ id },
		{
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	if (!res.ok) {
		const out = (await res.json().catch(() => null)) as ApiErrorResponse | null;
		throw new Error(out?.error ?? `save failed (${res.status})`);
	}
}
