/**
 * The contracts the Secret Manager's parts agree on.
 *
 * The card began as one table and grew into a manager: it filters, sorts, inspects, adds, moves
 * between scopes and reads a usage log. Keeping every one of those in the component that also owns
 * the vault, the modal chrome and the pointer routing is how a 1400-line file becomes a 3000-line
 * one, so each capability lives in its own module and meets the others HERE.
 *
 * Two rules hold for everything in this file, and they are what make the split worth having:
 *
 * 1. **No module in this group touches the vault or the filesystem.** They take data and return
 *    data or lines. The container performs every mutation, because a write is the one thing that
 *    must stay in one place to be reasoned about, and because it is what lets each part be tested
 *    against exact values with no temp directory.
 * 2. **No module in this group renders a secret VALUE.** The vault's central promise is that a
 *    stored value is never shown again. `ScopedVaultEntry` carries `value`, so every consumer here
 *    is a place that promise could be broken; none of them may print it, truncate it onto a row,
 *    or put it on the clipboard.
 */
import type { SecretExpansionRecord } from "../../secrets/audit";
import type { ScopedVaultEntry, VaultScope } from "../../secrets/vault";

/**
 * A row of the Secrets table: a stored credential, or a vault file that would not open.
 *
 * The broken case is a ROW rather than a banner because the manager is the only surface in a
 * terminal that can repair one, and an operator finds it by arrowing down the same list they
 * already have their hands on.
 */
export type ManagerRow =
	| { readonly kind: "secret"; readonly entry: ScopedVaultEntry }
	| { readonly kind: "broken"; readonly scope: VaultScope; readonly reason: string };

/** What the Secrets table can be ordered by. */
export type SecretSortKey = "name" | "scope" | "expiry" | "created";

/** Which way a sort key runs. */
export type SortDirection = "asc" | "desc";

/**
 * A half-open span of a rendered cell that matched the filter, for highlighting.
 *
 * Character offsets into the PLAIN text of the cell, before any colour is applied. Styling a
 * string that already carries escape sequences by index is how highlight code corrupts a line.
 */
export interface MatchSpan {
	start: number;
	end: number;
}

/** One row after filtering and sorting, carrying why it matched so the match can be shown. */
export interface ShapedRow {
	row: ManagerRow;
	/** Spans within the row's placeholder text that the query matched. Empty when no query. */
	nameMatches: readonly MatchSpan[];
	/** Spans within the row's scope text that the query matched. Empty when no query. */
	scopeMatches: readonly MatchSpan[];
}

/** What a stored secret has been used for, joined from the expansion log. */
export interface SecretUsageStats {
	/** Times this placeholder appears across the records read. */
	useCount: number;
	/** Epoch milliseconds of the most recent use, or `null` when it has never been used. */
	lastUsedAt: number | null;
	/** Distinct tools that received it, most recent first, deduplicated. */
	tools: readonly string[];
}

/** A filter over the expansion log. Every field is ANDed; an empty field matches everything. */
export interface LogFilter {
	/** Free text matched against the tool name and the command, case-insensitively. */
	text: string;
	/** Restrict to records that spent this exact placeholder, for example `#GITHUB_TOKEN#`. */
	placeholder: string | undefined;
}

/**
 * The steps of adding a credential from inside the card.
 *
 * ONE QUESTION. The credential is stored the moment its value is known, under a name the vault
 * invents, in the default scope. A name and a scope are labels on a thing that has to exist first,
 * both are one keystroke away on the row it lands as (`n` renames, `m` moves), and asking for them
 * up front made storing one token cost three full-screen prompts. The terminal has always stored a
 * bare `/secret` in one step; this is the card agreeing with it.
 *
 * `env` is that one question reached the other way: the operator names an environment VARIABLE and
 * the credential is read out of it, so it is never typed and never on screen. It replaces `value`
 * rather than preceding it, because the two are alternative sources for one answer.
 */
export type AddFlowStep = "value" | "env" | "done";

/** What the add flow has collected so far, and what it still needs. */
export interface AddFlowState {
	step: AddFlowStep;
	/** The credential. Held only until the container stores it, and never rendered. */
	value: string;
	/**
	 * The environment variable the value came from, when it came from one.
	 *
	 * Kept so the confirmation can say where the credential was read from. It is a variable NAME, so
	 * unlike {@link value} it is safe to render, and saying it is what lets an operator notice they
	 * stored the wrong variable while the mistake is still cheap.
	 */
	fromEnv?: string;
}

/**
 * A move of one entry from the scope it is in to another.
 *
 * A move is an add plus a remove, and the two must be described together before either runs: the
 * add can collide with a name already in the destination, and discovering that after the remove
 * would have destroyed the credential in exchange for nothing.
 */
export interface ScopeMovePlan {
	name: string;
	from: VaultScope;
	to: VaultScope;
}

/** Why a move cannot be made, phrased for the operator, or `null` when it can. */
export type ScopeMoveRefusal = string | null;

/** One line of the key map, shown when the footer cannot hold every action. */
export interface HelpEntry {
	/** The keys, already joined, for example `up/down` or `r`. */
	keys: string;
	/** What pressing them does, lower case, imperative. */
	description: string;
	/** The view it applies to, or `both`. */
	view: "secrets" | "log" | "both";
}

/** Everything the log-shaping module needs, so it never reaches for a file itself. */
export interface LogShapingInput {
	records: readonly SecretExpansionRecord[];
	filter: LogFilter;
}
