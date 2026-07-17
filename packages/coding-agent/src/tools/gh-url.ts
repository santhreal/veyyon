/**
 * Shared GitHub issue/PR URL parsing. Single source for the stricter,
 * case-insensitive, query/fragment-tolerant regex so the `gh` fetch path
 * (`gh.ts`) and its cache-invalidation path (`gh-cache-invalidation.ts`) key
 * the same URL identically — see BACKLOG SPEC-ONE-PLACE-AUDIT F5.
 */

// `[^/\s]+` (not `[^/]+`) so whitespace inside owner/repo is rejected rather
// than silently matched.
const PR_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

/** Parse a GitHub PR URL, tolerating trailing query strings/fragments and mixed-case hosts. */
export function parsePrUrl(value: string | undefined): { repo?: string; prNumber?: number } {
	const normalized = value?.trim();
	if (!normalized) return {};
	const match = normalized.match(PR_URL_PATTERN);
	if (!match) return {};
	return { repo: match[1], prNumber: Number(match[2]) };
}

/** Parse a GitHub issue URL, tolerating trailing query strings/fragments and mixed-case hosts. */
export function parseIssueUrl(value: string | undefined): { repo?: string; issueNumber?: number } {
	const normalized = value?.trim();
	if (!normalized) return {};
	const match = normalized.match(ISSUE_URL_PATTERN);
	if (!match) return {};
	return { repo: match[1], issueNumber: Number(match[2]) };
}
