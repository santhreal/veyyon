/**
 * Display limit constants for tool and status-line renderers.
 *
 * A leaf on purpose: it imports nothing. `tools/core/render-utils.ts` re-exports every
 * name here, so its consumers are unaffected, while a caller that needs only a
 * limit — the status-line segments on the launch path — reads this module and
 * skips the renderer graph behind `render-utils`.
 */

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
	/** Max hunks shown when collapsed (edit tool) */
	DIFF_COLLAPSED_HUNKS: 8,
	/** Max diff lines shown when collapsed (edit tool) */
	DIFF_COLLAPSED_LINES: 40,
} as const;

/** Default number of terminal output rows shown before expansion. */
export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

/** Truncation lengths for different content types */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
	/** Status-line chips (session name in the footline) — the footline shares
	 *  one row with model, mode, path, git, and the context bar, so a chip may
	 *  never dominate it */
	CHIP: 24,
	/** Idle recap status line (~40-word LLM reply) */
	RECAP: 280,
} as const;
/** Standard nouns for ToolView hidden counts and list truncation */
export const LINE_NOUN = { one: "line", many: "lines" } as const;
export const FILE_NOUN = { one: "file", many: "files" } as const;
export const ITEM_NOUN = { one: "item", many: "items" } as const;
export const MATCH_NOUN = { one: "match", many: "matches" } as const;
