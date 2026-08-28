import type { AuthStorage } from "@veyyon/ai";
import { scopedTimeoutSignal } from "../../../utils/fetch-timeout";
import { formatSearchProviderFailures, getSearchProvider, isSearchProviderExcluded } from "../provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { SEARCH_HARD_TIMEOUT_MS } from "./utils";

/** Credential-free engines the Public Web aggregate fans out to. Order is the tiebreak for merged ranking (earlier engines win equal consensus/rank), so */
export const PUBLIC_ENGINE_IDS = [
	"startpage",
	"google",
	"duckduckgo",
	"ecosia",
	"mojeek",
] as const satisfies readonly SearchProviderId[];

/** Aggregates get a wider default window than the shared SEARCH_DEFAULT_NUM_RESULTS: consensus needs breadth. */
const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

/** Soft deadline for the fan-out: past this point the aggregate returns as soon as it has at least one engine's results. Fast HTML engines answer */
const SOFT_DEADLINE_MS = 5_000;

/** Hard deadline for the fan-out: the aggregate returns whatever it has, even nothing, so one pathologically slow engine can never pin the tool call to */
const HARD_DEADLINE_MS = 30_000;

/** A deadline as a reader would say it. Seconds carry the production deadlines; a sub-second override rounds to `0s`, which reads as no deadline at all, so those keep their milliseconds. */
function formatDeadline(ms: number): string {
	return ms >= 1_000 ? `${Math.round(ms / 1_000)}s` : `${Math.round(ms)}ms`;
}

/** Deadline overrides — test seam; production callers use the defaults. */
export interface PublicWebDeadlines {
	softMs?: number;
	hardMs?: number;
}

/** Accumulator for one deduplicated URL across engines. Exported as a test seam. */
export interface MergedSource {
	source: SearchSource;
	/** Number of engines that returned this URL — the primary ranking signal. */
	engines: number;
	/** Best (lowest) per-engine rank observed. */
	bestRank: number;
	/** First-seen insertion index; final tiebreak keeps ordering deterministic. */
	order: number;
}

/** Canonical dedup key for a result URL: case-normalized host without a leading `www.`, path without a trailing slash, query preserved, fragment */
export function dedupKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		let path = url.pathname;
		if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
		return `${host}${path}${url.search}`;
	} catch {
		return rawUrl;
	}
}

/** Merge one engine's ranked sources into the accumulator map. Exported as a test seam. */
export function mergeSources(merged: Map<string, MergedSource>, sources: readonly SearchSource[]): void {
	for (const [rank, source] of sources.entries()) {
		const key = dedupKey(source.url);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
			continue;
		}
		existing.engines += 1;
		if (rank < existing.bestRank) {
			existing.bestRank = rank;
			existing.source.title = source.title;
			existing.source.url = source.url;
		}
		// Keep the most informative snippet regardless of which engine ranked it best.
		if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
			existing.source.snippet = source.snippet;
		}
		existing.source.publishedDate ??= source.publishedDate;
		existing.source.ageSeconds ??= source.ageSeconds;
		// Fill the author the same way as the other optional enrichment fields, so
		// a lower-ranked engine that carries an author the best-ranked one lacked
		// still contributes it instead of being silently dropped.
		existing.source.author ??= source.author;
	}
}

