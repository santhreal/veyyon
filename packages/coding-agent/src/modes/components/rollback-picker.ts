import type { SgrMouseEvent } from "@veyyon/tui";
import type { RollbackRow } from "../../cli/rollback-cli";
import { getSelectListTheme } from "../../modes/theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import type { RollbackPickerCallbacks } from "./rollback-picker-helpers";
import { CHANGELOG_KEY, rollbackSelectItems } from "./rollback-picker-helpers";

export { describeRollbackRow } from "./rollback-picker-helpers";
export { CHANGELOG_KEY, rollbackSelectItems };

export class RollbackPickerComponent {
	#inner: ModalSelectListComponent;
	#rows: readonly RollbackRow[];
	#callbacks: RollbackPickerCallbacks;

	constructor(rows: readonly RollbackRow[], callbacks: RollbackPickerCallbacks) {
		this.#rows = rows;
		this.#callbacks = callbacks;
		const currentIndex = Math.max(
			0,
			rows.findIndex(row => row.current),
		);
		this.#inner = new ModalSelectListComponent(
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
				onSelect: item => this.#choose(item.value),
				onCancel: callbacks.onCancel,
			},
		);
	}

	#choose(version: string): void {
		if (this.#rows.find(row => row.version === version)?.current) {
			this.#callbacks.onCancel();
			return;
		}
		this.#callbacks.onSelect(version);
	}

	selectedRow(): RollbackRow | null {
		const value = this.#inner.getSelectList().getSelectedItem()?.value;
		return this.#rows.find(row => row.version === value) ?? null;
	}

	handleInput(data: string): void {
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
