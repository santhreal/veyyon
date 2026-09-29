/**
 * WHY: a kit site is the whole world of a trial, and a request it never answers, or answers with an
 * error it did not mean, fails the trial for a reason no agent caused. Four ways it did:
 *
 * - A cookie value that is no URI encoding (a page's own `document.cookie = "note=50%"`) failed the
 *   cookie parse, and with it every request. Every site on 127.0.0.1 shares the browser's cookies,
 *   so one such cookie broke every site of the trial for the rest of it.
 * - A response Node refuses (a header holding a line break or a character outside Latin-1, a cookie
 *   value no URI encoding holds) threw after the handler returned: the request stayed open until the
 *   browser gave up, and the rejection went unhandled.
 * - `FormClient` kept a cookie the site deleted with `Max-Age=0`, so a scripted solution that signed
 *   out went on as the user it had signed out.
 * - `formFields` took a field named like an `Object` member (`toString`, `constructor`) for one
 *   already posted and prefixed the member's source to its value, and dropped a `__proto__` field.
 *
 * Every request here carries a deadline, so a request left open fails the test instead of hanging it.
 *
 * Not caught: a handler that never settles its own promise, which the site cannot answer for; and
 * the last resort of closing the connection when even the 500 cannot be written, which no response
 * here reaches.
 */
import { describe, expect, it } from "bun:test";
import { FormClient } from "../../engine/kit/form-client";
import {
	formFields,
	type HostedSite,
	hostSite,
	json,
	type SiteHandler,
	type SiteResponse,
	text,
} from "../../engine/kit/web-host";

const DEADLINE_MS = 5_000;

async function withSite(handler: SiteHandler, use: (site: HostedSite) => Promise<void>): Promise<void> {
	const site = await hostSite(handler);
	try {
		await use(site);
	} finally {
		await site.close();
	}
}

describe("a kit site", () => {
	it("reads a cookie it did not encode as it was sent, beside its own", async () => {
		await withSite(
			request => json(request.cookies),
			async site => {
				const response = await fetch(`${site.origin}/`, {
					headers: { cookie: "note=50%; session=a%20b" },
					signal: AbortSignal.timeout(DEADLINE_MS),
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ note: "50%", session: "a b" });
			},
		);
	});

	it("reads every posted field by its own name, whatever the name", async () => {
		await withSite(
			request => json(Object.entries(formFields(request))),
			async site => {
				const response = await fetch(`${site.origin}/`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "toString=a&constructor=b&__proto__=c&tag=x&tag=y",
					signal: AbortSignal.timeout(DEADLINE_MS),
				});
				expect(await response.json()).toEqual([
					["toString", "a"],
					["constructor", "b"],
					["__proto__", "c"],
					["tag", "x,y"],
				]);
			},
		);
	});

	it("answers a response Node refuses with a server error, and goes on serving", async () => {
		const refused: Record<string, () => SiteResponse> = {
			"/line-break": () => text("x", { headers: { "x-note": "a\nb" } }),
			"/outside-latin-1": () => text("x", { status: 303, headers: { location: "/search?q=東京" } }),
			"/lone-surrogate-cookie": () => text("x", { cookies: [{ name: "draft", value: "\uD800" }] }),
		};
		await withSite(
			request => refused[request.url.pathname]?.() ?? text("served"),
			async site => {
				const statuses: Record<string, number> = {};
				for (const pathname of Object.keys(refused)) {
					const response = await fetch(`${site.origin}${pathname}`, {
						redirect: "manual",
						signal: AbortSignal.timeout(DEADLINE_MS),
					});
					await response.arrayBuffer();
					statuses[pathname] = response.status;
				}
				expect(statuses).toEqual({ "/line-break": 500, "/outside-latin-1": 500, "/lone-surrogate-cookie": 500 });
				const after = await fetch(`${site.origin}/`, { signal: AbortSignal.timeout(DEADLINE_MS) });
				expect([after.status, await after.text()]).toEqual([200, "served"]);
			},
		);
	});
});

describe("a form client", () => {
	it("stops sending a cookie the site deletes", async () => {
		const sent: string[] = [];
		await withSite(
			request => {
				sent.push(request.cookies.session ?? "(none)");
				if (request.url.pathname === "/sign-in") return text("in", { cookies: [{ name: "session", value: "s1" }] });
				if (request.url.pathname === "/sign-out") {
					return text("out", { cookies: [{ name: "session", value: "s1", maxAge: 0 }] });
				}
				return text("page");
			},
			async site => {
				const client = new FormClient(site.origin);
				for (const pathname of ["/sign-in", "/account", "/sign-out", "/account"]) await client.get(pathname);
			},
		);
		expect(sent).toEqual(["(none)", "s1", "s1", "(none)"]);
	});
});
