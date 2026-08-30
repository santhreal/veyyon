/**
 * The one definition of a filtering card's search field.
 *
 * WHY THIS FILE EXISTS. Every card that filters had written its own field. There
 * were five spellings of the same row: `/providers` drew an accent icon, a bold
 * query and a right-aligned count; `/settings` drew a near copy whose icon took
 * the declared `accent` token, so a theme whose accent is a neutral rendered it
 * grey; `/tree`, the extension pane, the hook picker, the OAuth picker and the
 * message picker drew the literal string `Search: ` with a hand-painted `_` for
 * a caret, three of them inside the card BODY while still asking the shell to
 * reserve its band. Which meant an operator learned the affordance once per
 * card, and a themed terminal showed it in a different colour on each.
 *
 * WHAT A BAND IS. The shell's slot above the body: `⌕ <field> … N nouns`. The
 * icon marks the live affordance and takes the STATE accent, which carries
 * colour in a theme whose own `accent` token is a neutral. The caret is the
 * terminal's own — {@link CURSOR_MARKER} moves the hardware cursor into the
 * field, so it blinks the way the operator's terminal blinks instead of being a
 * painted block that does not. The count sits on the right edge rather than
 * after the query, so it stays in one column at every query length instead of
 * travelling across the band as the operator types.
 *
 * WHAT IT DOES NOT OWN. Input state. A caller that already runs an {@link Input}
 * hands its rendered line back through the `field` callback and keeps its own
 * cursor and editing; a caller holding a plain string calls {@link queryField}.
 * A list component drawn inside somebody else's card cannot reach the band at
 * all, and composes {@link searchIcon} with {@link queryField} on a body row —
 * same glyph, same caret, same hint grammar, one row lower.
 */
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@veyyon/tui";
// The live binding, not the theme ENGINE: the engine's own list themes call
// `searchStatusField` from here, and importing `./theme` would close that loop.
import { theme } from "../theme/theme-binding";

/** The live match readout: `1 provider`, `12 providers`, `0 matches`. */
export interface SearchBandCount {
	/** Rows surviving the query. Zero paints the count as a warning. */
	matches: number;
	/** Singular noun for a surviving row. */
	noun: string;
	/** Plural, when it is not `noun + "s"` (`match` → `matches`). */
	plural?: string;
}

/**
 * The search glyph, painted as the card's one live affordance.
 *
 * `stateAccent` rather than `theme.fg("accent")`: the accent token is a neutral
 * in some themes, and this is the mark that says a keystroke lands here.
 */
export function searchIcon(): string {
	return theme.stateAccent(theme.symbol("icon.search"));
}

/**
 * A field the caller holds as a plain string, with the terminal's caret at the
 * insertion point.
 *
 * On an empty query the caret sits on the first cell of the hint, so the hint
 * reads as text behind the caret rather than text the caret is trailing. A
 * caller whose empty state is drawn by {@link searchAffordance} instead — a list
 * inside somebody else's card, which must not claim the cursor while it holds no
 * query — passes no hint and only ever calls this with one.
 */
export function queryField(query: string, hint = ""): string {
	if (query.length === 0) return CURSOR_MARKER + theme.fg("dim", hint);
	return theme.bold(query) + CURSOR_MARKER;
}

/**
 * The active band, exactly one row wide `width`.
 *
 * `field` is called with the columns left after the icon and the count, so a
 * fixed-width field ({@link Input}) fills the band and a short one leaves the
 * count where it was.
 */
export function searchBand(width: number, count: SearchBandCount, field: (fieldWidth: number) => string): string {
	const label = count.matches === 1 ? `1 ${count.noun}` : `${count.matches} ${count.plural ?? `${count.noun}s`}`;
	const painted = theme.fg(count.matches > 0 ? "dim" : "warning", label);
	const prefix = ` ${searchIcon()} `;
	const prefixWidth = visibleWidth(prefix);
	const countWidth = visibleWidth(label);
	const rendered = field(Math.max(4, width - prefixWidth - countWidth - 2));
	const gap = Math.max(1, width - prefixWidth - visibleWidth(rendered) - countWidth - 1);
	return truncateToWidth(`${prefix}${rendered}${" ".repeat(gap)}${painted} `, width);
}

/**
 * The idle band: the affordance that says the field exists and how to open it.
 *
 * A card whose search is always live still shows it, because a card with no
 * visible field gives no sign that typing filters it.
 */
export function searchAffordance(width: number, hint: string): string {
	return truncateToWidth(` ${theme.fg("dim", theme.symbol("icon.search"))} ${theme.fg("dim", hint)}`, width);
}

/**
 * The field on a LIST's own status row.
 *
 * A list that draws its status line — `SelectList`, `SettingsList`, and the
 * pickers that live inside somebody else's card — has no band to put a field in,
 * so it puts one here: the same glyph and the same query, one row inside its own
 * rows. No caret: {@link CURSOR_MARKER} moves the HARDWARE cursor, there is one
 * of it, and a scene whose own input is focused already owns it. The caret
 * belongs to the field a card opened for it.
 */
export function searchStatusField(query: string, hint = "type to search"): string {
	if (query.length === 0) return `${searchIcon()} ${theme.fg("dim", hint)}`;
	return `${searchIcon()} ${theme.bold(query)}`;
}
