/**
 * Shared OAuth success page.
 *
 * The branded "Signed in to Veyyon" page must render for BOTH the callback
 * (inline) and device-code (ephemeral server) paths, and device-code flows must
 * only emit it when the controller can open it.
 */
import { describe, expect, test } from "bun:test";
import { emitOAuthSuccessPage, renderOAuthResultHtml, serveOAuthSuccessPage } from "../success-page";

describe("renderOAuthResultHtml", () => {
	test("embeds the success state and leaves no template placeholder", () => {
		const html = renderOAuthResultHtml({ ok: true });
		expect(html).not.toContain("__OAUTH_STATE__");
		expect(html).toContain('"ok":true');
		expect(html).toContain("Veyyon");
		// The sun canvas is the shared visual identity with the website.
		expect(html).toContain('id="sun"');
	});

	test("embeds an error state for the failure page", () => {
		const html = renderOAuthResultHtml({ ok: false, error: "State mismatch" });
		expect(html).toContain('"ok":false');
		expect(html).toContain("State mismatch");
	});
});

describe("serveOAuthSuccessPage", () => {
	test("serves the branded page on a loopback port and stops cleanly", async () => {
		const page = serveOAuthSuccessPage({ ok: true });
		try {
			expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
			const res = await fetch(page.url);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const body = await res.text();
			expect(body).toContain("Signed in");
			expect(body).toContain('"ok":true');
			// Any path resolves to the page so a stray favicon/reload never 404s.
			const favicon = await fetch(new URL("/favicon.ico", page.url));
			expect(favicon.status).toBe(200);
		} finally {
			page.stop();
		}
	});

	test("stop is idempotent", () => {
		const page = serveOAuthSuccessPage({ ok: true });
		page.stop();
		expect(() => page.stop()).not.toThrow();
	});
});

describe("emitOAuthSuccessPage", () => {
	test("opens a page and hands the loopback URL to the controller", async () => {
		let opened: string | undefined;
		emitOAuthSuccessPage({ onSuccessPage: url => (opened = url) });
		expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		const res = await fetch(opened as string);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Signed in");
	});

	test("is a no-op (binds no server) when the controller cannot open a page", () => {
		// No onSuccessPage → nothing served, nothing thrown. A non-interactive
		// controller must not pop a browser page.
		expect(() => emitOAuthSuccessPage({})).not.toThrow();
		expect(() => emitOAuthSuccessPage({ onProgress: () => {} })).not.toThrow();
	});
});
