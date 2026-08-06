/**
 * Shared OAuth success page.
 *
 * The branded "Signed in to Veyyon" page must render for BOTH the callback
 * (inline) and device-code (ephemeral server) paths, and device-code flows must
 * only emit it when the controller can open it.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { emitOAuthSuccessPage, renderOAuthResultHtml, serveOAuthSuccessPage } from "../success-page";

afterEach(() => {
	vi.restoreAllMocks();
});

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

	test("stop closes the server and is safe to call twice", async () => {
		const page = serveOAuthSuccessPage({ ok: true });
		page.stop();
		page.stop();
		// Idempotence only matters because the first stop really released the
		// port; a stop that left the loopback server listening would leak one
		// per device-code login.
		await expect(fetch(page.url)).rejects.toBeDefined();
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

	test("binds no server when the controller cannot open a page", () => {
		// No onSuccessPage → a non-interactive controller must not pop a browser
		// page, which means not binding a loopback port either.
		const serve = vi.spyOn(Bun, "serve");
		emitOAuthSuccessPage({});
		emitOAuthSuccessPage({ onProgress: () => {} });
		expect(serve).not.toHaveBeenCalled();
	});
});
