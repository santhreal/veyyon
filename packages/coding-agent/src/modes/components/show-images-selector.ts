import type { SelectItem, SgrMouseEvent } from "@veyyon/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";

/**
 * Show-images picker — floating ModalShell medium card.
 */
export class ShowImagesSelectorComponent {
	#inner: ModalSelectListComponent;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];
		this.#inner = new ModalSelectListComponent(
			{
				title: "Show Images",
				items,
				theme: getSelectListTheme(),
				selectedIndex: currentValue ? 0 : 1,
				maxVisible: 5,
			},
			{
				onSelect: item => onSelect(item.value === "yes"),
				onCancel,
			},
		);
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

	handleInput(data: string): void {
		this.#inner.handleInput(data);
	}

	render(width: number): string[] {
		return this.#inner.render(width);
	}

	invalidate(): void {
		this.#inner.invalidate();
	}
}
