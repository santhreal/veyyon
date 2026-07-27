import type { FetchImpl } from "@veyyon/ai";
import { untilAborted } from "@veyyon/utils";
import type { Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport } from "../../../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../../tools/browser/registry";
import { buildBrowserNavigationHeaders } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

/**
 * How long to wait for a rendered page to show its results before reading it
 * anyway.
 *
 * A property of this mechanism rather than of any provider: the wait exists
 * because a headless browser reports the document as loaded before the search
 * results are in the DOM, and that is the same race whichever engine is being
 * read. Ten seconds is generous for a page that has already responded; the wait
 * expiring is not an error, since the page is read as it stands.
 */
export const RESULT_RENDER_TIMEOUT_MS = 10_000;

/**
 * How long to wait for `ready.selector`, defaulting to
 * {@link RESULT_RENDER_TIMEOUT_MS}.
 *
 * A function rather than a `??` at the call site so the resolution is testable
 * without a browser, and so an explicit `0` keeps meaning "do not wait" instead
 * of falling back to the default the way a truthiness check would.
 */
export function readyTimeoutMs(ready?: { timeoutMs?: number }): number {
	return ready?.timeoutMs ?? RESULT_RENDER_TIMEOUT_MS;
}

/** HTML plus the response status and final URL after redirects or browser navigation. */
export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

interface BrowserFallbackOptions {
	homeUrl?: string;
	/**
	 * A selector to wait for after navigation, so the page is read once its results
	 * exist rather than as soon as the document loads.
	 *
	 * `timeoutMs` is optional and defaults to {@link RESULT_RENDER_TIMEOUT_MS}: the
	 * SELECTOR is the provider's own fact and the patience is this mechanism's, and
	 * when each provider carried both, google and ecosia each declared the same
	 * `RESULT_RENDER_TIMEOUT_MS = 10_000` beside their selector.
	 */
	ready?: { selector: string; timeoutMs?: number };
	afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>;
	shouldFallback: (page: LoadedHtmlPage) => boolean;
	attempts?: number;
	retryDelayMs?: number;
}

/** Controls a browser-profiled fetch and its optional headless-browser fallback. */
export interface BrowserFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	randomizeHeaders?: boolean;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
	browser?: BrowserFallbackOptions;
}

async function fetchHtmlPage(url: string, options: BrowserFetchOptions, fetchImpl: FetchImpl): Promise<LoadedHtmlPage> {
	const response = await fetchImpl(url, {
		...options.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...options.headers,
		},
		signal: options.signal,
	});
	return { html: await response.text(), status: response.status, url: response.url || url };
}

async function browseHtmlPage(
	url: string,
	options: BrowserFallbackOptions,
	signal: AbortSignal,
): Promise<LoadedHtmlPage> {
	const { homeUrl, ready } = options;
	const attempts = Math.max(1, options.attempts ?? 1);
	const handle = await untilAborted(signal, () =>
		acquireBrowser(
			{ kind: "headless", headless: true },
			{
				cwd: process.cwd(),
				signal,
			},
		),
	);
	if (!("browser" in handle)) {
		await releaseBrowser(handle, { kill: false });
		throw new Error("Headless browser acquisition returned a non-Puppeteer browser");
	}

	holdBrowser(handle);
	let page: Page | undefined;
	try {
		const activePage = await untilAborted(signal, () => handle.browser.newPage());
		page = activePage;
		await applyViewport(activePage);
		await applyStealthPatches(handle.browser, activePage, handle.stealth);
		if (homeUrl) {
			await untilAborted(signal, () =>
				activePage.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_HARD_TIMEOUT_MS }),
			);
		}
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0 && options.retryDelayMs) await Bun.sleep(options.retryDelayMs);

			const response = await untilAborted(signal, () =>
				activePage.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_HARD_TIMEOUT_MS }),
			);
			if (options.afterNavigation) await options.afterNavigation(activePage, signal);
			if (ready) {
				// The selector wait is an optimisation: it gives results a chance to render before the HTML is
				// read. A timeout is an ordinary outcome for a page that never shows it, and the content read
				// below plus `shouldFallback` decide whether the page was actually usable.
				await untilAborted(signal, () =>
					activePage.waitForSelector(ready.selector, { timeout: readyTimeoutMs(ready) }).catch(() => null),
				);
			}
			const loaded = {
				html: await untilAborted(signal, () => activePage.content()),
				status: response?.status() ?? 200,
				url: activePage.url(),
			};
			if (!options.shouldFallback(loaded) || attempt === attempts - 1) return loaded;
		}
		throw new Error("Browser fallback exhausted without a response");
	} finally {
		// Teardown in a `finally` that must not replace either the loaded page or the "exhausted" error above;
		// a page that will not close is going away with the browser released on the next line.
		await page?.close().catch(() => undefined);
		await releaseBrowser(handle, { kill: false });
	}
}

/** Fetch with a fresh browser profile, escalating rejected production responses to the stealth browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
	const fetchImpl = options.fetch ?? fetch;
	let page: LoadedHtmlPage;
	try {
		page = await fetchHtmlPage(url, options, fetchImpl);
	} catch (error) {
		if (options.fetch || !options.browser) throw error;
		return browseHtmlPage(url, options.browser, options.signal);
	}

	if (!options.browser || options.fetch) return page;
	const isSuccessful = page.status >= 200 && page.status < 300;
	if (isSuccessful && !options.browser.shouldFallback(page)) return page;
	return browseHtmlPage(url, options.browser, options.signal);
}
