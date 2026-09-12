import type { SelectItem } from "@veyyon/tui";
import { getSelectListTheme } from "../../../../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/**
 * Queue-mode picker — floating ModalShell medium card.
 */
export class QueueModeSelectorComponent extends ModalSelectWrapper {
	constructor(
		currentMode: "all" | "one-at-a-time",
		onSelect: (mode: "all" | "one-at-a-time") => void,
		onCancel: () => void,
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
		super(
			new ModalSelectListComponent(
				{
					title: "Queue Mode",
					items: queueModes,
					theme: getSelectListTheme(),
					selectedIndex: currentIndex,
					maxVisible: 2,
				},
				{
					onSelect: item => onSelect(item.value as "all" | "one-at-a-time"),
					onCancel,
				},
			),
		);
	}
}
