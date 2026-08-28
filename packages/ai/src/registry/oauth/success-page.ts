import { errorMessage } from "@veyyon/utils/type-guards";
import templateHtml from "./oauth.html" with { type: "text" };

export interface OAuthSuccessPageSink {
	onSuccessPage?(url: string): void;
	onProgress?(message: string): void;
}

export type OAuthResultState = { ok: true; code?: string; state?: string } | { ok?: false; error?: string };

export function renderOAuthResultHtml(state: OAuthResultState): string {
	return (templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(state));
}

export interface OAuthSuccessPageServer {
	url: string;
	stop(): void;
}

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
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref: () => void }).unref();
	}
	return { url: `http://127.0.0.1:${port}/`, stop };
}

export function emitOAuthSuccessPage(ctrl: OAuthSuccessPageSink): void {
	if (!ctrl.onSuccessPage) return;
	try {
		const { url } = serveOAuthSuccessPage({ ok: true });
		ctrl.onSuccessPage(url);
	} catch (error) {
		ctrl.onProgress?.(`Signed in, but could not open the local success page: ${errorMessage(error)}`);
	}
}
