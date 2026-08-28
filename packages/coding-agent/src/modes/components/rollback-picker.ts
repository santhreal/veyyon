/** Choose a version to run. `veyyon rollback --list` and `veyyon rollback <version>` are complete and */
import type { SelectItem, SgrMouseEvent } from "@veyyon/tui";
import { type RollbackRow, rollbackMarkers, rollbackPublishedDate, type UrlOpener } from "../../cli/rollback-cli";
import { getSelectListTheme } from "../../modes/theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";

/** The keypress that opens the highlighted version's changelog. */
export const CHANGELOG_KEY = "c";

/** The right column for one version. Deliberately not a sentence: it is scanned down a column, so it reads as a */
export function describeRollbackRow(row: RollbackRow): string {
	return [rollbackPublishedDate(row.publishedAt), ...rollbackMarkers(row)].filter(part => part.length > 0).join(" · ");
}

/** Rows as the list shows them. The running version stays IN the list and is marked, rather than being */
export function rollbackSelectItems(rows: readonly RollbackRow[]): SelectItem[] {
	return rows.map(row => ({
		value: row.version,
		label: row.version,
		description: describeRollbackRow(row),
		// Match the query against the VERSION only. The description carries a date, and a date is made of the same digits a version query is: matched
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

export class RollbackPickerComponent {
	#inner: ModalSelectListComponent;
	#rows: readonly RollbackRow[];
	#callbacks: RollbackPickerCallbacks;

	constructor(rows: readonly RollbackRow[], callbacks: RollbackPickerCallbacks) {
		this.#rows = rows;
		this.#callbacks = callbacks;
		// Open on the running version, so the list starts where the reader is and
		// the neighbours above and below are the versions they are choosing between.
		const currentIndex = Math.max(
			0,
			rows.findIndex(row => row.current),
		);
		this.#inner = new ModalSelectListComponent(
			{
				// The restart caveat lives in the TITLE rather than among the tips, because the tips rotate: a caveat you see one launch in three is
				title: "Version · takes effect on restart",
				items: rollbackSelectItems(rows),
				theme: getSelectListTheme(),
				selectedIndex: currentIndex,
				// Sized to the list rather than pinned at 12, matching the modal's own default rule, so a short history scrolls only when it has to. Note
				maxVisible: Math.min(12, Math.max(5, rows.length)),
				// Versions are short, and the default 32-cell primary column would
				// leave the card too narrow for a description — dropping the markers
				// that are the whole reason each row is readable.
				layout: { minPrimaryColumnWidth: 10, maxPrimaryColumnWidth: 14 },
				tipCandidates: [
					`Tip · ${CHANGELOG_KEY} opens this version's changelog`,
					"Tip · Type to filter, Esc cancel",
				],
			},
			{
				onSelect: item => this.#choose(item.value),
				onCancel: callbacks.onCancel,
			},
		);
	}

	/** Selecting the running version is a no-op, not a reinstall. `rollbackToVersion` refuses it too, and refusing in both places is */
	#choose(version: string): void {
		if (this.#rows.find(row => row.version === version)?.current) {
			this.#callbacks.onCancel();
			return;
		}
		this.#callbacks.onSelect(version);
	}

	/** The row under the cursor, or null when a filter has emptied the list. */
	selectedRow(): RollbackRow | null {
		const value = this.#inner.getSelectList().getSelectedItem()?.value;
		return this.#rows.find(row => row.version === value) ?? null;
	}

	handleInput(data: string): void {
		// Intercepted before the list sees it, because the list treats a printable
		// character as a filter keystroke; without this, `c` would silently start
		// filtering instead of opening the changelog.
		if (data === CHANGELOG_KEY) {
			const row = this.selectedRow();
			if (row) this.#callbacks.openUrl(row.changelogUrl);
			return;
		}
		this.#inner.handleInput(data);
	}

	setOnRequestRender(cb: () => void): void {
		this.#inner.setOnRequestRender(cb);
	}

	getSelectList() {
		return this.#inner.getSelectList();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#inner.getSelectList().routeMouse(event, line - 1, col);
	}

	render(width: number): string[] {
		return this.#inner.render(width);
	}

	invalidate(): void {
		this.#inner.invalidate();
	}
}
