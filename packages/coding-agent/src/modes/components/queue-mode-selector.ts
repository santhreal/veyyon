import type { SelectItem, SgrMouseEvent } from "@veyyon/tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";

/**
 * Queue-mode picker — floating ModalShell medium card.
 */
export class QueueModeSelectorComponent {
	#inner: ModalSelectListComponent;

	constructor(
		currentMode: "all" | "one-at-a-time",
		onSelect: (mode: "all" | "one-at-a-time") => void,
		onCancel: () => void,
		reveal?: boolean,
	) {
		const queueModes: SelectItem[] = [
			{
				value: "one-at-a-time",
				label: "one-at-a-time",
				description: "Process queued messages one by one (recommended)",
			},
			{ value: "all", label: "all", description: "Process all queued messages at once" },
		];
		const currentIndex = queueModes.findIndex(item => item.value === currentMode);
		this.#inner = new ModalSelectListComponent(
			{
				title: "Queue Mode",
				items: queueModes,
				theme: getSelectListTheme(),
				selectedIndex: currentIndex,
				maxVisible: 2,
				reveal,
			},
			{
				onSelect: item => onSelect(item.value as "all" | "one-at-a-time"),
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
