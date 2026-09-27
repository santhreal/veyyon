import { ensureChromiumExecutable, loadPuppeteer } from "@veyyon/coding-agent/tools/web/browser/launch";

/** A Chromium a test launched itself, with its DevTools endpoint open, for the browser tool to reach as `app.cdp_url`. */
export interface DebuggableChromium {
	/** The HTTP discovery endpoint `app.cdp_url` takes. */
	readonly cdpUrl: string;
	close(): Promise<void>;
}

/**
 * Launch a headless Chromium the browser tool does not own, so a tab opened on it with `app.cdp_url` is a
 * connected browser's tab: its page is the browser's own and its profile is not the tool's.
 */
export async function launchDebuggableChromium(): Promise<DebuggableChromium> {
	const puppeteer = await loadPuppeteer();
	const browser = await puppeteer.launch({
		executablePath: await ensureChromiumExecutable(),
		headless: true,
		args: ["--no-sandbox"],
	});
	const { port } = new URL(browser.wsEndpoint());
	return { cdpUrl: `http://127.0.0.1:${port}`, close: () => browser.close() };
}
