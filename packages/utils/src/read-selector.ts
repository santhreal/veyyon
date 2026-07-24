/**
 * The read-tool path-selector grammar and splitter, in ONE place.
 *
 * A read-tool path may carry a trailing `:selector` that is not part of the
 * filesystem path: a line-range list (`50`, `50-200`, `50+10`, `5-16,960-973`,
 * the `..` alias for `-`), the whole-file `raw` marker, or the `conflicts`
 * marker — alone, or as a `range:raw` / `raw:range` compound. `splitReadSelector`
 * peels that suffix off, leaving the bare path.
 *
 * This module is the single definitional home for that grammar. It was hand-
 * duplicated across `@veyyon/agent-core` (compaction's `splitReadSelector`, which
 * keys file-operation dedup) and `@veyyon/coding-agent` (the read tool's own
 * `splitPathAndSel`), with "keep in sync" comments on both copies — exactly the
 * drift hazard ONE PLACE forbids. If the two ever diverged, compaction would key
 * a read on a different base path than the read tool used, silently breaking
 * supersede-prune dedup. Both packages now import this owner, so they cannot
 * drift. Consumers that need the raw grammar fragment (e.g. to build a superset
 * matcher for internal-URL selectors) import {@link READ_SELECTOR_RANGE_LIST_SRC}
 * rather than re-typing the pattern.
 */

/**
 * A single line-range chunk source fragment: `N`, `N-M`, `N+K`, open-ended `N-`,
 * or the `..` alias (`2724..2727` == `2724-2727`). An optional leading `L`
 * mirrors editor "L50" line refs. Exported as a string so callers can compose it
 * into their own anchored regexes without re-typing (and re-drifting) the source.
 */
export const READ_SELECTOR_RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;

/** A comma-separated list of {@link READ_SELECTOR_RANGE_CHUNK_SRC} chunks. */
export const READ_SELECTOR_RANGE_LIST_SRC = `${READ_SELECTOR_RANGE_CHUNK_SRC}(?:,${READ_SELECTOR_RANGE_CHUNK_SRC})*`;

/** A trailing chunk that counts as a selector: a range list, `raw`, or `conflicts`. */
const SELECTOR_RE = new RegExp(`^(?:${READ_SELECTOR_RANGE_LIST_SRC}|raw|conflicts)$`, "i");
/** A trailing chunk that is a range list only (no `raw`/`conflicts`). */
const RANGE_ONLY_RE = new RegExp(`^${READ_SELECTOR_RANGE_LIST_SRC}$`, "i");
/** A trailing chunk that is exactly `raw`. */
const RAW_ONLY_RE = /^raw$/i;

/**
 * Split a read-tool path into its base path and trailing selector.
 *
 * A trailing `:chunk` is treated as a selector only when `chunk` matches the
 * selector grammar (range list, `raw`, or `conflicts`); otherwise the whole
 * input is returned as the path. A compound `path:range:raw` / `path:raw:range`
 * tail is recognized and returned joined as `sel`. A leading colon (`:50`) is
 * never a selector, and a drive-letter colon (`C:\src\main.ts`) is safe because
 * a backslash segment never matches the range grammar.
 */
export function splitReadSelector(path: string): { path: string; sel?: string } {
	const colon = path.lastIndexOf(":");
	if (colon <= 0) return { path };
	const candidate = path.slice(colon + 1);
	if (!SELECTOR_RE.test(candidate)) return { path };
	let base = path.slice(0, colon);
	let sel = candidate;
	// Compound trailing selector: `path:1-50:raw` or `path:raw:1-50`. The two
	// chunks must be one line-range plus one `raw`, in either order.
	const inner = base.lastIndexOf(":");
	if (inner > 0) {
		const innerCandidate = base.slice(inner + 1);
		const innerIsRaw = RAW_ONLY_RE.test(innerCandidate);
		const outerIsRaw = RAW_ONLY_RE.test(candidate);
		const innerIsRange = RANGE_ONLY_RE.test(innerCandidate);
		const outerIsRange = RANGE_ONLY_RE.test(candidate);
		if ((innerIsRaw && outerIsRange) || (innerIsRange && outerIsRaw)) {
			sel = `${innerCandidate}:${candidate}`;
			base = base.slice(0, inner);
		}
	}
	return { path: base, sel };
}

/**
 * Strip a trailing read-tool selector (`:50-200`, `:raw`, `:1-50:raw`,
 * `:conflicts`, …), returning the bare path. Convenience wrapper over
 * {@link splitReadSelector} for callers that only need the path.
 */
export function stripReadSelector(path: string): string {
	return splitReadSelector(path).path;
}
