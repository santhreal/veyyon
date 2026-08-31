/**
 * What a search case must find in the corpus, and what it must not.
 *
 * The parity arm compares `SearchTool` against the engine functions the tool itself
 * calls, so parity holds by construction and a passing parity run says nothing about
 * whether either arm answered correctly. An expectation is the missing half: the
 * corpus is deterministic and written by this package, so the set of files each query
 * has to surface is known ahead of the run. A regression inside an engine — a glob
 * that stops recursing, a gitignore rule read the wrong way round, a structural
 * pattern that matches no node — moves the answer while leaving parity intact.
 *
 * Paths are corpus-relative and compared exactly, in the spelling the details payload
 * reports (the engines report display paths relative to the search cwd).
 */
import type { FileSearchDetails } from "@veyyon/coding-agent/tools/file-search";
import type { SearchToolDetails } from "@veyyon/coding-agent/tools/search";
import type { StructureSearchDetails } from "@veyyon/coding-agent/tools/structure-search";
import type { TextSearchDetails } from "@veyyon/coding-agent/tools/text-search";

/** One case's declared answer over the deterministic corpus. */
export interface SearchExpectation {
	/** Every path here must appear among the matched files. */
	readonly mustMatchPaths?: readonly string[];
	/** No path here may appear among the matched files. */
	readonly mustNotMatchPaths?: readonly string[];
	/** Lower bound on matched files; a query whose exact set depends on a cap or on
	 * pagination declares this instead of enumerating. */
	readonly minMatchedPaths?: number;
	/** Exact matched-file count, for a case that pins a cap (`limit`) or a single file. */
	readonly exactMatchedPaths?: number;
}

/** Why an expectation was not satisfied. One entry per violated clause. */
export interface ExpectationFailure {
	readonly clause: "mustMatchPaths" | "mustNotMatchPaths" | "minMatchedPaths" | "exactMatchedPaths";
	readonly detail: string;
}

export interface ExpectationVerdict {
	readonly satisfied: boolean;
	readonly failures: readonly ExpectationFailure[];
	/** The matched paths the verdict was formed from, in the details payload's order. */
	readonly matchedPaths: readonly string[];
}

type AnySearchDetails = FileSearchDetails | TextSearchDetails | StructureSearchDetails;

/**
 * The engine payload inside a details object, whichever shape carried it.
 *
 * The unified tool wraps its engine's details as `{ type, result }` while an arm that calls
 * the engine directly returns the payload bare. Both the answer check here and the arm
 * comparison in the runner have to see the same object, so the unwrap has one owner.
 */
export function unwrapSearchDetails(
	details: AnySearchDetails | SearchToolDetails | undefined,
): AnySearchDetails | undefined {
	if (!details) return undefined;
	if ("type" in details && "result" in details) return (details as SearchToolDetails).result;
	return details as AnySearchDetails;
}

/**
 * The files a search reported, from whichever field its details variant carries.
 *
 * All three details shapes expose `files`; text and structure additionally carry
 * `fileMatches` with per-file counts, which is the richer source when present because
 * `files` can be capped for display. Reading both in one place keeps a case's
 * expectation independent of which representation answered it.
 */
export function collectMatchedPaths(details: AnySearchDetails | SearchToolDetails | undefined): readonly string[] {
	const payload = unwrapSearchDetails(details);
	if (!payload) return [];
	const seen = new Set<string>();
	const ordered: string[] = [];
	const add = (candidate: unknown): void => {
		if (typeof candidate !== "string" || candidate.length === 0) return;
		if (seen.has(candidate)) return;
		seen.add(candidate);
		ordered.push(candidate);
	};
	for (const file of payload.files ?? []) add(file);
	if ("fileMatches" in payload) {
		for (const entry of payload.fileMatches ?? []) add(entry.path);
	}
	return ordered;
}

/** Check one case's declared answer against what the search reported. */
export function verifySearchExpectation(
	details: AnySearchDetails | SearchToolDetails | undefined,
	expectation: SearchExpectation,
): ExpectationVerdict {
	const matchedPaths = collectMatchedPaths(details);
	const matched = new Set(matchedPaths);
	const failures: ExpectationFailure[] = [];

	const missing = (expectation.mustMatchPaths ?? []).filter(required => !matched.has(required));
	if (missing.length > 0) {
		failures.push({
			clause: "mustMatchPaths",
			detail: `never matched ${missing.join(", ")} (matched ${matchedPaths.length > 0 ? matchedPaths.join(", ") : "nothing"})`,
		});
	}

	const forbidden = (expectation.mustNotMatchPaths ?? []).filter(excluded => matched.has(excluded));
	if (forbidden.length > 0) {
		failures.push({ clause: "mustNotMatchPaths", detail: `matched ${forbidden.join(", ")}, which it must not` });
	}

	if (expectation.minMatchedPaths !== undefined && matchedPaths.length < expectation.minMatchedPaths) {
		failures.push({
			clause: "minMatchedPaths",
			detail: `matched ${matchedPaths.length} file(s), fewer than the ${expectation.minMatchedPaths} required`,
		});
	}

	if (expectation.exactMatchedPaths !== undefined && matchedPaths.length !== expectation.exactMatchedPaths) {
		failures.push({
			clause: "exactMatchedPaths",
			detail: `matched ${matchedPaths.length} file(s), not the exact ${expectation.exactMatchedPaths} required`,
		});
	}

	return { satisfied: failures.length === 0, failures, matchedPaths };
}

/** One line naming every violated clause, for a report row or a thrown error. */
export function formatExpectationFailures(failures: readonly ExpectationFailure[]): string {
	return failures.map(failure => `${failure.clause}: ${failure.detail}`).join("; ");
}
