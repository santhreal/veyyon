import type { ApiErrorResponse, ApiTokenResponse, ExperimentMetaUpdate, HttpMethod } from "../wire";
import { resolveRoute } from "./routes";

let cachedAuthToken = "";

export async function getAuthToken(): Promise<string> {
	if (cachedAuthToken) return cachedAuthToken;
	try {
		const res = await fetch(resolveRoute("GET", "/api/token"));
		if (res.ok) {
			const data = (await res.json()) as ApiTokenResponse;
			if (data.token) cachedAuthToken = data.token;
		}
	} catch {}
	return cachedAuthToken;
}

export async function authedFetch(
	method: HttpMethod,
	template: string,
	params?: Record<string, string>,
	init?: Omit<RequestInit, "method">,
): Promise<Response> {
	const url = resolveRoute(method, template, params);
	if (method === "GET") {
		return fetch(url, { ...init, method });
	}
	const token = await getAuthToken();
	const headers = new Headers(init?.headers);
	if (token && !headers.has("x-evals-token") && !headers.has("authorization")) {
		headers.set("x-evals-token", token);
	}
	return fetch(url, { ...init, method, headers });
}

export async function getJson<T>(template: string, params?: Record<string, string>, query?: string): Promise<T> {
	let url = resolveRoute("GET", template, params);
	if (query) url += query;
	const res = await fetch(url);
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
