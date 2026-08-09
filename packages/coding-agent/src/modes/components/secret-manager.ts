/**
 * SecretManager — the one place stored credentials are managed.
 *
 * `/secret manager` opens this. Everything else the operator types after `/secret` IS a
 * credential, so this card is where the vault is inspected and repaired instead of being
 * driven by a subcommand grammar nobody can remember while holding a live token.
 *
 * WHAT IT DELIBERATELY NEVER SHOWS. A row carries the PLACEHOLDER (`#NAME#`), the scope, and
 * how long the entry has left. The value is not rendered, not truncated onto the row, not put
 * behind an expand key, and not copied by `c`. The product's whole promise is that a value put
 * into the vault stops being visible, and a management surface that prints one to prove the
 * entry exists breaks that promise on the screen most likely to be shared.
 *
 * `c` copies the PLACEHOLDER, because the placeholder is the thing an operator pastes into a
 * prompt. Copying the value would be the same disclosure by a slower route.
 *
 * THE REPAIR STATE IS PART OF THE CARD, not a crash. `vault.load()` refuses a vault file it
 * cannot read, and refusing is right: treating a tampered scope as an empty one turns every
 * security check in `vault.ts` into "that scope has no secrets". But this card is now the
 * primary repair surface, so a refusal is caught, the affected scopes are listed with the
 * reason, and `d` runs `discardUnreadableScope`, which MOVES the file aside rather than
 * destroying credentials that may still be recoverable behind a truncated tail. A manager that
 * threw here would leave the operator unable to start and unable to fix.
 *
 * AFTER EVERY MUTATION the live obfuscator is reloaded through `session.refreshSecrets()`.
 * Without it the card changes the vault while the running session keeps spending the state it
 * captured at startup: a revoked credential stays substitutable and a rename leaves the model
 * writing a placeholder nothing resolves. A refresh that fails is shown on the card rather than
 * swallowed, because the vault write is already durable and the operator is the only one who
 * can decide what to do about the gap.
 *
 * TWO VIEWS, ONE CARD. Secrets is the roster of what is stored; Log is the expansion record —
 * which credential was spent, in which tool, with what the model actually wrote. That log used
 * to be `/secret log`, and in a terminal that verb no longer parses, because everything after
 * `/secret` is now read as the credential itself. This card is the only route to it, so leaving
 * it out would have retired the evidence trail as a side effect of a parser change.
 *
 * Controls. The authoritative list is `SECRET_MANAGER_HELP` in `./secret-help-overlay`, which is
 * what `?` renders and what the handbook's table mirrors; this summary exists for a reader who is
 * already in this file.
 * - Tab, Shift+Tab, Left/Right: switch view
 * - Up/Down or j/k: move the cursor, in either view
 * - a: store a credential (one hidden field, stored on the answer)
 * - f: store one read out of an environment variable
 * - r: revoke the selected secret (confirmed)
 * - e: extend its lifetime
 * - v: replace its value, keeping its name, scope and expiry
 * - n: rename it
 * - m: move it to another scope
 * - c: copy its placeholder
 * - i: show its detail pane
 * - u: open the Log narrowed to that credential's uses
 * - s: sort the roster by another column
 * - /: search (the roster in Secrets, the records in Log)
 * - ?: the full key map
 * - d: discard the selected unreadable vault file (confirmed)
 * - q or Esc: close, after unwinding any overlay or narrowing
 */
import {
	type Component,
	Container,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { clampLow, errorMessage } from "@veyyon/utils";
import type { SecretAuditLog, SecretExpansionRecord } from "../../secrets/audit";
import { buildNamePlaceholder } from "../../secrets/placeholder";
import { DEFAULT_LOG_LIMIT, describeAgo } from "../../secrets/secret-command";
import {
	describeTimeLeft,
	parseTtl,
	type ScopedVaultEntry,
	type SecretVault,
	type VaultScope,
} from "../../secrets/vault";
import { shortenPath } from "../../tools/render-utils";
import { copyToClipboard } from "../../utils/clipboard";
import { getTabBarTheme } from "../shared";
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import {
	applyModalReveal,
	CARD_BODY_COL_INSET,
	computeModalDims,
	hitTestModalChrome,
	layoutShortcutRows,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	type ModalSizing,
	planModalChrome,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { type AddFlowSource, DEFAULT_ADD_SCOPE, SecretAddFlow } from "./secret-add-flow";
import { SecretDetailPane } from "./secret-detail-pane";
import { SecretHelpOverlay } from "./secret-help-overlay";
import { describeSort, nextSortKey, shapeSecretRows } from "./secret-list-shaping";
import { describeLogFilter, filterLogRecords, usageStatsFor } from "./secret-log-shaping";
import {
	type ManagerRow,
	type MatchSpan,
	type ScopeMovePlan,
	SECRET_CARD_PROSE_COLS,
	type SecretSortKey,
	type ShapedRow,
	type SortDirection,
} from "./secret-manager-types";
import { describeScopeMove, nextScope, planScopeMove } from "./secret-scope-move";
import { clampSelection, handleTabSwitchKey, renderScrollableList, selectionBand } from "./selector-helpers";

// `ManagerRow` is defined in `./secret-manager-types`, with the reasoning for why secrets and
// broken vault files share one selection. It lives there because the filter, sort, detail and
// help modules all speak in terms of it, and a type they each re-declared would drift.

/** Which of the card's two views is showing. */
type ViewId = "secrets" | "log";

const VIEW_ORDER: readonly ViewId[] = ["secrets", "log"];

/** Which surface the card is showing. The list is the resting state; the rest are transient. */
type ManagerMode = "list" | "confirm" | "prompt" | "help";

/** A destructive action held behind the confirm card until the operator says yes. */
interface PendingConfirm {
	readonly title: string;
	readonly body: readonly string[];
	/** Footer chip text for the accepting choice, in the operator's words. */
	readonly confirmLabel: string;
	readonly run: () => Promise<string>;
}

/** A one-field question held over the list: a TTL to extend by, a new name, or a credential. */
interface PendingPrompt {
	readonly title: string;
	readonly hint: string;
	/**
	 * Hide what is typed and preserve the bytes pasted, for a field that receives a credential.
	 *
	 * This is the Input's `credentialMode`, not a mask character, because the two are not the same
	 * decision. Masking alone still applies single-line cleanup, which trims trailing spaces and
	 * rewrites tabs and CR/LF: harmless in a name, silently corrupting in a passphrase or a
	 * multi-part token. A field that takes a credential has to keep the bytes it was given.
	 */
	readonly credential?: true;
	readonly submit: (value: string) => Promise<string>;
	/**
	 * Opened once this field has closed, for a flow that asks more than one question.
	 *
	 * It runs inside the same queued chain as the submit, so `settled()` covers the whole flow and
	 * a caller never has to guess at microtask depth to know the next field is up.
	 */
	readonly after?: () => void | Promise<void>;
	/**
	 * Run when the field is dismissed with escape instead of submitted.
	 *
	 * A field that EDITS A VIEW rather than mutating the vault needs this. The search field opens
	 * seeded with the current query so you can amend it, which means backspacing it to nothing is
	 * the only way to clear it: escape would otherwise abandon the edit and leave the old search
	 * in force, with no key that undoes it.
	 */
	readonly cancel?: () => void;
}

/**
 * What the card needs. Everything with a live-system side effect is injectable, so the tests
 * that own this component's contract drive a real vault in a temp directory without a TUI, a
 * session, or the operator's clipboard.
 */
export interface SecretManagerDeps {
	vault: SecretVault;
	/**
	 * The expansion log, absent when `secrets.auditLog` is off.
	 *
	 * ABSENT AND EMPTY ARE DIFFERENT ANSWERS, which is why this is optional rather than a log
	 * object that happens to hold nothing. "No credential has been used yet" and "nothing is
	 * being recorded, so this proves nothing" look identical as an empty table, and the second
	 * one is the state where an operator would wrongly conclude their credentials went unspent.
	 */
	auditLog?: SecretAuditLog;
	/**
	 * Reload the running session's secret runtime. Absent only where there is no session to
	 * refresh; a mutation then still lands in the vault and says so.
	 */
	refreshSecrets?: () => Promise<void>;
	/** Clipboard write for `c`. Defaults to the repo's one clipboard path. */
	copy?: (text: string) => Promise<void>;
	/** Rows to size the card against. Defaults to the live terminal height. */
	terminalHeight?: number;
	/** Play the open unfold (TOUCH-5). Show site decides via `modalRevealEnabled()`. */
	reveal?: boolean;
	/** Clock for the EXPIRES column, so a test can pin what "3d left" means. */
	now?: () => number;
	/**
	 * How `f` reads the environment, injected for the same reason `/secret --from-env` injects it:
	 * a test that proved this path by writing `process.env` would leak that variable into every file
	 * that runs after it. Defaults to the real environment, which is all production wants.
	 */
	readEnv?: (variable: string) => string | undefined;
}

/**
 * Footer chips for the Secrets view: the card's own actions, then what the SELECTED row can do.
 *
 * THE CARD-LEVEL KEYS ARE NOT DERIVED FROM THE ROW, and that is the whole correction here. Every
 * chip used to come from the selected row, so `a` never appeared on any screen: it belongs to the
 * card, not to a credential, and a row-derived list had nowhere to put it. On an empty vault that
 * produced a footer reading `left/right view · esc back` directly under body text saying "Press a
 * to store a credential", so the one key that can populate the card was advertised by the prose
 * and denied by the footer, on the only screen a new operator ever sees first.
 *
 * `a add` is unconditional because it is the one action that is ALWAYS available: it needs no row,
 * and on an empty vault it is the only thing left to do. `f from env` sits beside it because it is
 * the same action with the safest source, and until it existed the manager could not reach the one
 * entry form where the credential is never typed and never drawn: `/secret --from-env VAR` offered
 * it on the command line and the GUI did not. `? keys` is unconditional for the same reason it is in
 * the Log view's footer, which is that the key map is where the rest of the keys (`m` move, `i`
 * detail, `s` sort, `/` search) are documented. Those stay out of this footer deliberately:
 * restating them here would duplicate the map and wrap the footer onto a further row on a
 * 40-column card, spending the table's budget to say something `?` already says completely.
 *
 * THE FOOTER LISTS ACTIONS, AND NAVIGATION IS NOT ONE. `up/down navigate` used to lead the band
 * whenever a row existed, and it was the widest chip in it while being the one control an operator
 * tries without being told. Adding `f from env` ran the band onto a third row at every width, which
 * costs a row of the table on a card whose complaint is that it shows too little; dropping the
 * navigation hint pays for the new action and leaves the band at two rows exactly where it was. The
 * keys are still documented, in the key map, as `up/down, j/k`, next to `pgup/pgdn` which was never
 * in the footer either.
 *
 * That is a DELIBERATE divergence from the selectors, which all lead with `up/down navigate`. Those
 * are three-chip footers over a list whose only interaction is moving the cursor. This is an
 * eleven-chip band over a table that is also clickable, and it is the only footer here in which the
 * hint competes with actions for room rather than sitting beside them.
 *
 * THE ESCAPE CHIP SAYS `back`, NOT `close`. Both the key and the chip run {@link
 * SecretManager#dismiss}, which peels one level per press — a log search, then the credential the
 * log is narrowed to, then a roster search — and only closes once there is nothing left to step
 * out of. `esc close` was a label describing behaviour the card stopped having: an operator who
 * had narrowed the roster with `/` and pressed escape to leave stayed on the card, with the footer
 * still promising it would shut. It also contradicted the key map, which has said `step back` all
 * along and whose own footer already said `back`.
 */
function secretShortcuts(row: ManagerRow | undefined): readonly ModalShortcut[] {
	const rowActions: readonly ModalShortcut[] =
		row === undefined
			? []
			: row.kind === "broken"
				? [{ label: "d discard file", clickable: true, id: "discard" }]
				: [
						{ label: "c copy #NAME#", clickable: true, id: "copy" },
						{ label: "e extend", clickable: true, id: "extend" },
						{ label: "n rename", clickable: true, id: "rename" },
						{ label: "r revoke", clickable: true, id: "revoke" },
						{ label: "u uses", clickable: true, id: "uses" },
					];
	return [
		{ label: "a add", clickable: true, id: "add" },
		{ label: "f from env", clickable: true, id: "add-from-env" },
		...rowActions,
		{ label: "? keys", clickable: true, id: "help" },
		{ label: "left/right view" },
		{ label: "esc back", clickable: true, id: "close" },
	];
}

/**
 * Footer chips for the Log view, built from what the log can actually answer.
 *
 * A CHIP THAT CANNOT ACT IS WORSE THAN NO CHIP. This list was a constant, so a fresh profile
 * whose log holds nothing was still offered `up/down select` and `/ search`: two controls over
 * an empty table, one of which opens a field that can only ever narrow zero rows to zero rows.
 * The Secrets view has always pruned its row actions the same way, from the selected row; this
 * prunes from the records, which is the Log's equivalent of having something selected.
 *
 * `/ search` survives a search that matched NOTHING on purpose. That is the one state where the
 * key matters most, because amending the query is how the operator gets their rows back.
 */
function logShortcuts(counts: { records: number; visible: number }): readonly ModalShortcut[] {
	return [
		...(counts.visible > 0 ? [{ label: "up/down select" }] : []),
		...(counts.records > 0 ? [{ label: "/ search", clickable: true, id: "search" }] : []),
		{ label: "? keys", clickable: true, id: "help" },
		{ label: "left/right view" },
		{ label: "esc back", clickable: true, id: "close" },
	];
}

const PROMPT_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "esc cancel", clickable: true, id: "close" },
	{ label: "enter save", clickable: true, id: "confirm" },
];

