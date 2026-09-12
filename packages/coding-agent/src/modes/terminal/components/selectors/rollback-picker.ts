/**
 * Choose a version to run.
 *
 * `veyyon rollback --list` and `veyyon rollback <version>` are complete and
 * scriptable, and they are still a bad way to make this particular choice: you
 * read a list in one command, decide, and retype a number into another, with
 * nothing in front of you saying what changed in each one. The decision is a
 * browse, so it gets a picker.
 *
 * Three things make the list usable rather than merely present:
 *
 *   - MARKERS. A bare column of version numbers has no anchor. Every row says
 *     whether it is the one running now, whether choosing it moves forward
 *     rather than back, and whether this machine has been on it before, which is
 *     usually the row somebody is looking for.
 *   - SEARCH. Typing filters, because a project with a long release history
 *     produces a list nobody scrolls through.
 *   - THE CHANGELOG, per row. "Which version do I want" is really "what changed
 *     in each of these", so a keypress opens that version's notes rather than
 *     making you leave and reconstruct the URL.
 *
 * The rows come from `buildRollbackRows`, which the CLI's `--list` also renders.
 * One owner for what a row MEANS, two renderers for how it looks: the picker
 * cannot drift into marking "current" differently from the text listing.
 */
import type { SelectItem } from "@veyyon/tui";
import { type RollbackRow, rollbackMarkers, rollbackPublishedDate, type UrlOpener } from "../../../../cli/rollback-cli";
import { getSelectListTheme } from "../../../../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/** The keypress that opens the highlighted version's changelog. */
export const CHANGELOG_KEY = "c";

/**
 * The right column for one version.
 *
 * Deliberately not a sentence: it is scanned down a column, so it reads as a
 * short list of facts. Both the date and the markers come from the row model's
 * owners rather than being recomputed here, so the picker and `rollback --list`
 * cannot drift into disagreeing about which version is current.
 */
export function describeRollbackRow(row: RollbackRow): string {
	return [rollbackPublishedDate(row.publishedAt), ...rollbackMarkers(row)].filter(part => part.length > 0).join(" · ");
}

/**
 * Rows as the list shows them.
 *
 * The running version stays IN the list and is marked, rather than being
 * filtered out. Removing it would make the list unanchored again, and a person
 * looking for where they are would read its absence as the version having been
 * unpublished.
 */
export function rollbackSelectItems(rows: readonly RollbackRow[]): SelectItem[] {
	return rows.map(row => ({
		value: row.version,
		label: row.version,
		description: describeRollbackRow(row),
		// Match the query against the VERSION only. The description carries a
		// date, and a date is made of the same digits a version query is: matched
		// against both, "1.1" hit every row published in a month containing a 1,
		// and the filter looked broken.
		filterText: row.version,
	}));
}

export interface RollbackPickerCallbacks {
	/** Called with the chosen version. Never called with the running one. */
	onSelect: (version: string) => void;
	onCancel: () => void;
	/** Opens a URL in the operator's browser; in a session, the mode context's opener. */
	openUrl: UrlOpener;
}

export class RollbackPickerComponent extends ModalSelectWrapper {
	#rows: readonly RollbackRow[];
	#callbacks: RollbackPickerCallbacks;

	constructor(rows: readonly RollbackRow[], callbacks: RollbackPickerCallbacks) {
		const currentIndex = Math.max(
			0,
			rows.findIndex(row => row.current),
		);
		super(
			new ModalSelectListComponent(
				{
					title: "Version · takes effect on restart",
					items: rollbackSelectItems(rows),
					theme: getSelectListTheme(),
					selectedIndex: currentIndex,
					maxVisible: Math.min(12, Math.max(5, rows.length)),
					layout: { minPrimaryColumnWidth: 10, maxPrimaryColumnWidth: 14 },
					tipCandidates: [
						`Tip · ${CHANGELOG_KEY} opens this version's changelog`,
						"Tip · Type to filter, Esc cancel",
					],
				},
				{
					onSelect: item => {
						if (rows.find(row => row.version === item.value)?.current) {
							callbacks.onCancel();
							return;
						}
						callbacks.onSelect(item.value);
					},
					onCancel: callbacks.onCancel,
				},
			),
		);
		this.#rows = rows;
		this.#callbacks = callbacks;
	}

	/** The row under the cursor, or null when a filter has emptied the list. */
	selectedRow(): RollbackRow | null {
		const value = this.inner.getSelectList().getSelectedItem()?.value;
		return this.#rows.find(row => row.version === value) ?? null;
	}

	override handleInput(data: string): void {
		// Intercepted before the list sees it, because the list treats a printable
		// character as a filter keystroke; without this, `c` would silently start
		// filtering instead of opening the changelog.
		if (data === CHANGELOG_KEY) {
			const row = this.selectedRow();
			if (row) this.#callbacks.openUrl(row.changelogUrl);
			return;
		}
		this.inner.handleInput(data);
	}
}
