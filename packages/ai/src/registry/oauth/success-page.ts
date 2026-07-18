/**
 * Shared OAuth result page (`oauth.html`).
 *
 * ONE owner for turning the browser-facing success/error page into a served
 * response. Two consumers:
 *
 * - {@link OAuthCallbackFlow} renders it inline on the loopback `/callback`
 *   route (the provider redirect lands there directly).
 * - Device-code / paste flows never receive a browser redirect, so after the
 *   token lands they call {@link serveOAuthSuccessPage} to bring up the SAME
 *   page on an ephemeral loopback server and hand the URL to the UI to open —
 *   so every provider ends on the branded "Signed in to Veyyon" page, not on
 *   the provider's own screen.
 */

import { errorMessage } from "@veyyon/utils";
import templateHtml from "./oauth.html" with { type: "text" };

/**
 * Minimal controller surface {@link emitOAuthSuccessPage} needs. Both
 * `OAuthController` and provider-specific login-option shapes (e.g. GitHub
 * Copilot's) satisfy this structurally, so the helper stays decoupled from any
 * one controller type.
 */
export interface OAuthSuccessPageSink {
	onSuccessPage?(url: string): void;
	onProgress?(message: string): void;
}

/** State shape the page's inline script reads from the embedded JSON block. */
export type OAuthResultState = { ok: true; code?: string; state?: string } | { ok?: false; error?: string };

/** Substitute the result state into the page template. */
export function renderOAuthResultHtml(state: OAuthResultState): string {
	return (templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(state));
}

/** Handle for an ephemeral success-page server. */
export interface OAuthSuccessPageServer {
	/** Loopback URL the UI should open in the browser. */
	url: string;
	/** Stop the server. Safe to call more than once. */
	stop(): void;
}

/**
 * Serve the branded success (or error) page on a short-lived loopback server
 * and return its URL. The page auto-closes its own tab after a few seconds; the
 * server lingers a little longer so a manual refresh still resolves, then stops
 * itself. Callers may `stop()` early.
 *
 * Any path is served the page, so a stray favicon or reload never 404s while the
 * user is looking at it.
 */
export function serveOAuthSuccessPage(
	state: OAuthResultState = { ok: true },
	lingerMs = 20_000,
): OAuthSuccessPageServer {
	const html = renderOAuthResultHtml(state);
	const status = state.ok ? 200 : 500;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		reusePort: false,
		fetch: () => new Response(html, { status, headers: { "Content-Type": "text/html" } }),
	});
	const port = server.port;
	let stopped = false;
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
		server.stop();
	};
	const timer = setTimeout(stop, lingerMs);
	// Do not keep the process alive solely for the linger timer.
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref: () => void }).unref();
	}
	return { url: `http://127.0.0.1:${port}/`, stop };
}

/**
 * Bring up the branded success page for a flow that got no browser redirect and
 * hand its URL to the UI to open. A no-op when the controller does not accept a
 * success page (non-interactive surfaces) — no server is bound in that case.
 *
 * Serving the page must never fail an already-successful login: if the loopback
 * server cannot bind, report it through {@link OAuthController.onProgress} (loud,
 * not swallowed) and return, leaving the terminal-side "logged in" result intact.
 */
export function emitOAuthSuccessPage(ctrl: OAuthSuccessPageSink): void {
	if (!ctrl.onSuccessPage) return;
	try {
		const { url } = serveOAuthSuccessPage({ ok: true });
		ctrl.onSuccessPage(url);
	} catch (error) {
		ctrl.onProgress?.(`Signed in — could not open the local success page: ${errorMessage(error)}`);
	}
}
