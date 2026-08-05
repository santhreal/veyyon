/**
 * Filtering and ordering for the Secrets table.
 *
 * The card began as a list you could only walk with the arrow keys. That is fine for the three
 * credentials a new profile holds and unusable at forty, and it cannot answer the one question an
 * operator actually arrives with: which of these expires first. Both answers are the same shape of
 * work, a pure rearrangement of rows, so they live together here.
 *
 * Nothing in this module reads the vault, writes a file or renders a line. It takes rows and gives
 * rows back, which is what lets the container decide how a match is painted and lets these rules be
 * tested against exact spans and exact orderings with no temp directory.
 *
 * Two rules here are load bearing rather than tidy:
 *
 * 1. **A broken vault file always survives the filter and always sorts to the top.** A vault that
 *    would not open is the one thing an operator must not be able to hide from themselves with a
 *    stray keystroke. A filter that buried it would leave unreachable credentials on disk with no
 *    sign on screen that anything was wrong.
 * 2. **The filter never reads a secret's value.** Matching runs over the placeholder and the scope,
 *    the two things already on the row. Searching the value would make the table an oracle: type a
 *    guess, watch a row appear, and the vault's one promise is gone.
 */
import { buildNamePlaceholder } from "../../secrets/placeholder";
import { type ScopedVaultEntry, VAULT_SCOPES } from "../../secrets/vault";
import type { ManagerRow, MatchSpan, SecretSortKey, ShapedRow, SortDirection } from "./secret-manager-types";

/**
 * The single empty span list every unmatched cell points at.
 *
 * With no query every row is a match with nothing to highlight, and a fresh `[]` per cell would
 * make a redraw of a large vault allocate two throwaway arrays per row for no reader. It is frozen
 * so a consumer that tries to push into what it was handed fails here instead of quietly giving
 * every other row the same highlight.
 */
const NO_MATCHES: readonly MatchSpan[] = Object.freeze([]);

/** The order one press of the sort key walks. Total and cyclic, so the fourth press is where you began. */
const NEXT_SORT_KEY: Record<SecretSortKey, SecretSortKey> = {
	name: "scope",
	scope: "expiry",
	expiry: "created",
	created: "name",
};

/**
 * The footer label for each key and direction.
 *
 * Each direction is spelled out in the words of its own column rather than with an arrow glyph,
 * because "sorted by expiry, ascending" leaves an operator to work out whether ascending time means
 * the credential about to die is at the top or at the bottom.
 */
const SORT_LABELS: Record<SecretSortKey, { readonly asc: string; readonly desc: string }> = {
	name: { asc: "sorted by name (A to Z)", desc: "sorted by name (Z to A)" },
	scope: { asc: "sorted by scope (widest first)", desc: "sorted by scope (narrowest first)" },
	expiry: { asc: "sorted by expiry (soonest first)", desc: "sorted by expiry (latest first)" },
	created: { asc: "sorted by created (oldest first)", desc: "sorted by created (newest first)" },
};

/** Every ASCII capital, for the one fold that is safe to take offsets from. */
const ASCII_UPPER = /[A-Z]/g;

/**
 * Lower case A to Z and leave every other character alone.
 *
 * BOTH the query and the text being searched go through this and only this, because a match is
 * found in one and highlighted in the other; two folds that disagree by a single character produce
 * spans that paint the wrong letters.
 *
 * It is not `toLowerCase`, which is the wrong fold for a highlight: Unicode folding can change a
 * string's LENGTH (`İ` becomes two code units), which slides every offset after it onto the wrong
 * character. Folding only A to Z is one-to-one by construction, and the text searched here is a
 * placeholder or a scope, both ASCII by the vault's own name rule.
 */
function foldAscii(text: string): string {
	return text.replace(ASCII_UPPER, character => character.toLowerCase());
}

/**
 * Every place `foldedQuery` occurs in `text`, as half-open offsets into the unfolded text.
 *
 * Occurrences are walked forward by the length of the query, so two spans never overlap and they
 * arrive in ascending order. A consumer painting them in sequence can therefore treat the previous
 * end as the next safe starting point.
 */
function findSpans(text: string, foldedQuery: string): readonly MatchSpan[] {
	const haystack = foldAscii(text);
	let index = haystack.indexOf(foldedQuery);
	if (index < 0) return NO_MATCHES;
	const spans: MatchSpan[] = [];
	while (index >= 0) {
		const end = index + foldedQuery.length;
		spans.push({ start: index, end });
		index = haystack.indexOf(foldedQuery, end);
	}
	return spans;
}

/**
 * Compare two strings by code unit.
 *
 * Not `localeCompare`: the order of the table would then depend on the machine's locale, and a
 * tie-break whose answer changes between environments is not a tie-break.
 */
