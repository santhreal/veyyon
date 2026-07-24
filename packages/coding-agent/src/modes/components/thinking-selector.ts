import type { Effort } from "@veyyon/ai";
import type { SelectItem, SgrMouseEvent } from "@veyyon/tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata } from "../../thinking";
import { ModalSelectListComponent } from "./modal-select-list";

/**
 * Thinking-level picker — floating ModalShell medium card.
 */
export class ThinkingSelectorComponent {
	#inner: ModalSelectListComponent;

	constructor(
		currentLevel: Effort,
		availableLevels: Effort[],
		onSelect: (level: Effort) => void,
		onCancel: () => void,
		reveal?: boolean,
	) {
		const thinkingLevels: SelectItem[] = availableLevels.map(getThinkingLevelMetadata);
		const currentIndex = thinkingLevels.findIndex(item => item.value === currentLevel);
		this.#inner = new ModalSelectListComponent(
			{
				title: "Thinking",
				items: thinkingLevels,
				theme: getSelectListTheme(),
				selectedIndex: currentIndex,
				maxVisible: thinkingLevels.length,
				reveal,
			},
			{
				onSelect: item => onSelect(item.value as Effort),
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
