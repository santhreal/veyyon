import type { SelectItem, SgrMouseEvent } from "@veyyon/tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";

/**
 * Theme picker — floating ModalShell medium card (replaces DynamicBorder sandwich).
 */
export class ThemeSelectorComponent {
	#inner: ModalSelectListComponent;

	constructor(
		currentTheme: string,
		themes: string[],
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
		reveal?: boolean,
	) {
		const themeItems: SelectItem[] = themes.map(name => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));
		const currentIndex = themes.indexOf(currentTheme);
		this.#inner = new ModalSelectListComponent(
			{
				title: "Theme",
				items: themeItems,
				theme: getSelectListTheme(),
				selectedIndex: currentIndex,
				maxVisible: 10,
				tipCandidates: ["Tip · Themes apply live as you move", "Tip · Esc cancel"],
				reveal,
			},
			{
				onSelect: item => onSelect(item.value),
				onCancel,
				onSelectionChange: item => onPreview(item.value),
			},
		);
	}

	setOnRequestRender(cb: () => void): void {
		this.#inner.setOnRequestRender(cb);
	}

	getSelectList() {
		return this.#inner.getSelectList();
	}

	/** @deprecated Prefer fullscreen ModalShell mouse; kept for editor-slot hosts. */
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
