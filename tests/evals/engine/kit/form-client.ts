/**
 * A client that drives a kit site over plain HTTP, the way its own pages do: form posts, cookies,
 * redirects. A task's scripted solution uses it to prove the task can be completed and that its
 * checks pass when it is, without a browser.
 */

export interface FormResponse {
	readonly status: number;
	/** The URL the response came from, after redirects. */
	readonly url: string;
	readonly body: string;
}

const MAX_REDIRECTS = 10;

export class FormClient {
	readonly #origin: string;
	readonly #cookies = new Map<string, string>();

	constructor(origin: string) {
		this.#origin = origin;
	}

	get(pathname: string): Promise<FormResponse> {
		return this.#request("GET", pathname, undefined);
	}

	/** Post urlencoded fields; a field given an array is repeated, as checkboxes are. */
	post(pathname: string, fields: Readonly<Record<string, string | readonly string[]>> = {}): Promise<FormResponse> {
		const body = new URLSearchParams();
		for (const [name, value] of Object.entries(fields)) {
			for (const item of typeof value === "string" ? [value] : value) body.append(name, item);
		}
		return this.#request("POST", pathname, body.toString(), "application/x-www-form-urlencoded");
	}

	postJson(pathname: string, value: unknown): Promise<FormResponse> {
		return this.#request("POST", pathname, JSON.stringify(value), "application/json");
	}

	async #request(method: string, pathname: string, body: string | undefined, type?: string): Promise<FormResponse> {
		let url = new URL(pathname, this.#origin).toString();
		let currentMethod = method;
		let currentBody = body;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const headers: Record<string, string> = {};
			if (this.#cookies.size > 0) {
				headers.cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
			}
			if (currentBody !== undefined && type) headers["content-type"] = type;
			const response = await fetch(url, { method: currentMethod, headers, body: currentBody, redirect: "manual" });
			for (const cookie of response.headers.getSetCookie()) {
				const [pair] = cookie.split(";");
				const eq = pair?.indexOf("=") ?? -1;
				if (pair && eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
			}
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				await response.arrayBuffer();
				url = new URL(location, url).toString();
				// A 303, and a 301 or 302 after a post, turns the next request into a GET.
				if (response.status !== 307 && response.status !== 308) {
					currentMethod = "GET";
					currentBody = undefined;
				}
				continue;
			}
			return { status: response.status, url, body: await response.text() };
		}
		throw new Error(`${method} ${pathname}: more than ${MAX_REDIRECTS} redirects`);
	}
}