/** Execute a web search against every credential-free engine in parallel and consolidate the results: URLs are deduplicated across engines, ranked by */
export async function searchPublicWeb(
	params: SearchParams,
	deadlines: PublicWebDeadlines = {},
): Promise<SearchResponse> {
	params.signal?.throwIfAborted();
	const softMs = deadlines.softMs ?? SOFT_DEADLINE_MS;
	const hardMs = deadlines.hardMs ?? HARD_DEADLINE_MS;
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const engineIds = PUBLIC_ENGINE_IDS.filter(id => !isSearchProviderExcluded(id));
	if (engineIds.length === 0) {
		throw new SearchProviderError("public", "Every credential-free engine is excluded by settings.", 400);
	}

	// Each engine composes its own per-request ceiling on top of the shared hard deadline; the straggler controller lets the aggregate cancel
	const straggler = new AbortController();
	const hardTimeout = scopedTimeoutSignal(SEARCH_HARD_TIMEOUT_MS, params.signal);
	const signal = AbortSignal.any([hardTimeout.signal, straggler.signal]);

	const responses: (SearchResponse | undefined)[] = new Array(engineIds.length);
	const failures: ({ provider: { id: SearchProviderId; label: string }; error: unknown } | undefined)[] = new Array(
		engineIds.length,
	);
	const firstSuccess = Promise.withResolvers<void>();
	const callerAbort = Promise.withResolvers<never>();
	const onCallerAbort = (): void => callerAbort.reject(params.signal?.reason);
	params.signal?.addEventListener("abort", onCallerAbort, { once: true });
	const all = Promise.all(
		engineIds.map(async (id, index) => {
			try {
				const provider = await getSearchProvider(id);
				const response = await provider.search({ ...params, signal });
				responses[index] = response;
				// An engine that answers with nothing has not answered. Resolving here
				// on an empty response let the fastest engine end the extended wait
				// with no results to show for it.
				if (response.sources.length > 0) firstSuccess.resolve();
			} catch (error) {
				failures[index] = { provider: { id, label: id }, error };
			}
		}),
	);

	try {
		await Promise.race([all, Bun.sleep(softMs), callerAbort.promise]);
		const failureCount = failures.reduce(count => count + 1, 0);
		// Wait past the soft deadline on "nothing to merge yet", not on "nobody replied yet". A fast engine serving a bot wall parses to zero results and
		if (
			!responses.some(response => response !== undefined && response.sources.length > 0) &&
			failureCount < engineIds.length
		) {
			await Promise.race([all, firstSuccess.promise, Bun.sleep(Math.max(0, hardMs - softMs)), callerAbort.promise]);
		}
	} finally {
		params.signal?.removeEventListener("abort", onCallerAbort);
		straggler.abort();
		hardTimeout.cancel();
	}

	// Merge in engine-priority order (not settlement order) so ranking
	// tiebreaks stay deterministic.
	const merged = new Map<string, MergedSource>();
	for (const response of responses) {
		if (response) mergeSources(merged, response.sources);
	}

	const orderedFailures = failures.filter(
		(failure): failure is { provider: { id: SearchProviderId; label: string }; error: unknown } =>
			failure !== undefined,
	);
	// Nothing merged has three causes, and they are not the same news. Every engine failed; some engine never answered and was cancelled at the deadline; or every engine answered and the web
	if (merged.size === 0) {
		const unanswered = engineIds.filter(
			(_, index) => responses[index] === undefined && failures[index] === undefined,
		);
		if (unanswered.length === 0 && orderedFailures.length > 0) {
			throw new SearchProviderError(
				"public",
				`All public engines failed: ${formatSearchProviderFailures(orderedFailures)}`,
				503,
			);
		}
		if (unanswered.length > 0) {
			const alsoFailed =
				orderedFailures.length > 0 ? ` Other engines failed: ${formatSearchProviderFailures(orderedFailures)}` : "";
			throw new SearchProviderError(
				"public",
				`No public engine returned a result within ${formatDeadline(hardMs)}; ` +
					`${unanswered.join(", ")} did not answer.${alsoFailed}`,
				504,
			);
		}
	}

	const sources = Array.from(merged.values())
		.sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
		.slice(0, numResults)
		.map(entry => entry.source);

	return { provider: "public", sources };
}

/** Aggregate meta-provider over every credential-free engine. Explicit-only: the auto chain already walks the individual engines sequentially, so */
export class PublicWebProvider extends SearchProvider {
	readonly id = "public";
	readonly label = "Public Web";

	isAvailable(_authStorage: AuthStorage): boolean {
		return false;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPublicWeb(params);
	}
}