/** Gap between the table's columns, in one place so measuring matches joining. */
const COLUMN_GAP = "  ";

/**
 * Widen a cell to `cells` TERMINAL COLUMNS, which is not what `String.padEnd` measures.
 *
 * `padEnd` counts UTF-16 code units. A tool named `mcp__文書__検索` is 12 units and 16 columns, so
 * padding it to a 16-column column added four more spaces and pushed every cell to its right four
 * columns off the grid: the table below the header stopped being a table on exactly the rows an
 * MCP server contributed, since a server names its own tools and nothing bounds those to ASCII.
 * The secrets table has always measured with `visibleWidth`; this is the log table saying the
 * same thing the same way.
 */
function pad(text: string, cells: number): string {
	return text + padding(cells - visibleWidth(text));
}

/**
 * Why a scope that `load()` skipped is unreadable, when `load()` itself survived.
 *
 * The partial case reports scope names and no reason: the payload cleared every provenance and
 * integrity check and still would not parse, which is the one failure the loader degrades past.
 * Stating that, rather than inventing a cause, keeps the card honest about what it knows.
 */
const PARTIAL_UNREADABLE_REASON = "This vault file decrypted but would not parse, so it cannot be read.";

/**
 * What the Log view says when nothing is being recorded.
 *
 * ONE LINE, within {@link SECRET_CARD_PROSE_COLS}. It NAMES the setting, in both the words the
 * settings UI uses and the key, because that is the only fact this state carries: an empty table
 * under a tab reading `Log (off)` has already said that nothing is recorded, and the three
 * sentences that used to explain what recording would capture were read by nobody who could not
 * already see the empty table.
 */
const AUDIT_DISABLED_LINES: readonly string[] = ['Turn on "Record Secret Use" (secrets.auditLog) to record every use.'];

/**
 * Body rows the tab strip and the blank line under it take before either pane starts.
 *
 * One constant because the panes are SIZED against it and the card's chrome arithmetic has to
 * agree with what `#buildLayout` actually adds; two independent copies of the number is how a
 * list quietly loses its last row to a body longer than the budget.
 */
const TAB_STRIP_ROWS = 2;

/**
 * Rows the detail panel is charged against the table's budget.
 *
 * Its worst case: a credential that has been used, which draws placeholder, scope, added,
 * expires, used, last used and tools. A never-used one draws five. The table reserves the
 * larger number either way so arrowing between the two does not resize the list under you.
 */
const DETAIL_PANE_ROWS = 7;

/**
 * The action a pointer uncovers on a secrets row, and the slot it occupies.
 *
 * `[x]` matches the Agent Control Center's per-row action so the two cards teach one gesture, and
 * the width counts the leading space that separates it from the text it follows.
 */
const ROW_ACTION_LABEL = "[x]";
const ROW_ACTION_WIDTH = 4;

/**
 * The most columns a log record's WHERE cell will ask the card to be.
 *
 * A command is UNBOUNDED — a model can write a four-hundred-column `curl` — so a card sized to
 * the widest one it holds asks for the whole terminal on every state, which is the flat
 * ninety-percent width {@link SecretManager.render} exists to stop handing out. The truncation is
 * safe here in a way it is nowhere else on this card: the selected record's command is printed in
 * full under the table, so this column identifies a row rather than disclosing it, and forty-eight
 * columns is a shell invocation's recognisable head — the program, its principal flag, and the
 * placeholder it spent.
 */
const LOG_WHERE_MAX_COLS = 48;

/**
 * The width the key map is measured at when the card asks how wide it needs to be.
 *
 * {@link SecretHelpOverlay} CUTS each line to the width it is handed and appends no ellipsis, so
 * measuring it at the card's own width reports back whatever the card has already amputated.
 * Rendering once at a width no terminal reaches gives the natural figure instead. The overlay
 * memoises per width, and this width never changes, so the extra build costs one pass over
 * fourteen rows the first time `?` is pressed and nothing afterwards.
 */
const HELP_MEASURE_COLS = 400;

/**
 * The widest a paragraph of the card's own prose will ask the card to be.
 *
 * The same budget every sentence on this card is written to, so the width a notice ASKS for and
 * the width its author was held to are one number. Left uncapped, the Log's file notices would ask
 * for their full sentence and stretch every other state to match.
 */
const PROSE_MAX_COLS = SECRET_CARD_PROSE_COLS;

/**
 * The card's own geometry, rather than the shared `MODAL_SIZING_LARGE` it used to borrow.
 *
 * `widthPct: 1` is not "full screen". `maxWidth` is REPLACED every frame by what the content
 * actually needs (see `#naturalContentWidth`), so the pair reads "as wide as the content asks
 * for, and no wider". The inherited `widthPct: 0.9` painted a 108-column card around a 40-column
 * roster on a 120-column terminal: sixty-five empty columns on every row, on the one card whose
 * whole job is a short table. The 140 stays as the ceiling a natural width is capped at, because
 * a line of prose past that is no longer scannable.
 *
 * `minWidth: 60` is the floor a split pane already had, kept so a narrow terminal renders exactly
 * the card it renders today. `vPad: 1` replaces LARGE's 2: two blank rows above the tab strip and
 * two below a three-row table left the content floating in the middle of an empty card.
 * `footerLines` is a starting value only — `render` replaces it with the number of rows the chips
 * actually wrap to, which is the whole fix for the blank row that used to sit under the Log's
 * one-row footer.
 */
const MANAGER_SIZING: ModalSizing = {
	widthPct: 1,
	maxWidth: 140,
	minWidth: 60,
	vMargin: 7,
	hPad: 2,
	vPad: 1,
	footerLines: 1,
};

/**
 * Columns the log's file notices are indented by.
 *
 * One constant because the notices are MEASURED against it as well as painted with it: the card's
 * natural width has to reserve room for the longest unbreakable run a notice holds (a path), and
 * an indent stated twice is how that reservation drifts one column short of what is drawn.
 */
const NOTICE_INDENT = "  ";

/**
 * The placeholders one record spent, which is the column an operator scans for.
 *
 * `+N` rather than the names, because the record itself is bounded: the writer stops listing
 * after a cap and counts the rest, so pretending to show them all would be a lie the file
 * cannot back.
 *
 * A module function rather than a method on the pane because the card MEASURES this cell before
 * it decides how wide to be, and the pane then joins it; the two have to be the same string.
 */
function logSecretsCell(record: SecretExpansionRecord): string {
	const listed = record.secrets.join(" ");
	return record.omittedSecrets === undefined ? listed : `${listed} +${record.omittedSecrets}`;
}

/**
 * The log table's column widths, measured across EVERY record rather than the visible page.
 *
 * Measuring the page is what makes a table shift sideways as it scrolls, so the pane has always
 * measured the whole set. It lives out here because the CARD measures the same columns for a
 * second purpose — deciding how wide to be before either pane is built — and a width computed
 * from one set of rules and painted under another is a table whose header does not sit over its
 * cells.
 *
 * `command` is the widest WHERE cell, which the pane does not use (that column takes whatever is
 * left) and the card caps: see {@link LOG_WHERE_MAX_COLS}.
 */
function logColumnWidths(
	records: readonly SecretExpansionRecord[],
	now: number,
): { when: number; tool: number; secrets: number; command: number } {
	let when = visibleWidth("WHEN");
	let tool = visibleWidth("TOOL");
	let secrets = visibleWidth("SECRETS");
	let command = visibleWidth("WHERE");
	for (const record of records) {
		when = Math.max(when, visibleWidth(describeAgo(now - record.at)));
		tool = Math.max(tool, visibleWidth(record.tool));
		secrets = Math.max(secrets, visibleWidth(logSecretsCell(record)));
		command = Math.max(command, visibleWidth(record.command));
	}
	return { when, tool, secrets, command };
}

/**
 * The expansion log, as a table.
 *
 * WHY THIS IS NOT `renderLog`. The non-interactive `/secret log` renders the same records as a
 * transcript: a sentence, then two indented lines per record, separated by hardcoded pairs of
 * spaces. That is right for a command whose output scrolls past in a terminal, and this card used
 * to reuse it verbatim, which is exactly why the view read as a dump pasted into a GUI. Nothing
 * lined up, one record cost two rows, and the header sentence counted records the body then
 * repeated.
 *
 * The DATA stays shared, which is the divergence that would actually matter: both surfaces read
 * through `auditLog.read`, both honour the same limit, and both report the same malformed and
 * multi-session facts. Only the presentation differs, because a card and a command line are not
 * the same medium.
 *
 * One record is ONE row, so a click maps to a record without a second lookup, and the columns are
 * measured across every record rather than the visible page so scrolling never shifts the text
 * sideways. The command is the widest and least predictable field, so it takes whatever is left
 * and is truncated; the selected record's command is then shown in full underneath, which is what
 * makes the truncation safe rather than lossy.
 */
class LogTablePane implements Component {
	constructor(
		private readonly records: readonly SecretExpansionRecord[],
		private readonly selectedIndex: number,
		private readonly scrollOffset: number,
		private readonly maxVisible: number,
		private readonly now: () => number,
		private readonly notices: readonly string[],
		/**
		 * Already-styled lines explaining a table with no rows, drawn above the notices.
		 *
		 * Styled by the caller rather than dimmed here, because an empty state is a headline and
		 * a way out, and the two have to read differently. The notices below it are one register:
		 * facts about the FILE, which is why they are all dim.
		 */
		private readonly emptyState: readonly string[] = [],
	) {}

