import type { FetchImpl } from "@veyyon/ai";
import { untilAborted } from "@veyyon/utils";
import type { Page } from "puppeteer-core";
import { applyStealthPatches, applyViewport } from "../../../tools/browser/launch";
import { acquireBrowser, holdBrowser, releaseBrowser } from "../../../tools/browser/registry";
import { buildBrowserNavigationHeaders } from "./browser-headers";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

export const RESULT_RENDER_TIMEOUT_MS = 10_000;

export function readyTimeoutMs(ready?: { timeoutMs?: number }): number {
	return ready?.timeoutMs ?? RESULT_RENDER_TIMEOUT_MS;
}

export interface LoadedHtmlPage {
	html: string;
	status: number;
	url: string;
}

export interface BrowserFetchAttempt {
	url: string;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
}

export type BrowserFetchAttemptFactory = () => BrowserFetchAttempt;

interface BrowserFallbackOptions {
	homeUrl?: () => string;
	ready?: { selector: string; timeoutMs?: number };
	afterNavigation?: (page: Page, signal: AbortSignal) => Promise<void>;
	shouldFallback: (page: LoadedHtmlPage) => boolean;
	attempts?: number;
	retryDelayMs?: number;
}

export interface BrowserFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	randomizeHeaders?: boolean;
	browser?: BrowserFallbackOptions;
}

async function fetchHtmlPage(
	attempt: BrowserFetchAttempt,
	options: BrowserFetchOptions,
	fetchImpl: FetchImpl,
): Promise<LoadedHtmlPage> {
	const response = await fetchImpl(attempt.url, {
		...attempt.init,
		headers: {
			...buildBrowserNavigationHeaders({ randomized: options.randomizeHeaders }),
			...(attempt.referer ? { Referer: attempt.referer, "Sec-Fetch-Site": "same-origin" } : {}),
			...attempt.headers,
		},
		signal: options.signal,
	});
	return {
		html: await response.text(),
		status: response.status,
		url: response.url || attempt.url,
	};
}

async function browseHtmlPage(
	createAttempt: BrowserFetchAttemptFactory,
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
				activePage.goto(homeUrl(), { waitUntil: "domcontentloaded", timeout: SEARCH_HARD_TIMEOUT_MS }),
			);
		}
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0 && options.retryDelayMs) await Bun.sleep(options.retryDelayMs);

			const response = await untilAborted(signal, () =>
				activePage.goto(createAttempt().url, {
					waitUntil: "domcontentloaded",
					timeout: SEARCH_HARD_TIMEOUT_MS,
				}),
			);
			if (options.afterNavigation) await options.afterNavigation(activePage, signal);
			if (ready) {
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
		await page?.close().catch(() => undefined);
		await releaseBrowser(handle, { kill: false });
	}
}

export async function browserFetch(
	createAttempt: BrowserFetchAttemptFactory,
	options: BrowserFetchOptions,
): Promise<LoadedHtmlPage> {
	const fetchImpl = options.fetch ?? fetch;
	const firstAttempt = createAttempt();
	let page: LoadedHtmlPage;
	try {
		page = await fetchHtmlPage(firstAttempt, options, fetchImpl);
	} catch (error) {
		if (options.fetch || !options.browser) throw error;
		return browseHtmlPage(createAttempt, options.browser, options.signal);
	}

	if (!options.browser || options.fetch) return page;
	const isSuccessful = page.status >= 200 && page.status < 300;
	if (isSuccessful && !options.browser.shouldFallback(page)) return page;
	return browseHtmlPage(createAttempt, options.browser, options.signal);
}