function compareText(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** Compare two numbers without subtracting, so stamps near the safe-integer edge cannot overflow the sign. */
function compareNumbers(left: number, right: number): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/**
 * Compare two credentials on the chosen column, ascending. Direction is applied by the caller.
 *
 * The expiry case handles `null` BEFORE the arithmetic. `null` means the credential never expires,
 * and coercing it would sort a permanent credential as if it had expired at the epoch, putting the
 * one entry that needs no attention above every entry that does. Soonest-first therefore ends with
 * the entries that end never.
 */
function compareOnKey(left: ScopedVaultEntry, right: ScopedVaultEntry, key: SecretSortKey): number {
	switch (key) {
		case "name":
			return compareText(left.name, right.name);
		case "scope":
			return compareNumbers(VAULT_SCOPES.indexOf(left.scope), VAULT_SCOPES.indexOf(right.scope));
		case "expiry":
			if (left.expiresAt === null) return right.expiresAt === null ? 0 : 1;
			if (right.expiresAt === null) return -1;
			return compareNumbers(left.expiresAt, right.expiresAt);
		case "created":
			return compareNumbers(left.createdAt, right.createdAt);
	}
}

/**
 * The full row order: broken files first, then the chosen column, then name, then scope.
 *
 * The tie-breaks are what make this a TOTAL order, and a total order is what keeps the list from
 * shuffling under the cursor between two renders of the same data. They stay ascending when the
 * direction flips, so reversing the column you asked for never scrambles the rows that tie in it.
 */
function compareRows(left: ShapedRow, right: ShapedRow, key: SecretSortKey, direction: SortDirection): number {
	const a = left.row;
	const b = right.row;
	// The broken group is lifted out before the direction is read. An operator reversing a column
	// is asking about their credentials, not asking to push the unreadable vault off the screen.
	if (a.kind === "broken" || b.kind === "broken") {
		if (a.kind !== "broken") return 1;
		if (b.kind !== "broken") return -1;
		const byScope = compareNumbers(VAULT_SCOPES.indexOf(a.scope), VAULT_SCOPES.indexOf(b.scope));
		return byScope !== 0 ? byScope : compareText(a.reason, b.reason);
	}
	const primary = compareOnKey(a.entry, b.entry, key);
	const signed = direction === "desc" ? -primary : primary;
	if (signed !== 0) return signed;
	const byName = compareText(a.entry.name, b.entry.name);
	if (byName !== 0) return byName;
	return compareNumbers(VAULT_SCOPES.indexOf(a.entry.scope), VAULT_SCOPES.indexOf(b.entry.scope));
}

/**
 * Filter the Secrets table to what the query names, then put it in the order asked for.
 *
 * One function rather than a filter and a sort the container calls in turn, because the two share
 * the rule that a broken vault file is exempt from both: it survives every query and it sits at the
 * top of every order. Splitting them is how that exemption ends up applied in one place only.
 *
 * The returned rows carry the spans that matched, so the container can highlight exactly the
 * characters the operator typed rather than re-deriving the match against text it has already
 * coloured.
 */
export function shapeSecretRows(
	rows: readonly ManagerRow[],
	options: {
		/** What the operator typed. Matched case-insensitively against the placeholder and the scope. */
		query: string;
		/** The column to order by. */
		sortKey: SecretSortKey;
		/** Which way that column runs. */
		direction: SortDirection;
	},
): readonly ShapedRow[] {
	// Trimmed, so a stray space is treated as no filter. Neither a placeholder nor a scope can hold
	// a space, so the alternative is a table that blanks itself on a fumbled keystroke.
	const query = foldAscii(options.query.trim());
	const shaped: ShapedRow[] = [];
	for (const row of rows) {
		if (query.length === 0) {
			shaped.push({ row, nameMatches: NO_MATCHES, scopeMatches: NO_MATCHES });
			continue;
		}
		if (row.kind === "broken") {
			// Kept unconditionally. Its scope is still matched, so a query that happens to name the
			// scope highlights it the same way a credential's would.
			shaped.push({ row, nameMatches: NO_MATCHES, scopeMatches: findSpans(row.scope, query) });
			continue;
		}
		// The placeholder, not the bare name, so a query of `#git` finds what the operator sees on
		// the row and what they would paste into a prompt.
		const nameMatches = findSpans(buildNamePlaceholder(row.entry.name), query);
		const scopeMatches = findSpans(row.entry.scope, query);
		if (nameMatches.length === 0 && scopeMatches.length === 0) continue;
		shaped.push({ row, nameMatches, scopeMatches });
	}
	shaped.sort((left, right) => compareRows(left, right, options.sortKey, options.direction));
	return shaped;
}

/**
 * The key one press of the sort binding moves to.
 *
 * A cycle rather than a menu, because four columns is fewer presses to walk than a modal is to open
 * and dismiss. It closes, so an operator who has lost track can press until they recognise the
 * footer instead of having to remember where the cycle started.
 */
export function nextSortKey(current: SecretSortKey): SecretSortKey {
	return NEXT_SORT_KEY[current];
}

/**
 * The footer's one-line statement of how the table is currently ordered.
 *
 * The order is otherwise invisible on a list whose rows carry no numbers, and an operator reading
 * the top row as "the next credential to expire" when it is in fact the last one is worse off than
 * with no sort at all. The direction is named in the column's own words for the same reason.
 */
export function describeSort(key: SecretSortKey, direction: SortDirection): string {
	const labels = SORT_LABELS[key];
	return direction === "asc" ? labels.asc : labels.desc;
}