	render(width: number): readonly string[] {
		if (this.records.length === 0) return [...this.emptyState, ...this.#noticeLines(width)];

		const now = this.now();
		const columns = logColumnWidths(this.records, now);
		const cursorWidth = visibleWidth(theme.nav.cursor) + 1;

		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.records.length);
		const header = theme.fg(
			"dim",
			padding(cursorWidth) +
				pad("WHEN", columns.when) +
				COLUMN_GAP +
				pad("TOOL", columns.tool) +
				COLUMN_GAP +
				pad("SECRETS", columns.secrets) +
				COLUMN_GAP +
				"WHERE",
		);

		const list = renderScrollableList(
			{ width, visibleRows: end - start, totalRows: this.records.length, scrollOffset: start },
			rowWidth => {
				const lines: string[] = [];
				for (let index = start; index < end; index++) {
					lines.push(this.#row(index, columns, rowWidth, now));
				}
				return lines;
			},
		);
		return [header, ...list, ...this.#detail(width), ...this.#noticeLines(width)];
	}

	/**
	 * The file notices, wrapped to the card rather than cut off at its edge.
	 *
	 * These lines carry the only thing the state can tell you: the PATH of an empty log, and the
	 * name of the setting that is switched off. Both used to run past the card's inner width and
	 * be truncated to a hard `…`, so an empty log said its file was at `/home/u/.veyyon/prof…`
	 * and the setting line stopped mid-word. A sentence whose payload is its tail cannot be
	 * ellipsised; it has to wrap.
	 */
	#noticeLines(width: number): readonly string[] {
		const body = Math.max(1, width - visibleWidth(NOTICE_INDENT));
		const lines: string[] = [];
		for (const notice of this.notices) {
			// A blank separator survives as its own row: `wrapTextWithAnsi` folds an empty string
			// away entirely, which would run the setting's explanation into the sentence above it.
			if (notice.length === 0) {
				lines.push("");
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(notice, body)) {
				lines.push(theme.fg("dim", `${NOTICE_INDENT}${wrapped}`));
			}
		}
		return lines;
	}

	#row(index: number, columns: { when: number; tool: number; secrets: number }, width: number, now: number): string {
		const record = this.records[index];
		const selected = index === this.selectedIndex;
		// A CURSOR GLYPH as well as a band, so the row a click landed on is identifiable on a
		// terminal rendering no colour. The secrets table above does the same in the same slot.
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : padding(visibleWidth(theme.nav.cursor));
		const content =
			`${cursor} ` +
			theme.fg("dim", pad(describeAgo(now - record.at), columns.when)) +
			COLUMN_GAP +
			theme.fg("muted", pad(record.tool, columns.tool)) +
			COLUMN_GAP +
			theme.fg("accent", pad(logSecretsCell(record), columns.secrets)) +
			COLUMN_GAP +
			theme.fg("dim", record.command);
		const padded = truncateToWidth(content, width) + padding(Math.max(0, width - visibleWidth(content)));
		return selected ? selectionBand(padded, width) : padded;
	}

	/**
	 * The selected record's command in full, under the table.
	 *
	 * The WHERE column has to truncate, and a log whose whole purpose is evidence cannot end at
	 * the right edge of a column. Two lines, because that is enough for a realistic command and a
	 * budget the table can spare; anything longer is in the file, which the notices name.
	 */
	#detail(width: number): readonly string[] {
		const record = this.records[this.selectedIndex];
		if (record === undefined) return [];
		const wrapped = wrapTextWithAnsi(record.command, Math.max(1, width - 4)).slice(0, 2);
		return ["", ...wrapped.map(line => theme.fg("muted", `  ${line}`))];
	}

	invalidate(): void {}
}

/**
 * The things worth saying about the log FILE rather than any one record.
 *
 * These are the parts of `renderLog` that are not rows, kept deliberately identical in substance
 * to the transcript the non-interactive `/secret log` prints: an empty log names its own path so
 * it reads as "nothing happened" and not "something failed", a log that several veyyon processes
 * share says so before an operator counts another window's uses as their own, and lines that could
 * not be parsed are said out loud, because a log that quietly drops what it cannot read is not
 * evidence of anything.
 */
function buildLogNotices(
	records: readonly SecretExpansionRecord[],
	options: { malformed: number; path: string },
): readonly string[] {
	// `~/...` rather than the absolute path. The log lives under the profile directory, so the
	// absolute form spends thirty-odd columns re-stating the operator's home directory before it
	// reaches the part that identifies the file, and this card is a full-screen surface people
	// screenshot. The non-interactive `/secret log` keeps the absolute path: it prints into a
	// scrollback you copy from, where the extra columns cost nothing.
	const shown = shortenPath(options.path);
	const notices: string[] = [];
	if (records.length === 0) notices.push(`No secret has been used yet. The log is ${shown}.`);
	const sessions = new Set(records.map(record => record.session).filter(session => session !== undefined));
	if (sessions.size > 1) notices.push(`These records come from ${sessions.size} sessions sharing this profile's log.`);
	if (options.malformed > 0) {
		notices.push(`${options.malformed} line(s) in ${shown} could not be read and are not shown.`);
	}
	return notices;
}

/**
 * The ONE thing the Log view says when it has no rows to draw.
 *
 * A NARROWED LOG THAT MATCHED NOTHING IS NOT AN EMPTY LOG, and the difference is the whole
 * question the view is being asked. `u` on a credential answers "what breaks if I revoke this",
 * and the answer "nothing, it has never been spent" was once drawn as a bare card carrying
 * `Showing 0 of 6 uses of #BACKUP_TOKEN#`, a sentence that states the opposite of what it means,
 * because the six are the whole log's uses and not that credential's.
 *
 * The four states are answered here, in one place, because answering them in two produced a card
 * that argued with itself. Pressing `u` on a never-spent credential while the log held nothing at
 * all stacked three lines: `#DEPLOY_KEY# has not been used yet.`, `Press escape to show every
 * recorded use.`, and the file notice `No secret has been used yet. The log is …`. The first two
 * are a narrowing's empty state and the third is the file's, both fired at once, and the middle
 * one offered to widen into a view with nothing in it either.
 *
 * 1. Records exist, none of them this credential's — say so, and name the key that widens, since
 *    widening genuinely reveals rows.
 * 2. The log holds NOTHING and the view is narrowed to a credential — no lines. The file notice
 *    already says nothing has ever been recorded and names the path, which is the whole payload
 *    of that state; repeating it per credential adds a second sentence and no second fact, and
 *    escape would widen onto the same emptiness.
 * 3. The log holds nothing and nothing is narrowed — no lines, for the same reason.
 * 4. A text search matched nothing — name the query and the keys that amend or clear it. Escape
 *    alone is not offered here: it clears the search, and with a credential narrowing still in
 *    force that may reveal nothing.
 */
function logEmptyState(state: {
	placeholder: string | undefined;
	query: string;
	records: number;
	visible: number;
}): readonly string[] {
	if (state.visible > 0 || state.records === 0) return [];
	const query = state.query.trim();
	const placeholder = state.placeholder;
	if (placeholder === undefined && query.length === 0) return [];
	// The finding and the way out are ONE sentence. Split across a headline and a guidance row with
	// a blank between them, they made a three-row paragraph out of "nothing matched", on a view
	// whose table is already empty; and the way out is four words.
	const headline =
		placeholder === undefined
			? `${NOTICE_INDENT}No recorded use matches "${query}". Escape clears the search.`
			: query.length === 0
				? `${NOTICE_INDENT}${placeholder} has not been used yet. Escape shows every use.`
				: `${NOTICE_INDENT}No use of ${placeholder} matches "${query}". Escape clears it.`;
	return [theme.fg("muted", headline)];
}

/**
 * Right-align a row's hover action, keeping the row exactly `width` wide.
 *
 * The label is painted in the error colour because the action it offers destroys a credential,
 * and it sits in a fixed-width slot at the right edge so the actions of every hovered row line up
 * with each other instead of chasing the length of the text beside them.
 */
function withRowAction(content: string, width: number): string {
	const prefixWidth = Math.max(0, width - ROW_ACTION_WIDTH);
	const prefix = truncateToWidth(content, prefixWidth);
	return `${prefix}${padding(Math.max(0, prefixWidth - visibleWidth(prefix)))} ${theme.fg("error", ROW_ACTION_LABEL)}`;
}

/**
 * Paint the matched slices of a cell so a search shows you WHY each row survived it.
 *
 * A filtered list with no highlighting makes you re-scan every row to find the substring you
 * typed, which is most of the work the filter was supposed to save. Spans arrive half-open,
 * ordered and non-overlapping from `shapeSecretRows`, so this walks them once and never has to
 * sort or merge. The unmatched runs keep the caller's own colour, which is what stops a search
 * from flattening the placeholder's bold and the scope's link colour into plain text.
 */
function highlight(text: string, spans: readonly MatchSpan[], plain: (part: string) => string): string {
	if (spans.length === 0) return plain(text);
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) out += plain(text.slice(cursor, span.start));
		out += theme.fg("accent", theme.bold(text.slice(span.start, span.end)));
		cursor = span.end;
	}
	if (cursor < text.length) out += plain(text.slice(cursor));
	return out;
}

/** The table, windowed through the shared ScrollView so a long vault scrolls like every list. */
class SecretTablePane implements Component {
	constructor(
		private readonly rows: readonly ShapedRow[],
		private readonly selectedIndex: number,
		private readonly hoveredIndex: number,
		private readonly scrollOffset: number,
		private readonly maxVisible: number,
		private readonly now: () => number,
		/** The active search text, so an empty table can say WHICH kind of empty it is. */
		private readonly query: string = "",
	) {}

	render(width: number): readonly string[] {
		if (this.rows.length === 0) return this.#emptyState();

		const now = this.now();
		const secrets: ScopedVaultEntry[] = [];
		for (const shaped of this.rows) if (shaped.row.kind === "secret") secrets.push(shaped.row.entry);
		// Measured over the WHOLE list rather than the visible page, so scrolling never shifts
		// the text sideways.
		const widest = (measure: (entry: ScopedVaultEntry) => string) =>
			secrets.reduce((widthSoFar, entry) => Math.max(widthSoFar, visibleWidth(measure(entry))), 0);
		const columns = {
			placeholder: Math.max(
				visibleWidth("PLACEHOLDER"),
				widest(entry => buildNamePlaceholder(entry.name)),
			),
			scope: Math.max(
				visibleWidth("SCOPE"),
				widest(entry => entry.scope),
			),
		};
		const cursorWidth = visibleWidth(theme.nav.cursor) + 1;

		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.rows.length);
		const header =
			secrets.length === 0
				? undefined
				: theme.fg(
						"dim",
						padding(cursorWidth) +
							"PLACEHOLDER".padEnd(columns.placeholder) +
							COLUMN_GAP +
							"SCOPE".padEnd(columns.scope) +
							COLUMN_GAP +
							"EXPIRES",
					);

