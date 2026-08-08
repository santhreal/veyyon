/**
 * The Secret Manager's key map, written down in one place and rendered on demand.
 *
 * The card's footer chips are a single row. Six actions already fit there only just, and the card
 * is gaining a filter, a sort, an add flow, a scope move and an inspect pane. A row of chips that
 * runs past the card's width does not report the overflow: it truncates, and the actions at its
 * end vanish while the keys behind them keep working. An operator then has no way to learn that
 * `m` moves a secret between scopes, because the one place that would have said so is the place
 * that got cut. This module is the answer to that: the full map, on its own surface, measured to
 * fit rather than trimmed to fit.
 *
 * Two things hold here, and they are the reason this is a module and not a string in the card:
 *
 * 1. **The key column is measured across the entries being SHOWN.** Every description starts at
 *    the same column, so the map reads as two columns rather than fourteen independent indents.
 *    Measuring the whole table instead of the shown slice would indent the Log view by a key it
 *    never displays.
 * 2. **A key is documented only where it does something.** An entry scoped to the Secrets view is
 *    absent while the Log view is active. A key map that lists a key which does nothing where it
 *    is written is worse than no key map, because the operator stops trusting the rest of it.
 *
 * Like every module in this group, this one touches no vault, no audit log and no file. It takes
 * a view and returns lines.
 */
