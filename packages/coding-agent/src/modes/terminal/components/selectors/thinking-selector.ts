import type { Model } from "@veyyon/ai";
import type { SelectItem } from "@veyyon/tui";
import { getSelectListTheme } from "../../../../theme/theme";
import { type ConfiguredThinkingLevel, configuredThinkingLevelOptions } from "../../../../thinking";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/**
 * Thinking-level picker — floating ModalShell medium card.
 */
export class ThinkingSelectorComponent extends ModalSelectWrapper {
	constructor(
		currentLevel: ConfiguredThinkingLevel | undefined,
		model: Model,
		onSelect: (level: ConfiguredThinkingLevel | undefined) => void,
		onCancel: () => void,
	) {
		const thinkingLevels: SelectItem[] = configuredThinkingLevelOptions({
			model,
			inheritLabel: "Default",
			inheritDescription: "Use the saved model effort, then the model default",
		}).map(option => ({ ...option }));
		const currentIndex = thinkingLevels.findIndex(item => item.value === (currentLevel ?? ""));
		super(
			new ModalSelectListComponent(
				{
					title: "Thinking",
					items: thinkingLevels,
					theme: getSelectListTheme(),
					selectedIndex: currentIndex,
					maxVisible: thinkingLevels.length,
				},
				{
					onSelect: item => onSelect(item.value ? (item.value as ConfiguredThinkingLevel) : undefined),
					onCancel,
				},
			),
		);
	}
}