		const list = renderScrollableList(
			{ width, visibleRows: end - start, totalRows: this.rows.length, scrollOffset: this.scrollOffset },
			rowWidth => {
				const lines: string[] = [];
				for (let index = start; index < end; index++) {
					lines.push(
						this.#row(
							this.rows[index],
							index === this.selectedIndex,
							index === this.hoveredIndex,
							columns,
							rowWidth,
							now,
						),
					);
				}
				return lines;
			},
		);
		return header === undefined ? list : [header, ...list];
	}

	/** `‹cursor› #NAME# ‹scope› ‹expires›`, or the repair line for a broken vault file. */
	#row(
		shaped: ShapedRow,
		selected: boolean,
		hovered: boolean,
		columns: { placeholder: number; scope: number },
		width: number,
		now: number,
	): string {
		// A CURSOR GLYPH, not only a selection colour, so the row the action keys will act on is
		// identifiable on a terminal that renders no colour at all. Every other selector in this
		// codebase draws the same glyph in the same leading slot.
		const cursor = selected ? theme.fg("accent", theme.nav.cursor) : padding(visibleWidth(theme.nav.cursor));
		const row = shaped.row;
		const content =
			row.kind === "broken"
				? `${cursor} ${theme.fg("error", `${row.scope} vault unreadable`)}  ${theme.fg("dim", "press d to move it aside")}`
				: this.#secretRow(cursor, row.entry, shaped, columns, now);
		const padded = truncateToWidth(content, width) + padding(Math.max(0, width - visibleWidth(content)));
		// HOVER REVEALS THE ACTION rather than painting a second band. A hover highlight that
		// looks like the selection highlight tells an operator two rows are current at once, and
		// the Agent Control Center already settled this the other way: the pointer uncovers the
		// one thing a click on that row would do. Here that is revoking the credential, which
		// still routes through the same confirm the `r` key does.
		const line = hovered && row.kind === "secret" ? withRowAction(content, width) : padded;
		return selected ? selectionBand(line, width) : line;
	}

	#secretRow(
		cursor: string,
		entry: ScopedVaultEntry,
		shaped: ShapedRow,
		columns: { placeholder: number; scope: number },
		now: number,
	): string {
		const placeholder = buildNamePlaceholder(entry.name);
		const left =
			highlight(placeholder, shaped.nameMatches, text => theme.bold(text)) +
			padding(Math.max(0, columns.placeholder - visibleWidth(placeholder)));
		const scope =
			highlight(entry.scope, shaped.scopeMatches, text => theme.fg("link", text)) +
			padding(Math.max(0, columns.scope - visibleWidth(entry.scope)));
		const left4 = describeTimeLeft(entry, now);
		// "expired" only reaches this list from a scope whose prune has not run yet, and an entry
		// still holding a spendable value is worth colouring differently from one with days left.
		const expires = theme.fg(left4 === "expired" ? "error" : "dim", left4);
		return `${cursor} ${left}${COLUMN_GAP}${scope}${COLUMN_GAP}${expires}`;
	}

	/**
	 * What the table says when it has no rows to draw.
	 *
	 * A FILTER THAT MATCHED NOTHING AND AN EMPTY VAULT ARE DIFFERENT ANSWERS. Showing the
	 * onboarding text to someone whose search simply missed would tell them their credentials
	 * were gone, which is the one wrong conclusion this card exists to prevent.
	 */
	#emptyState(): readonly string[] {
		if (this.query.trim().length > 0) {
			// The finding and the way out on one row: / changes the search and escape clears it, which
			// is a clause, not the second paragraph of a screen that has nothing else on it.
			return [theme.fg("muted", `  Nothing matches "${this.query.trim()}". / searches again, escape clears.`)];
		}
		return [
			theme.fg("muted", "  Nothing stored."),
			"",
			// Both sources named on the ONE screen that has nothing else to read, because they are
			// the same action with a different source and the footer offers a chip for each. One row:
			// the two keys and what the credential becomes are the whole of what this screen knows.
			theme.fg("dim", "  a stores a credential; f reads one out of $VAR. Spent as #NAME#."),
		];
	}

	invalidate(): void {}
}

export class SecretManager extends Container {
	/**
	 * Every row the vault holds, before the filter and the sort.
	 *
	 * The unnarrowed truth is kept separately from what the table shows so the tab count can say
	 * how many credentials you own while the table shows the handful you searched for. Collapsing
	 * the two would make a filter look like a vault that had lost entries.
	 */
	#rows: ManagerRow[] = [];
	/** What the table is showing: `#rows` narrowed by `#query` and ordered by `#sortKey`. */
	#shaped: readonly ShapedRow[] = [];
	/** The active search text. Empty means the table is showing everything. */
	#query = "";
	/**
	 * A credential just stored, so the next reshape can put the cursor on its row.
	 *
	 * Held as a NAME rather than an index because the row lands wherever the sort puts it, and read
	 * once: the confirmation for a store names keys that act on the selection, so the cursor has to
	 * be on the row that was written and not on whichever one it was on before.
	 */
	#selectName: string | undefined;
	#sortKey: SecretSortKey = "name";
	#direction: SortDirection = "asc";
	/** The add flow, present only while you are storing a new credential from inside the card. */
	#addFlow: SecretAddFlow | undefined;
	/** Whether the detail panel is open under the table for the selected credential. */
	#showDetail = false;
	/** The key map overlay, built once and re-pointed at the current view. */
	readonly #help = new SecretHelpOverlay("secrets");
	#selectedIndex = 0;
	#scrollOffset = 0;
	#view: ViewId = "secrets";
	/** The log's records, the notices about the file they came from, and the view's position in them. */
	#logRecords: readonly SecretExpansionRecord[] = [];
	/**
	 * The records the Log table is showing: `#logRecords` narrowed by `#logQuery`.
	 *
	 * Kept apart from the unnarrowed list for the same reason the roster is, and for one more: the
	 * detail panel joins usage against the FULL log. Counting uses from a filtered list would tell
	 * you a credential had been spent twice because that is how many times it matched your search.
	 */
	#logVisible: readonly SecretExpansionRecord[] = [];
	#logQuery = "";
	/**
	 * A single credential's placeholder, when the Log was opened by asking "where did this go?".
	 *
	 * Separate from the text search because the two compose: an operator narrows to one credential
	 * and then searches within its uses. Folding it into `#logQuery` would make clearing the search
	 * silently widen the view back to every credential.
	 */
	#logPlaceholder: string | undefined;
	#logNotices: readonly string[] = [];
	#logSelectedIndex = 0;
	#logScrollOffset = 0;
	/**
	 * Which secrets row the pointer is over, and where the tabs were painted.
	 *
	 * `-1` is "nowhere", and it is also the resting state: hover is feedback about a pointer that
	 * is present, so it has to be cleared when the pointer leaves the body rather than left
	 * showing the last row it crossed. The Log view has no per-row action to reveal, so it has no
	 * hover of its own; a click there selects, which is what moves the detail strip.
	 */
	#hoveredIndex = -1;
	#tabHits: Array<{ id: ViewId; start: number; end: number }> = [];
	/** Body rows drawn above the active table, so a click can be turned into a row index. */
	#tableRowOffset = TAB_STRIP_ROWS;
	#mode: ManagerMode = "list";
	#confirm: PendingConfirm | undefined;
	#prompt: PendingPrompt | undefined;

	/** Red line under the table: a refused action, a bad TTL, a failed refresh. */
	#error: string | undefined;
	/** Green line under the table: what the last action actually did. */
	#notice: string | undefined;
	/** Reason `load()` refused the whole vault, shown above the repair rows. */
	#loadFailure: string | undefined;

	#builtRows = -1;
	#builtCols = -1;
	#contentWidth = 80;
	#bodyBudget = 11;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;

	readonly #vault: SecretVault;
	readonly #refreshSecrets: (() => Promise<void>) | undefined;
	readonly #copy: (text: string) => Promise<void>;
	readonly #terminalHeight: number;
	readonly #now: () => number;
	readonly #auditLog: SecretAuditLog | undefined;
	readonly #readEnv: ((variable: string) => string | undefined) | undefined;
	readonly #input = new Input();
	#reveal = new ModalRevealDriver();

	/**
	 * Every asynchronous action, serialized.
	 *
	 * Two vault mutations must not interleave: `remove` and `rename` both read, transform and
	 * replace a scope, and a second one started from a keypress while the first is mid-flight
	 * would build its write from the state before that write landed. Chaining also gives tests
	 * one thing to await instead of guessing at microtask depth.
	 */
	#queue: Promise<void> = Promise.resolve();

	onClose?: () => void;
	onRequestRender?: () => void;

	constructor(deps: SecretManagerDeps) {
		super();
		this.#vault = deps.vault;
		this.#refreshSecrets = deps.refreshSecrets;
		this.#copy = deps.copy ?? copyToClipboard;
		this.#terminalHeight = deps.terminalHeight ?? process.stdout.rows ?? 24;
		this.#auditLog = deps.auditLog;
		this.#now = deps.now ?? (() => Date.now());
		this.#readEnv = deps.readEnv;
		this.#input.prompt = "> ";
		this.#input.setUseTerminalCursor(false);
		this.#input.onSubmit = value => this.#submitPrompt(value);
		this.#input.onEscape = () => this.#cancelPrompt();
		if (deps.reveal) this.#reveal.start(() => this.onRequestRender?.());
		this.#run(() => this.#reload());
		this.#run(() => this.#loadLog());
		this.#buildLayout();
	}

	/**
	 * Resolves when every action started so far has finished.
	 *
	 * The initial load is the first link, so a caller that awaits this once has a card whose
	 * rows are real rather than a card that is about to have rows.
	 */
	settled(): Promise<void> {
		return this.#queue;
	}

	/** The rows the card is showing, for the surfaces that ask what is in the vault. */
	get rowCount(): number {
		return this.#rows.length;
	}

	/** Expansion records the Log view is showing, for the surfaces that ask. */
	get logRecordCount(): number {
		return this.#logRecords.length;
	}