import { type Component, Ellipsis, padding, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { theme } from "../theme/theme";
import type { HelpEntry } from "./secret-manager-types";

/**
 * Every key the Secret Manager binds, and what it does.
 *
 * This is the single source of truth for the map. The footer chips show a subset chosen by what
 * the selected row can do; this list is the whole surface, so a key added to the card and not
 * added here is a key no operator will find. Order is render order within each group.
 *
 * A DESCRIPTION THAT IS MERELY PLAUSIBLE IS THE FAILURE THIS TABLE EXISTS TO PREVENT. Four rows
 * here used to be wrong in ways only a keypress could reveal:
 *
 *   - `esc/q` was one row reading "close the card". Escape and `q` are not the same key. `q`
 *     closes; escape UNWINDS, dropping the search, then the credential the Log is narrowed to,
 *     and only closing once there is nothing left to step back out of. An operator who read this
 *     row and pressed escape to leave a filtered roster stayed on the card, and the card's own
 *     status line was meanwhile telling them escape clears the search.
 *   - `i` was described as "inspect what the selected secret has been used for", which is what
 *     `u` two rows below it does. `i` opens and closes the detail panel, and what that panel
 *     shows is mostly not usage: the scope, when the credential was added and when it expires.
 *   - `tab` and `shift+tab` switch views and appeared nowhere, so the only documented way across
 *     was an arrow key.
 *   - `j` and `k` move the selection and appeared nowhere either.
 */
export const SECRET_MANAGER_HELP: readonly HelpEntry[] = [
	{ keys: "c", description: "copy the selected secret's placeholder", view: "secrets" },
	{ keys: "e", description: "extend how long the selected secret lasts", view: "secrets" },
	{ keys: "n", description: "rename the selected secret", view: "secrets" },
	{ keys: "r", description: "revoke the selected secret", view: "secrets" },
	{ keys: "a", description: "add a credential to the vault", view: "secrets" },
	{ keys: "f", description: "add a credential read from an environment variable", view: "secrets" },
	{ keys: "m", description: "move the selected secret to another scope", view: "secrets" },
	{ keys: "i", description: "show or hide the selected secret's details", view: "secrets" },
	{ keys: "s", description: "sort the table by another column", view: "secrets" },
	{ keys: "u", description: "show the log narrowed to the selected secret's uses", view: "secrets" },
	{ keys: "d", description: "discard a vault file that would not open", view: "secrets" },
	{ keys: "up/down, j/k", description: "move the selection", view: "both" },
	{ keys: "pgup/pgdn", description: "move the selection by a screenful", view: "both" },
	{ keys: "/", description: "filter the rows", view: "both" },
	{ keys: "left/right, tab", description: "switch between the Secrets and Log views", view: "both" },
	{ keys: "?", description: "show this key map", view: "both" },
	{ keys: "esc", description: "step back: clear the search, then the narrowing, then close", view: "both" },
	{ keys: "q", description: "close the card", view: "both" },
];

/**
 * The heading over the keys that only work in the view you are looking at.
 *
 * Naming the view in the heading is what makes the grouping legible: the operator reads why those
 * keys are listed apart rather than guessing that the blank line means something.
 */
const GROUP_TITLES: Readonly<Record<"secrets" | "log", string>> = {
	secrets: "In the Secrets view",
	log: "In the Log view",
};

/** The heading over the keys that work in either view. */
const SHARED_TITLE = "Anywhere in the card";

/** Indent under a heading, so the rows read as belonging to it. */
const ROW_INDENT = "  ";

/** Gap between the key column and the descriptions, in one place so measuring matches joining. */
const COLUMN_GAP = "  ";

/** Shared empty result, so a width that fits nothing does not allocate a new array each frame. */
const NO_LINES: readonly string[] = [];

/**
 * The key map as a component.
 *
 * It renders and nothing else: the card owns the key that opens it, the key that closes it and
 * the chrome around it. Keeping the overlay passive is what lets its tests assert exact rows
 * without a TUI, a vault or a session.
 */
export class SecretHelpOverlay implements Component {
	#view: "secrets" | "log";
	readonly #entries: readonly HelpEntry[];
	#cache: readonly string[] | null = null;
	#cacheWidth = -1;

	/**
	 * @param view The view the card is showing, which decides the view-specific group.
	 * @param entries The map to render. Defaults to {@link SECRET_MANAGER_HELP}; injectable so a
	 * test can pin the measuring rule with a table whose longest key belongs to the other view,
	 * which the real map cannot express.
	 */
	constructor(view: "secrets" | "log", entries: readonly HelpEntry[] = SECRET_MANAGER_HELP) {
		this.#view = view;
		this.#entries = entries;
	}

	/**
	 * Point the overlay at the other view.
	 *
	 * The card keeps one overlay and re-points it rather than building a new one each time help is
	 * opened, so this must drop the memoized rows: serving the previous view's group here is the
	 * exact failure the view filtering exists to prevent.
	 */
	setView(view: "secrets" | "log"): void {
		if (view === this.#view) return;
		this.#view = view;
		this.#cache = null;
	}

	/** Drop the memoized rows so the next render repaints under the new theme. */
	invalidate(): void {
		this.#cache = null;
	}

	render(width: number): readonly string[] {
		if (this.#cache !== null && this.#cacheWidth === width) return this.#cache;
		const lines = this.#build(width);
		this.#cache = lines;
		this.#cacheWidth = width;
		return lines;
	}

	/** Build the two groups, measured together so their key columns agree. */
	#build(width: number): readonly string[] {
		if (width <= 0) return NO_LINES;
		const specific = this.#entries.filter(entry => entry.view === this.#view);
		const shared = this.#entries.filter(entry => entry.view === "both");
		if (specific.length === 0 && shared.length === 0) return NO_LINES;

		// Measured across what is shown, never across the whole table: a key that belongs to the
		// other view must not push this view's descriptions to the right.
		let keyWidth = 0;
		for (const entry of specific) keyWidth = Math.max(keyWidth, visibleWidth(entry.keys));
		for (const entry of shared) keyWidth = Math.max(keyWidth, visibleWidth(entry.keys));

		const lines: string[] = [];
		if (specific.length > 0) this.#appendGroup(lines, GROUP_TITLES[this.#view], specific, keyWidth, width);
		if (specific.length > 0 && shared.length > 0) lines.push("");
		if (shared.length > 0) this.#appendGroup(lines, SHARED_TITLE, shared, keyWidth, width);
		return lines;
	}

	/** Append one heading and its rows, keys right-aligned into `keyWidth`, every line cut to `width`. */
	#appendGroup(lines: string[], title: string, entries: readonly HelpEntry[], keyWidth: number, width: number): void {
		lines.push(truncateToWidth(theme.fg("muted", theme.bold(title)), width, Ellipsis.Omit));
		for (const entry of entries) {
			// Pad before styling: the escape sequences carry no width, so measuring the raw keys is
			// the only measurement that lines the descriptions up.
			const lead = padding(keyWidth - visibleWidth(entry.keys));
			const keys = theme.fg("accent", entry.keys);
			const description = theme.fg("text", entry.description);
			lines.push(truncateToWidth(`${ROW_INDENT}${lead}${keys}${COLUMN_GAP}${description}`, width, Ellipsis.Omit));
		}
	}
}
