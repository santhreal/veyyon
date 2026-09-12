import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, ScrapeServices, SpecialHandler } from "../types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "../types";

/** Request state and services a declarative site handler receives for one scrape. */
export interface DeclarativeContext {
	url: string;
	timeout: number;
	signal?: AbortSignal;
	services?: ScrapeServices;
	fetchedAt: string;
	loadPage: typeof loadPage;
	tryParseJson: typeof tryParseJson;
	loadFailure: typeof loadFailure;
	scraperDegrade: typeof scraperDegrade;
}
export interface DeclarativeSite<TMatch> {
	site: string;
	method: string;
	hosts: string[];
	canonicalUrls: string[];
	match: (parsedUrl: URL) => TMatch | null;
	fetch: (match: TMatch, ctx: DeclarativeContext) => Promise<string | RenderResult | ScraperDegrade | null>;
	notes?: string[];
}
/** `*.example.com` matches any subdomain and the bare apex; every other entry matches exactly. */
function hostMatches(hosts: Set<string>, hostname: string): boolean {
	if (hosts.has(hostname)) return true;
	for (const host of hosts) {
		if (!host.startsWith("*.")) continue;
		if (hostname.endsWith(host.slice(1)) || hostname === host.slice(2)) return true;
	}
	return false;
}
/**
 * The scrape pipeline every declarative family shares: parse the URL, accept the host, map it to a
 * match, fetch, and render.
 */
export function createDeclarativeHandler<TMatch>(
	decl: DeclarativeSite<TMatch>,
	handlerName?: string,
	wildcardHosts = false,
): SpecialHandler {
	const hosts = new Set(decl.hosts);

	const handler: SpecialHandler = async (
		url: string,
		timeout: number,
		signal?: AbortSignal,
		services?: ScrapeServices,
	): Promise<RenderResult | ScraperDegrade | null> => {
		try {
			const parsed = tryParseUrl(url);
			if (!parsed) return null;
			const hostname = parsed.hostname.toLowerCase();
			if (!(wildcardHosts ? hostMatches(hosts, hostname) : hosts.has(hostname))) return null;

			const match = decl.match(parsed);
			if (!match) return null;

			const fetchedAt = new Date().toISOString();
			const result = await decl.fetch(match, {
				url,
				timeout,
				signal,
				services,
				fetchedAt,
				loadPage,
				tryParseJson,
				loadFailure,
				scraperDegrade,
			});
			if (!result) return null;
			if (typeof result === "string") {
				return buildResult(result, {
					url,
					method: decl.method,
					fetchedAt,
					notes: decl.notes ?? [`Fetched via ${decl.method} API`],
				});
			}
			return result;
		} catch (error) {
			return scraperDegrade(decl.site, error);
		}
	};

	if (handlerName) {
		Object.defineProperty(handler, "name", { value: handlerName });
	}
	return handler;
}
/** Load a JSON endpoint, returning the parsed payload or a ScraperDegrade on fetch/parse failure. */
export async function loadJson<T>(
	ctx: {
		loadPage: typeof loadPage;
		tryParseJson: typeof tryParseJson;
		loadFailure: typeof loadFailure;
		scraperDegrade: typeof scraperDegrade;
		timeout: number;
		signal?: AbortSignal;
	},
	url: string,
	site: string,
	options: Parameters<typeof loadPage>[1] = {},
): Promise<T | ScraperDegrade> {
	const headers = { Accept: "application/json", ...options.headers };
	const result = await ctx.loadPage(url, {
		timeout: ctx.timeout,
		signal: ctx.signal,
		...options,
		headers,
	});
	if (!result.ok) return ctx.scraperDegrade(site, ctx.loadFailure(result));
	const data = ctx.tryParseJson<T>(result.content);
	if (!data) return ctx.scraperDegrade(site, "unexpected response shape");
	return data;
}