	/**
	 * Read the expansion log, or explain that nothing is being recorded.
	 *
	 * The RECORDS are kept, not a rendered string. `renderLog` writes the transcript the
	 * non-interactive `/secret log` prints, and reusing it here was what made this view a text
	 * dump inside a card. The card renders the same records as a table instead, and the facts that
	 * would actually be worth sharing between the two surfaces still are: the same `read` call, the
	 * same limit, and the same three notices below.
	 *
	 * `flush()` first, because this process queues its own records asynchronously: reading
	 * straight from disk showed an operator a log missing the expansion they had just watched
	 * happen.
	 */
	async #loadLog(): Promise<void> {
		const auditLog = this.#auditLog;
		if (auditLog === undefined) {
			this.#logRecords = [];
			this.#logNotices = AUDIT_DISABLED_LINES;
			this.#reshapeLog();
			return;
		}
		try {
			await auditLog.flush();
			const { records, malformed } = await auditLog.read({ limit: DEFAULT_LOG_LIMIT });
			this.#logRecords = records;
			this.#logNotices = buildLogNotices(records, { malformed, path: auditLog.path });
		} catch (error) {
			this.#logRecords = [];
			this.#logNotices = [`The expansion log could not be read: ${errorMessage(error)}`];
		}
		this.#reshapeLog();
	}

	/**
	 * Re-derive the Log table from the records and the search, and keep the cursor in range.
	 *
	 * The selection is clamped rather than preserved by identity, unlike the roster's. A log row is
	 * a past event with no action attached to it, so landing on a neighbour costs a glance; a
	 * roster row has `r` pointed at it, so landing on a neighbour costs a credential.
	 */
	#reshapeLog(): void {
		this.#logVisible = filterLogRecords({
			records: this.#logRecords,
			filter: { text: this.#logQuery, placeholder: this.#logPlaceholder },
		});
		const next = clampSelection(
			this.#logSelectedIndex,
			this.#logScrollOffset,
			this.#logVisible.length,
			this.#logRows(),
		);
		this.#logSelectedIndex = next.selectedIndex;
		this.#logScrollOffset = next.scrollOffset;
	}

	// ========================================================================
	// Loading
	// ========================================================================

	#run(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work).catch((error: unknown) => {
			this.#error = errorMessage(error);
			this.#rebuildAndRender();
		});
	}

	/**
	 * Recompute what the table shows from the vault, the filter and the sort.
	 *
	 * Called after anything that changes any of the three. The selection is kept on the ROW rather
	 * than the row number, the same rule `#reload` follows, because narrowing a list by typing
	 * moves every index: without this a search would silently walk the cursor onto a different
	 * credential, and the next `r` would revoke that one instead.
	 */
	#reshape(): void {
		const stored = this.#selectName;
		this.#selectName = undefined;
		const previous = this.#selectedRow();
		const key = stored === undefined ? this.#rowKey(previous) : `secret:${stored}`;
		this.#shaped = shapeSecretRows(this.#rows, {
			query: this.#query,
			sortKey: this.#sortKey,
			direction: this.#direction,
		});
		const kept = key === undefined ? -1 : this.#shaped.findIndex(shaped => this.#rowKey(shaped.row) === key);
		const next = clampSelection(
			kept >= 0 ? kept : this.#selectedIndex,
			this.#scrollOffset,
			this.#shaped.length,
			this.#listRows(),
		);
		this.#selectedIndex = next.selectedIndex;
		this.#scrollOffset = next.scrollOffset;
	}

	/** The row the cursor is on, indexing the SHAPED list because that is what the table drew. */
	#selectedRow(): ManagerRow | undefined {
		return this.#shaped[this.#selectedIndex]?.row;
	}

	/**
	 * Re-read the vault into rows, degrading a refusal into the repair state.
	 *
	 * `noteFailedLoad` is what turns "the whole vault refused" into the list of scopes that have
	 * a file to move aside, and it also marks them unreadable so the spend seam refuses their
	 * placeholders instead of passing `#NAME#` through as literal text.
	 */
	async #reload(): Promise<void> {
		try {
			const entries = await this.#vault.load();
			this.#loadFailure = undefined;
			this.#rows = [
				...entries.map(entry => ({ kind: "secret", entry }) as const),
				...this.#vault
					.unreadableScopes()
					.map(scope => ({ kind: "broken", scope, reason: PARTIAL_UNREADABLE_REASON }) as const),
			];
		} catch (error) {
			const reason = errorMessage(error);
			this.#loadFailure = reason;
			let scopes: readonly VaultScope[] = [];
			try {
				scopes = await this.#vault.noteFailedLoad(error);
			} catch {
				// The vault is already known to be broken; failing to enumerate which files exist
				// costs the `d` action, not the reason, which is rendered either way.
			}
			this.#rows = scopes.map(scope => ({ kind: "broken", scope, reason }) as const);
		}
		// `#reshape` re-derives what the table shows and keeps the cursor on the same row, so the
		// rule that revoking the entry above the selection must not move the cursor onto a
		// different credential holds whether the list changed because the vault did or because
		// you typed into the filter.
		this.#reshape();
		this.#rebuildAndRender();
	}

	#rowKey(row: ManagerRow | undefined): string | undefined {
		if (row === undefined) return undefined;
		return row.kind === "secret" ? `secret:${row.entry.name}` : `broken:${row.scope}`;
	}

	// ========================================================================
	// Actions
	// ========================================================================

	/**
	 * Apply a vault change, then bring the running session back in step with it.
	 *
	 * The refresh comes BEFORE the reload of the rows and its failure is reported rather than
	 * swallowed: the vault write is durable at that point, so a session still holding the old
	 * runtime is spending state the card has already changed, and only the operator can decide
	 * whether to keep working in that condition.
	 */
	async #mutate(action: () => Promise<string>): Promise<void> {
		this.#error = undefined;
		this.#notice = undefined;
		let outcome: string;
		try {
			outcome = await action();
		} catch (error) {
			this.#error = errorMessage(error);
			await this.#reload();
			return;
		}
		this.#notice = outcome;
		if (this.#refreshSecrets !== undefined) {
			try {
				await this.#refreshSecrets();
			} catch (error) {
				this.#error =
					`The vault was updated, but the running session could not refresh secret protection: ` +
					`${errorMessage(error)}`;
			}
		}
		await this.#reload();
	}

	/** `r`: ask before revoking, then remove the entry by name. */
	#requestRevoke(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		const name = row.entry.name;
		const placeholder = buildNamePlaceholder(name);
		this.#openConfirm({
			title: "Revoke this secret?",
			body: [
				`${theme.bold(placeholder)}  ${theme.fg("muted", `${row.entry.scope} · ${describeTimeLeft(row.entry, this.#now())}`)}`,
				"",
				theme.fg("warning", `The value is deleted for good and ${placeholder} stops expanding.`),
			],
			confirmLabel: "enter yes, revoke",
			run: async () => {
				const scope = await this.#vault.remove(name);
				if (scope === null) throw new Error(`${placeholder} is no longer in the vault, so nothing was revoked.`);
				return `Revoked ${placeholder} from the ${scope} vault.`;
			},
		});
	}

	/** `e`: read a lifetime, refuse an unparseable one on the card, then push the expiry out. */
	#requestExtend(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		const name = row.entry.name;
		const placeholder = buildNamePlaceholder(name);
		this.#openPrompt(
			{
				title: `New lifetime for ${placeholder}`,
				hint: 'A number followed by m, h, d or w (30m, 12h, 7d, 2w), or "never".',
				submit: async value => {
					// `parseTtl` throws rather than defaulting, which is the point: `7dd` quietly
					// becoming one day is how a credential outlives the window its owner chose. The
					// throw lands on the card and the field stays open.
					const ttl = parseTtl(value.trim());
					const extended = await this.#vault.extend(name, ttl);
					if (extended === null) {
						throw new Error(`${placeholder} is no longer in the vault, so its lifetime was not changed.`);
					}
					return `${placeholder} now ${describeTimeLeft(extended, this.#now())}.`;
				},
			},
			"",
		);
	}

	/**
	 * `v`: replace the selected credential's value, keeping everything else.
	 *
	 * The card could rename, extend, move, copy and revoke a credential, and could not CORRECT one.
	 * A token pasted with a character missing, or rotated at the provider, had to be revoked and
	 * stored again, which mints a new name while every prompt in the session still spends the old
	 * placeholder. The field is masked for the same reason the add field is, and the notice says the
	 * expiry was kept, because that is the difference between this and storing it again.
	 */
	#requestValueReplace(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		const name = row.entry.name;
		const placeholder = buildNamePlaceholder(name);
		this.#openPrompt(
			{
				title: `New value for ${placeholder}`,
				hint: "The corrected credential. The name, the scope and the expiry stay.",
				credential: true as const,
				submit: async value => {
					const replaced = await this.#vault.replaceValue(name, value);
					if (replaced === null) {
						throw new Error(`${placeholder} is no longer in the vault, so its value was not replaced.`);
					}
					return `${placeholder} now spends the new value, still ${describeTimeLeft(replaced, this.#now())}.`;
				},
			},
			"",
		);
	}

	/** `n`: rename in place. A collision is refused by the vault and shown here. */
	#requestRename(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		const name = row.entry.name;
		this.#openPrompt(
			{
				title: `Rename ${buildNamePlaceholder(name)}`,
				hint: "Letters, digits, spaces, dashes and underscores. The value is kept.",
				submit: async value => {
					const renamed = await this.#vault.rename(name, value.trim());
					if (renamed === null) {
						throw new Error(`${buildNamePlaceholder(name)} is no longer in the vault, so it was not renamed.`);
					}
					return `Renamed to ${buildNamePlaceholder(renamed.name)} in the ${renamed.scope} vault.`;
				},
			},
			// Prefilled with the current name, because a rename is usually an edit of what is
			// there rather than a name typed from nothing.
			name,
		);
	}

	/** `c`: put the PLACEHOLDER on the clipboard. Never the value. */
	#copySelected(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		const placeholder = buildNamePlaceholder(row.entry.name);
		this.#run(async () => {
			this.#error = undefined;
			this.#notice = undefined;
			try {
				await this.#copy(placeholder);
				this.#notice = `Copied ${placeholder}. Paste it into a prompt and the value is substituted at the tool call.`;
			} catch (error) {
				this.#error = `Could not copy ${placeholder}: ${errorMessage(error)}`;
			}
			this.#rebuildAndRender();
		});
	}

	/** `d`: move an unreadable vault file aside so its scope can be used again. */
	#requestDiscard(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "broken") return;
		const scope = row.scope;
		this.#openConfirm({
			title: `Discard the ${scope} vault file?`,
			body: [
				theme.fg("error", row.reason),
				"",
				theme.fg("warning", "The file is MOVED aside, not deleted, and the path is reported here."),
			],
			confirmLabel: "enter yes, move it aside",
			run: async () => {
				const { movedTo } = await this.#vault.discardUnreadableScope(scope);
				return `Moved the ${scope} vault to ${movedTo}.`;
			},
		});
	}

	/**
	 * `a` and `f`: store a new credential without leaving the card.
	 *
	 * The flow asks for the VALUE and nothing else. The credential is stored the moment it is known,
	 * under a name the vault invents, in {@link DEFAULT_ADD_SCOPE}: `n` renames the row it lands as
	 * and `m` moves it, so the two questions this used to ask are one keystroke each afterwards, on
	 * an entry that exists. Asking them first is also what once stored the literal string
	 * `GITHUB_TOKEN` as a live credential, because a masked field opened before any value was given
	 * reads as a request for the name.
	 *
	 * `f` answers that one question with an environment variable instead, which is the only entry
	 * form where the credential never reaches the screen or the input buffer. One function for both,
	 * with the source as an argument, because everything after the field is identical.
	 */
	#startAdd(source: AddFlowSource = "paste"): void {
		this.#addFlow = new SecretAddFlow({ source, ...(this.#readEnv ? { readEnv: this.#readEnv } : {}) });
		// The first field is opened through the queue so `settled()` covers it, the same way every
		// later field is opened from inside the previous field's submit.
		this.#run(() => this.#advanceAdd());
	}

	/**
	 * Show the add flow's field, or store the credential once it has been answered.
	 *
	 * THE STORED ROW IS SELECTED and any filter is cleared, because the confirmation points at `n`
	 * and `m` and both act on the selection. Leaving the cursor where it was would name keys that
	 * rename and move a different credential, and a search that the generated name does not match
	 * would hide the row the operator was just told about.
	 *
	 * The confirmation SAYS WHERE THE VALUE CAME FROM when it came from the environment. It is the
	 * only entry form whose value the operator never saw, so naming the variable is the one chance to
	 * catch having read the wrong one before the credential is spent under a placeholder.
	 */
	async #advanceAdd(): Promise<void> {
		const flow = this.#addFlow;
		if (flow === undefined) return;
		const field = flow.field;
		if (field === undefined) {
			const plan = flow.plan;
			this.#addFlow = undefined;
			if (plan === undefined) return;
			// AWAITED HERE rather than handed to `#run`. This already runs inside the queued chain
			// that the last field's submit belongs to, and a nested `#run` would append to the
			// queue behind the promise currently executing, landing the write after the caller's
			// `settled()` had already resolved.
			await this.#mutate(async () => {
				const stored = await this.#vault.add({ value: plan.value, scope: DEFAULT_ADD_SCOPE });
				this.#selectName = stored.name;
				this.#query = "";
				const source = plan.fromEnv === undefined ? "" : ` from $${plan.fromEnv}`;
				// ONE ROW at the card's width, which is why it is this terse: a notice that wraps
				// pushes the table down and reads as an error rather than a receipt.
				return `Stored ${buildNamePlaceholder(stored.name)}${source} in ${DEFAULT_ADD_SCOPE}. n renames, m moves.`;
			});
			return;
		}
		this.#openPrompt(
			{
				title: field.title,
				hint: field.hint,
				// Only the value field hides what is typed. A variable NAME is not a credential and
				// has to be read back, so the env field is drawn.
				...(field.masked ? { credential: true as const } : {}),
				submit: async input => {
					flow.submit(input);
					const refusal = flow.refusal;
					// Thrown rather than returned, because `#submitPrompt` treats a throw as "keep
					// the field open and show why", which is what a refused step needs.
					if (refusal !== null) throw new Error(refusal);
					return "";
				},
				after: () => this.#advanceAdd(),
			},
			"",
		);
	}

	/**
	 * `m`: move the selected credential to another scope.
	 *
	 * The move is PLANNED before anything runs, because it is an add followed by a remove and
	 * discovering the collision after the remove would already have destroyed the credential.
	 */
	#requestScopeMove(): void {
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		const entry = row.entry;
		this.#run(async () => {
			// `loadEverywhere`, NOT the rows on screen and NOT `load`. Both of those collapse a
			// repeated name to its narrowest holder, so the entry that would collide in the
			// destination is precisely the one they drop. Planning against either makes the
			// collision undetectable and turns the refusal below into dead code.
			const existing = await this.#vault.loadEverywhere();
			const to = nextScope(entry.scope);
			const { plan, refusal } = planScopeMove(entry, to, existing);
			if (plan === null) {
				this.#error = refusal ?? "That move is not possible.";
				this.#notice = undefined;
				this.#rebuildAndRender();
				return;
			}
			this.#openMove(entry, plan);
		});
	}

	/** The confirmation for a planned move, held until the operator says yes. */
	#openMove(entry: ScopedVaultEntry, plan: ScopeMovePlan): void {
		this.#openConfirm({
			title: `Move ${buildNamePlaceholder(plan.name)} to the ${plan.to} vault?`,
			body: [describeScopeMove(plan)],
			confirmLabel: "enter yes, move it",
			run: async () => {
				// `add` takes a lifetime measured from now, while the entry carries an absolute
				// expiry, so the remaining time is converted rather than passed through. Handing it
				// the absolute timestamp would give the moved copy a lifetime of decades.
				const ttl = entry.expiresAt === null ? null : Math.max(1, entry.expiresAt - this.#now());
				await this.#vault.add({ name: plan.name, value: entry.value, scope: plan.to, ttl });
				// Removal is restricted to the SOURCE scope. An unrestricted remove searches
				// narrowest first, so moving into a narrower scope would delete the copy just
				// written and leave the original where it was.
				await this.#vault.remove(plan.name, plan.from);
				return `Moved ${buildNamePlaceholder(plan.name)} from the ${plan.from} vault to the ${plan.to} vault.`;
			},
		});
	}

	/** `s`: walk the sort columns, keeping the cursor on the credential it was already on. */
	#cycleSort(): void {
		this.#sortKey = nextSortKey(this.#sortKey);
		this.#reshape();
		this.#rebuildAndRender();
	}

	/**
	 * `/`: narrow the table by typing.
	 *
	 * The field opens SEEDED with the current search so an existing one can be amended rather than
	 * retyped. That is also why escape clears it instead of abandoning the edit: with a seeded
	 * field, backspacing to nothing would otherwise be the only way to see the whole vault again,
	 * and escape would silently leave the old search in force.
	 */
	#startFilter(): void {
		this.#openPrompt(
			{
				title: "Search stored credentials",
				hint: "Matches the placeholder and the scope. Escape clears it.",
				submit: async value => {
					this.#setQuery(value);
					return value.trim().length === 0 ? "Showing every stored credential." : "";
				},
				cancel: () => this.#setQuery(""),
			},
			this.#query,
		);
	}

	/** Apply a search and re-derive the table, keeping the cursor on the credential it was on. */
	#setQuery(value: string): void {
		this.#query = value;
		this.#reshape();
	}

	/**
	 * `u` on a credential: open the Log showing only where THAT credential was spent.
	 *
	 * The question this answers is the one an operator asks right before revoking something: what
	 * breaks if this stops working. Answering it by hand meant reading the whole log and matching
	 * placeholders by eye, which is exactly the work that gets skipped under pressure.
	 *
	 * The restriction is set alongside any text search rather than replacing it, and the Log's
	 * notice line names the credential, so the view can never be narrowed in a way the operator
	 * cannot see.
	 */
	#traceSelectedUses(): void {
		// `#selectedRow()` and NOT `#rows[selectedIndex]`: the cursor indexes the SHAPED list, which
		// is the sorted and filtered one the table actually painted. Reading the raw list traced a
		// credential the operator was not pointing at, and said nothing to reveal the mismatch.
		const row = this.#selectedRow();
		if (row?.kind !== "secret") return;
		this.#logPlaceholder = buildNamePlaceholder(row.entry.name);
		this.#view = "log";
		this.#logSelectedIndex = 0;
		this.#logScrollOffset = 0;
		this.#reshapeLog();
		this.#rebuildAndRender();
	}

	/**
	 * `/` in the Log view: narrow the expansion records by tool or by command.
	 *
	 * A separate search from the roster's, held separately, because the two views answer different
	 * questions and share only a key. Carrying one query across the tab switch would silently
	 * narrow the view you had just arrived at, using text you typed about something else.
	 */
	#startLogFilter(): void {
		this.#openPrompt(
			{
				title: "Search the expansion log",
				hint: "Matches the tool and the command. Escape clears it.",
				submit: async value => {
					this.#setLogQuery(value);
					return value.trim().length === 0 ? "Showing every recorded use." : "";
				},
				cancel: () => this.#setLogQuery(""),
			},
			this.#logQuery,
		);
	}

	/** Apply a log search and re-derive the Log table. */
	#setLogQuery(value: string): void {
		this.#logQuery = value;
		this.#reshapeLog();
	}

	/** `?`: the full key map, because the footer can only carry the first few actions. */
	#toggleHelp(): void {
		this.#mode = this.#mode === "help" ? "list" : "help";
		this.#help.setView(this.#view);
		this.#rebuildAndRender();
	}

	// ========================================================================
	// Confirm and prompt
	// ========================================================================

	#openConfirm(confirm: PendingConfirm): void {
		this.#error = undefined;
		this.#notice = undefined;
		this.#confirm = confirm;
		this.#mode = "confirm";
		this.#rebuildAndRender();
	}

	#resolveConfirm(accepted: boolean): void {
		const confirm = this.#confirm;
		this.#confirm = undefined;
		this.#mode = "list";
		if (!accepted || confirm === undefined) {
			this.#rebuildAndRender();
			return;
		}
		this.#run(() => this.#mutate(confirm.run));
	}

	#openPrompt(prompt: PendingPrompt, initialValue: string): void {
		this.#error = undefined;
		this.#notice = undefined;
		this.#prompt = prompt;
		this.#mode = "prompt";
		this.#input.setValue(initialValue);
		// Set every time rather than only when true. A credential field followed by a name field
		// reuses this one Input, and a mode left on from the previous step would mask the name and
		// keep the operator from reading what they are about to store under.
		this.#input.credentialMode = prompt.credential === true;
		// NOT `focused = true`. The field already draws its own reverse-video cursor because
		// `setUseTerminalCursor(false)` is set; marking it focused would ALSO emit the hardware
		// cursor marker and put two cursors in one field.
		this.#rebuildAndRender();
	}

	#cancelPrompt(): void {
		const prompt = this.#prompt;
		this.#prompt = undefined;
		// An abandoned multi-step flow is dropped whole. Keeping it would leave a half-collected
		// credential in memory that the next `a` would resume from the middle of.
		this.#addFlow = undefined;
		prompt?.cancel?.();
		this.#input.setValue("");
		this.#mode = "list";
		this.#rebuildAndRender();
	}

	/**
	 * Apply a typed answer, keeping the field open when it is refused.
	 *
	 * A refused TTL or a name that collides must not cost the operator the card: closing on
	 * failure hides the reason behind the surface that produced it and makes the fix a second
	 * round trip through the list.
	 */
	#submitPrompt(value: string): void {
		const prompt = this.#prompt;
		if (prompt === undefined) return;
		this.#run(async () => {
			this.#error = undefined;
			this.#notice = undefined;
			let outcome: string;
			try {
				outcome = await prompt.submit(value);
			} catch (error) {
				this.#error = errorMessage(error);
				this.#rebuildAndRender();
				return;
			}
			this.#prompt = undefined;
			this.#input.setValue("");
			this.#mode = "list";
			await this.#mutate(async () => outcome);
			// A multi-step flow opens its NEXT field here: inside the same queued chain, after this
			// field has finished closing, and AWAITED. Opening it from within `submit` would have
			// the cleanup above tear straight back down. Opening it from a microtask, or through a
			// second `#run`, would put it outside the promise `settled()` already handed out, so a
			// caller that awaited the flow would see the vault before the credential reached it.
			await prompt.after?.();
		});
	}

	// ========================================================================
	// Layout
	// ========================================================================

	#terminalRows(): number {
		return process.stdout.rows || this.#terminalHeight || 24;
	}

	/**
	 * Body rows the list may draw, after the chrome this card puts above and below it.
	 *
	 * The detail panel is charged its worst case (`DETAIL_PANE_ROWS`) rather than its actual
	 * height, which varies with what is known about the credential. Charging the actual height
	 * would mean the table grew by two rows the moment you selected an unused secret, and the
	 * rows under the cursor would shift as you arrowed down the list.
	 */
	#listRows(): number {
		const chrome =
			TAB_STRIP_ROWS +
			1 +
			(this.#loadFailure ? 3 : 0) +
			(this.#error ? 2 : 0) +
			(this.#notice ? 2 : 0) +
			(this.#statusLine() === undefined ? 0 : 2) +
			(this.#showDetail ? DETAIL_PANE_ROWS + 1 : 0);
		return Math.max(1, this.#bodyBudget - chrome);
	}

	/**
	 * The line under the table saying how the list is narrowed and ordered.
	 *
	 * A FILTERED LIST THAT DOES NOT ANNOUNCE ITSELF is how you conclude a credential was never
	 * stored when it is simply three characters outside your search. The sort is named alongside
	 * it because the two are changed by adjacent keys and a table that silently reordered would
	 * otherwise read as rows appearing and disappearing.
	 */
	#statusLine(): string | undefined {
		const filtered = this.#query.trim().length > 0;
		if (!filtered && this.#sortKey === "name" && this.#direction === "asc") return undefined;
		const sort = describeSort(this.#sortKey, this.#direction);
		if (!filtered) return sort;
		return `Showing ${this.#shaped.length} of ${this.#rows.length} matching "${this.#query.trim()}", ${sort}.`;
	}

	/** Body rows the Log view may draw, after the tab strip above it. */
	#logRows(): number {
		return Math.max(1, this.#bodyBudget - TAB_STRIP_ROWS);
	}

	#currentShortcuts(): readonly ModalShortcut[] {
		if (this.#mode === "prompt") return PROMPT_SHORTCUTS;
		if (this.#mode === "help") return [{ label: "esc back", clickable: true, id: "close" }];
		if (this.#mode === "confirm") {
			return [
				{ label: "esc dismiss", clickable: true, id: "close" },
				{ label: this.#confirm?.confirmLabel ?? "enter confirm", clickable: true, id: "confirm" },
			];
		}
		if (this.#view === "log") {
			return logShortcuts({ records: this.#logRecords.length, visible: this.#logVisible.length });
		}
		return secretShortcuts(this.#selectedRow());
	}

	/**
	 * The view strip, styled by the SHARED overlay tab theme rather than a local pair of colours,
	 * so this card and every other tabbed overlay agree on what an active tab looks like.
	 *
	 * The Log count is the RECORD count, and one record is one row, so the strip and the body it
	 * labels agree by construction. With
	 * recording off the count is replaced by `off`, because a zero there reads as "nothing has
	 * been used", which is the one conclusion that state cannot support.
	 */
	#renderTabBar(): string {
		const tabTheme = getTabBarTheme();
		// COUNTS SECRETS, NOT ROWS. An unreadable scope occupies a row too, so a vault that refused
		// wholesale rendered `Secrets (3)` above a body saying nothing was available: the tab was
		// counting the three repair rows. Three files to fix is not three credentials to spend.
		const secretCount = this.#rows.reduce((total, row) => (row.kind === "secret" ? total + 1 : total), 0);
		const tabs: ReadonlyArray<{ id: ViewId; text: string }> = [
			{ id: "secrets", text: `Secrets (${secretCount})` },
			{ id: "log", text: `Log (${this.#auditLog === undefined ? "off" : this.#logRecords.length})` },
		];
		const parts = [" "];
		// The hit spans are recorded HERE, off the same labels being drawn, rather than recomputed
		// from the counts at click time. A tab that is clickable somewhere other than where it is
		// painted is worse than one that is not clickable at all, and the two only stay aligned by
		// coming from one loop.
		this.#tabHits = [];
		let col = 1;
		for (const tab of tabs) {
			const active = tab.id === this.#view;
			const label = active ? `[${tab.text}]` : ` ${tab.text} `;
			const width = visibleWidth(label);
			this.#tabHits.push({ id: tab.id, start: col, end: col + width - 1 });
			col += width;
			parts.push(active ? tabTheme.activeTab(label) : tabTheme.inactiveTab(label));
		}
		return parts.join("");
	}

	#switchView(direction: 1 | -1): void {
		const index = VIEW_ORDER.indexOf(this.#view);
		this.#view = VIEW_ORDER[(index + direction + VIEW_ORDER.length) % VIEW_ORDER.length];
		this.#error = undefined;
		this.#notice = undefined;
		// Re-read on every switch. The log belongs to the PROFILE, so other veyyon processes
		// append to it while this card is open, and a snapshot taken when the card opened would
		// quietly age into a partial record of what has been spent.
		if (this.#view === "log") this.#run(() => this.#loadLog());
		this.#rebuildAndRender();
	}

	#title(): string {
		if (this.#mode === "confirm") return this.#confirm?.title ?? "Confirm";
		if (this.#mode === "prompt") return this.#prompt?.title ?? "Secret Manager";
		return "Secret Manager";
	}

	#rebuildAndRender(): void {
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#buildLayout(): void {
		this.clear();
		if (this.#mode === "confirm" && this.#confirm !== undefined) {
			for (const line of this.#confirm.body) {
				// A blank separator survives as a row of its own: `wrapTextWithAnsi` folds an empty
				// string away entirely, which ran the warning straight into the heading above it.
				if (line.length === 0) this.addChild(new Spacer(1));
				else
					for (const wrapped of wrapTextWithAnsi(line, this.#contentWidth)) this.addChild(new Text(wrapped, 0, 0));
			}
			this.#builtRows = this.#terminalRows();
			this.#builtCols = this.#contentWidth;
			return;
		}

		if (this.#mode === "help") {
			// Same trap as the confirm body above, and the key map is where it showed: `Text` folds
			// an empty string to zero rows, so the blank {@link SecretHelpOverlay} puts between the
			// view's own keys and the shared ones vanished, and `Anywhere in the card` landed
			// directly under the last key of the group before it. Padding the string does not help
			// — `Text` trims before it measures.
			for (const line of this.#help.render(this.#contentWidth)) {
				this.addChild(line.length === 0 ? new Spacer(1) : new Text(line, 0, 0));
			}
			this.#builtRows = this.#terminalRows();
			this.#builtCols = this.#contentWidth;
			return;
		}

		if (this.#mode === "prompt" && this.#prompt !== undefined) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("dim", this.#prompt.hint), this.#contentWidth)) {
				this.addChild(new Text(wrapped, 0, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(this.#input);
			if (this.#error) {
				this.addChild(new Spacer(1));
				for (const wrapped of wrapTextWithAnsi(theme.fg("error", this.#error), this.#contentWidth)) {
					this.addChild(new Text(wrapped, 0, 0));
				}
			}
			this.#builtRows = this.#terminalRows();
			this.#builtCols = this.#contentWidth;
			return;
		}

		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		if (this.#view === "log") {
			this.#tableRowOffset = TAB_STRIP_ROWS;
			// The narrowing notice is prepended to the file's own notices rather than drawn under
			// the table, because a Log view narrowed to nothing has no table to draw it under, and
			// that is exactly the state where "your search hid these" has to be legible.
			//
			// It is REPLACED, not joined, once the narrowing left no rows at all. `describeLogFilter`
			// counts the whole log against what survived, so at zero rows it reads "Showing 0 of 6
			// uses of #BACKUP_TOKEN#": a sentence that asserts six uses of the credential the card
			// has just found none of. `logEmptyState` says the finding instead.
			//
			// A LOG THAT RECORDED NOTHING GETS NEITHER. Both lines describe a narrowing of records
			// that exist, and against an empty file they invent them: the counting line becomes
			// "Showing 0 of 0 uses of #DEPLOY_KEY#" and the empty state offers an escape that
			// widens onto the same nothing. The file notice below already names the state and the
			// path, and it is the only line in that card that carries a fact.
			const empty = logEmptyState({
				placeholder: this.#logPlaceholder,
				query: this.#logQuery,
				records: this.#logRecords.length,
				visible: this.#logVisible.length,
			});
			const narrowed =
				empty.length > 0 || this.#logRecords.length === 0
					? undefined
					: describeLogFilter(
							{ text: this.#logQuery, placeholder: this.#logPlaceholder },
							this.#logVisible.length,
							this.#logRecords.length,
						);
			this.addChild(
				new LogTablePane(
					this.#logVisible,
					this.#logSelectedIndex,
					this.#logScrollOffset,
					this.#logRows(),
					this.#now,
					narrowed === undefined ? this.#logNotices : [narrowed, ...this.#logNotices],
					empty,
				),
			);
			this.#builtRows = this.#terminalRows();
			this.#builtCols = this.#contentWidth;
			return;
		}

		// COUNTED WHILE BUILDING, not recomputed at click time. The failure banner is wrapped text
		// whose height depends on the terminal width, so a click handler that re-derived it would
		// be one rewrap away from selecting the wrong row on exactly the vaults that are already
		// broken.
		let rowsBeforeTable = TAB_STRIP_ROWS;
		if (this.#loadFailure) {
			for (const wrapped of wrapTextWithAnsi(
				theme.fg(
					"error",
					`Your vault could not be read, so nothing stored is available to this session: ${this.#loadFailure}`,
				),
				this.#contentWidth,
			)) {
				this.addChild(new Text(wrapped, 0, 0));
				rowsBeforeTable++;
			}
			this.addChild(new Spacer(1));
			rowsBeforeTable++;
		}
		this.#tableRowOffset = rowsBeforeTable;

		this.addChild(
			new SecretTablePane(
				this.#shaped,
				this.#selectedIndex,
				this.#hoveredIndex,
				this.#scrollOffset,
				this.#listRows(),
				this.#now,
				this.#query,
			),
		);

		const status = this.#statusLine();
		if (status !== undefined) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", truncateToWidth(status, this.#contentWidth)), 0, 0));
		}

		const detailRow = this.#showDetail ? this.#selectedRow() : undefined;
		if (detailRow !== undefined) {
			this.addChild(new Spacer(1));
			this.addChild(
				new SecretDetailPane(
					detailRow,
					detailRow.kind === "secret"
						? usageStatsFor(buildNamePlaceholder(detailRow.entry.name), this.#logRecords)
						: { useCount: 0, lastUsedAt: null, tools: [] },
					this.#now,
				),
			);
		}

		if (this.#error) {
			this.addChild(new Spacer(1));
			for (const wrapped of wrapTextWithAnsi(theme.fg("error", this.#error), this.#contentWidth)) {
				this.addChild(new Text(wrapped, 0, 0));
			}
		}
		if (this.#notice) {
			this.addChild(new Spacer(1));
			for (const wrapped of wrapTextWithAnsi(theme.fg("success", this.#notice), this.#contentWidth)) {
				this.addChild(new Text(wrapped, 0, 0));
			}
		}

		this.#builtRows = this.#terminalRows();
		this.#builtCols = this.#contentWidth;
	}

	/**
	 * Columns the card's content asks for, before the terminal has a say.
	 *
	 * MEASURED ACROSS BOTH VIEWS, ALWAYS, and over the WHOLE vault and the WHOLE log rather than
	 * what the current narrowing left. Sizing to the view in front of you makes left/right resize
	 * the card under the cursor, and sizing to the filter makes it breathe in and out while you
	 * type into the search field; both are worse than the columns they would save.
	 *
	 * THE KEY MAP IS MEASURED ONLY WHILE IT IS SHOWING, which is the one place a surface is allowed
	 * to set the width on its own. `?` replaces the entire body — there is no roster underneath to
	 * resize out from under — so charging every resting card for the widest line in a table it is
	 * not drawing would widen the roster for nothing. It has to be measured at all, because
	 * {@link SecretHelpOverlay} cuts a line that does not fit and appends no ellipsis, so a card
	 * too narrow for it amputates the description of every key in silence.
	 */
	#naturalContentWidth(): number {
		const cursorWidth = visibleWidth(theme.nav.cursor) + 1;
		const gap = visibleWidth(COLUMN_GAP);
		const now = this.#now();

		let placeholder = visibleWidth("PLACEHOLDER");
		let scope = visibleWidth("SCOPE");
		let expires = visibleWidth("EXPIRES");
		for (const row of this.#rows) {
			if (row.kind !== "secret") continue;
			placeholder = Math.max(placeholder, visibleWidth(buildNamePlaceholder(row.entry.name)));
			scope = Math.max(scope, visibleWidth(row.entry.scope));
			expires = Math.max(expires, visibleWidth(describeTimeLeft(row.entry, now)));
		}
		// ROW_ACTION_WIDTH is part of the roster's width, not an extra: a pointer resting on a row
		// uncovers `[x]` in that slot, and a card measured without it eats the expiry on hover.
		let natural = cursorWidth + placeholder + gap + scope + gap + expires + ROW_ACTION_WIDTH;

		if (this.#logRecords.length > 0) {
			const columns = logColumnWidths(this.#logRecords, now);
			const where = Math.min(columns.command, LOG_WHERE_MAX_COLS);
			const logWidth = cursorWidth + columns.when + gap + columns.tool + gap + columns.secrets + gap + where;
			natural = Math.max(natural, logWidth);
		}

		// The file notices twice over. A notice is prose, so its SENTENCE is asked for up to the
		// prose measure and wrapped past it; but the longest UNBREAKABLE run inside it is asked for
		// outright, because that run is always a path and a card too narrow for one does not wrap
		// it — it hard-breaks it mid-directory, and the path is the entire payload of an empty log.
		const indent = visibleWidth(NOTICE_INDENT);
		for (const notice of this.#logNotices) {
			natural = Math.max(natural, Math.min(indent + visibleWidth(notice), PROSE_MAX_COLS));
			for (const word of notice.split(" ")) natural = Math.max(natural, indent + visibleWidth(word));
		}

		if (this.#mode === "help") {
			for (const line of this.#help.render(HELP_MEASURE_COLS)) natural = Math.max(natural, visibleWidth(line));
		}
		return natural;
	}

	override render(width: number): readonly string[] {
		// Laid out against the WHOLE terminal, not against the card's own height, so the shell
		// has slack to centre the card in rather than pinning it to the top of the screen.
		const area = this.#terminalRows();
		const padded = sizingForArea(MANAGER_SIZING, area);
		// Resolved AFTER the compact decision, because the columns the border and the horizontal
		// padding take are part of the card width being asked for, and the compact path pays for
		// one column of padding a side rather than two. This inverts the content width
		// `computeModalDims` derives, which is the one place the two have to agree.
		const natural = this.#naturalContentWidth() + 2 * (1 + Math.max(1, padded.hPad));
		const dims = computeModalDims(width, area, { ...padded, maxWidth: Math.min(padded.maxWidth, natural) });
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: area }, () => padding(width));
		}

		this.#contentWidth = dims.contentWidth;
		const shortcuts = this.#currentShortcuts();
		// RESERVE THE ROWS THE CHIPS TAKE, not a flat two. The Log's footer is one row of chips, so
		// the second reserved row was painted empty between the chips and the bottom border on
		// every state of this card that is not the full Secrets footer. `layoutShortcutRows` is the
		// same wrap the shell will perform, asked one step early now that the width is known.
		const sizing: ModalSizing = {
			...padded,
			maxWidth: Math.min(padded.maxWidth, natural),
			footerLines: Math.max(1, layoutShortcutRows(shortcuts, dims.contentWidth, this.#hoveredShortcutId).length),
		};
		this.#bodyBudget = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		}).maxBodyRows;
		if (area !== this.#builtRows || dims.contentWidth !== this.#builtCols) this.#buildLayout();

		const body = super.render(dims.contentWidth);
		const shell = renderModalShell({
			title: this.#title(),
			sizing,
			areaWidth: width,
			areaHeight: area,
			body,
			preferredBodyRows: body.length,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	// ========================================================================
	// Input
	// ========================================================================

	#moveSelection(delta: number): void {
		if (this.#shaped.length === 0) return;
		const next = clampSelection(
			clampLow(this.#selectedIndex + delta, 0, this.#shaped.length - 1),
			this.#scrollOffset,
			this.#shaped.length,
			this.#listRows(),
		);
		this.#selectedIndex = next.selectedIndex;
		this.#scrollOffset = next.scrollOffset;
		this.#rebuildAndRender();
	}

	/**
	 * Move the log's SELECTION, scrolling only as far as following it requires.
	 *
	 * The view used to scroll a block of text, which is why nothing in it could be acted on: there
	 * was no "current" record to act on. Rows are records now, so the same keys that walk the
	 * secrets table walk this one, and the selected record is the one whose command is shown in
	 * full underneath.
	 */
	#moveLogSelection(delta: number): void {
		const next = clampSelection(
			this.#logSelectedIndex + delta,
			this.#logScrollOffset,
			this.#logVisible.length,
			this.#logRows(),
		);
		this.#logSelectedIndex = next.selectedIndex;
		this.#logScrollOffset = next.scrollOffset;
		this.#rebuildAndRender();
	}

	/**
	 * Turn a pointer position inside the card's body into a tab switch, a row selection, or hover.
	 *
	 * Returns whether the event belonged to the body, so the caller can fall through to the chrome
	 * for everything else. A motion event that lands outside the rows CLEARS the hover rather than
	 * ignoring it: a stale highlight on a row the pointer has left is a lie about where a click
	 * would go.
	 */
	#routeBody(row: number, col: number, leftClick: boolean, motion: boolean): boolean {
		const geometry = this.#shellGeometry;
		if (geometry === null) return false;
		const bodyCol = geometry.cardColStart + CARD_BODY_COL_INSET;
		const withinBody = col >= bodyCol && col < bodyCol + this.#contentWidth;

		if (row === geometry.bodyRowStart && withinBody) {
			if (!leftClick) return true;
			const relative = col - bodyCol;
			const tab = this.#tabHits.find(hit => relative >= hit.start && relative <= hit.end);
			if (tab !== undefined && tab.id !== this.#view) this.#switchView(1);
			return true;
		}

		const index = withinBody ? this.#rowIndexAt(row, geometry.bodyRowStart) : -1;
		if (motion && !leftClick) {
			this.#setHoveredIndex(this.#view === "secrets" ? index : -1);
			return index !== -1;
		}
		if (!leftClick || index === -1) return false;
		if (this.#view === "log") {
			this.#logSelectedIndex = index;
			this.#rebuildAndRender();
			return true;
		}
		// A click on the revealed action revokes; a click anywhere else on the row selects it.
		// Selecting first either way, so the confirm names the row the pointer is actually on.
		this.#selectedIndex = index;
		if (col >= bodyCol + this.#contentWidth - ROW_ACTION_WIDTH) this.#requestRevoke();
		else this.#rebuildAndRender();
		return true;
	}

	/**
	 * Which row of the active table a screen row lands on, or `-1`.
	 *
	 * Built from the offset the render pass recorded plus the column heading, so it cannot drift
	 * from what was painted, and bounded by the records actually on screen so a click below the
	 * last row selects nothing rather than the nearest thing.
	 */
	#rowIndexAt(row: number, bodyRowStart: number): number {
		const inLog = this.#view === "log";
		const total = inLog ? this.#logVisible.length : this.#shaped.length;
		if (total === 0) return -1;
		const headerRows = inLog ? 1 : this.#shaped.some(shaped => shaped.row.kind === "secret") ? 1 : 0;
		const first = bodyRowStart + this.#tableRowOffset + headerRows;
		const offset = inLog ? this.#logScrollOffset : this.#scrollOffset;
		const visible = Math.min(inLog ? this.#logRows() : this.#listRows(), total - offset);
		if (row < first || row >= first + visible) return -1;
		return offset + (row - first);
	}

	#setHoveredIndex(index: number): void {
		if (this.#hoveredIndex === index) return;
		this.#hoveredIndex = index;
		this.#rebuildAndRender();
	}

	/**
	 * Route the pointer: the body's tabs and rows first, then the footer chips and shell chrome.
	 *
	 * BODY BEFORE CHROME, because the chrome hit test answers "outside the card" with dismiss, and
	 * the body is inside it. Every target here is derived from geometry the render pass recorded,
	 * never from a second guess at the layout.
	 */
	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			if (event.wheel !== null && this.#mode === "list") {
				if (this.#view === "log") this.#moveLogSelection(event.wheel);
				else this.#moveSelection(event.wheel);
				return true;
			}
			if (this.#mode === "list" && this.#routeBody(event.row, event.col, event.leftClick, event.motion)) {
				return true;
			}
			const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
				motion: event.motion,
				leftClick: event.leftClick,
			});
			if (chrome.kind === "hover-shortcut") {
				if (this.#hoveredShortcutId !== chrome.id) {
					this.#hoveredShortcutId = chrome.id;
					this.onRequestRender?.();
				}
				return true;
			}
			if (
				chrome.kind === "close" ||
				chrome.kind === "outside" ||
				(chrome.kind === "shortcut" && chrome.id === "close")
			) {
				this.#dismiss();
				return true;
			}
			if (chrome.kind !== "shortcut") return true;
			switch (chrome.id) {
				case "confirm":
					if (this.#mode === "confirm") this.#resolveConfirm(true);
					else if (this.#mode === "prompt") this.#submitPrompt(this.#input.getValue());
					break;
				// Card-level, so it is the one chip that acts with no row selected. That is also the
				// state it matters most in: an empty vault has nothing else to click.
				case "add":
					this.#startAdd();
					break;
				case "add-from-env":
					this.#startAdd("env");
					break;
				case "copy":
					this.#copySelected();
					break;
				case "extend":
					this.#requestExtend();
					break;
				case "rename":
					this.#requestRename();
					break;
				case "revoke":
					this.#requestRevoke();
					break;
				case "discard":
					this.#requestDiscard();
					break;
				case "uses":
					this.#traceSelectedUses();
					break;
				// View-aware, because the two searches are separate state and a chip carries no view.
				case "search":
					if (this.#view === "log") this.#startLogFilter();
					else this.#startFilter();
					break;
				case "help":
					this.#toggleHelp();
					break;
			}
			return true;
		});
	}

	/** Escape and the close glyph mean "back one level", not "close the card", inside a sub-view. */
	#dismiss(): void {
		if (this.#mode === "help") {
			this.#mode = "list";
			this.#rebuildAndRender();
			return;
		}
		if (this.#mode === "confirm") {
			this.#resolveConfirm(false);
			return;
		}
		if (this.#mode === "prompt") {
			this.#cancelPrompt();
			return;
		}
		// A narrowed view is a level of its own. Closing the card straight out of one would drop the
		// operator back to a session with no sign that the list they were reading showed a subset,
		// and reopening the card would show everything as if nothing had been asked. Escape unwinds
		// the narrowing first, then closes.
		//
		// This holds for the roster exactly as it does for the Log. It once applied only to the Log,
		// so a search in the roster made Escape close the whole card while the status line was still
		// telling the operator that escape clears the search.
		// The Log can be narrowed twice over: restricted to one credential's uses by `u`, and then
		// searched within that. Escape peels ONE layer per press, text search first, because the two
		// were asked for separately and in that order. Dropping both at once loses a restriction the
		// operator never cancelled, and leaves the next press closing a card they expected to be
		// stepping back through.
		if (this.#view === "log" && this.#logQuery !== "") {
			this.#setLogQuery("");
			this.#rebuildAndRender();
			return;
		}
		if (this.#view === "log" && this.#logPlaceholder !== undefined) {
			this.#logPlaceholder = undefined;
			this.#reshapeLog();
			this.#rebuildAndRender();
			return;
		}
		if (this.#view === "secrets" && this.#query !== "") {
			this.#setQuery("");
			this.#rebuildAndRender();
			return;
		}
		this.onClose?.();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		if (this.#mode === "prompt") {
			// The field owns every other key, including its own Escape and Enter, so a credential
			// pasted into it cannot be read as a shortcut by the card underneath.
			this.#input.handleInput(data);
			return;
		}

		if (matchesSelectCancel(data) || matchesKey(data, "ctrl+c") || matchesAppInterrupt(data)) {
			this.#dismiss();
			return;
		}

		if (this.#mode === "confirm") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") this.#resolveConfirm(true);
			return;
		}

		// The key map is a reading surface: every other key is swallowed so a stray press cannot
		// act on a credential the operator cannot currently see.
		if (this.#mode === "help") {
			if (data === "?") this.#toggleHelp();
			return;
		}

		if (handleTabSwitchKey(data, direction => this.#switchView(direction))) return;

		if (this.#view === "log") {
			if (matchesSelectUp(data) || data === "k") this.#moveLogSelection(-1);
			else if (matchesSelectDown(data) || data === "j") this.#moveLogSelection(1);
			else if (matchesSelectPageUp(data)) this.#moveLogSelection(-Math.max(1, this.#logRows()));
			else if (matchesSelectPageDown(data)) this.#moveLogSelection(Math.max(1, this.#logRows()));
			else if (data === "/") this.#startLogFilter();
			else if (data === "?") this.#toggleHelp();
			else if (data === "q") this.onClose?.();
			return;
		}

		if (matchesSelectUp(data) || data === "k") {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || data === "j") {
			this.#moveSelection(1);
			return;
		}
		if (matchesSelectPageUp(data)) {
			this.#moveSelection(-Math.max(1, this.#listRows()));
			return;
		}
		if (matchesSelectPageDown(data)) {
			this.#moveSelection(Math.max(1, this.#listRows()));
			return;
		}

		switch (data) {
			case "q":
				this.onClose?.();
				return;
			case "r":
				this.#requestRevoke();
				return;
			case "e":
				this.#requestExtend();
				return;
			case "n":
				this.#requestRename();
				return;
			case "v":
				this.#requestValueReplace();
				return;
			case "c":
				this.#copySelected();
				return;
			case "d":
				this.#requestDiscard();
				return;
			case "a":
				this.#startAdd();
				return;
			case "f":
				this.#startAdd("env");
				return;
			case "m":
				this.#requestScopeMove();
				return;
			case "i":
				this.#showDetail = !this.#showDetail;
				this.#rebuildAndRender();
				return;
			case "s":
				this.#cycleSort();
				return;
			case "u":
				this.#traceSelectedUses();
				return;
			case "/":
				this.#startFilter();
				return;
			case "?":
				this.#toggleHelp();
				return;
		}
	}
}
