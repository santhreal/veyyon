import type { SelectItem } from "@veyyon/tui";
import { getSelectListTheme } from "../../../../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/**
 * Theme picker — floating ModalShell medium card (replaces DynamicBorder sandwich).
 */
export class ThemeSelectorComponent extends ModalSelectWrapper {
	constructor(
		currentTheme: string,
		themes: string[],
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		const themeItems: SelectItem[] = themes.map(name => ({
			value: name,
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));
		const currentIndex = themes.indexOf(currentTheme);
		super(
			new ModalSelectListComponent(
				{
					title: "Theme",
					items: themeItems,
					theme: getSelectListTheme(),
					selectedIndex: currentIndex,
					maxVisible: 10,
					tipCandidates: ["Tip · Themes apply live as you move", "Tip · Esc cancel"],
				},
				{
					onSelect: item => onSelect(item.value),
					onCancel,
					onSelectionChange: item => onPreview(item.value),
				},
			),
		);
	}
}
