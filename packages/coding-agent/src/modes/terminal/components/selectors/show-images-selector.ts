import type { SelectItem } from "@veyyon/tui";
import { getSelectListTheme } from "../../../../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/**
 * Show-images picker — floating ModalShell medium card.
 */
export class ShowImagesSelectorComponent extends ModalSelectWrapper {
	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];
		super(
			new ModalSelectListComponent(
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
			),
		);
	}
}
