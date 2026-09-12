import type { SelectItem } from "@veyyon/tui";
import type { SubcommandDef } from "../../../../slash-commands/types";
import { getSelectListTheme } from "../../../../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/**
 * The card a bare `/cmd` opens when the command has subcommands.
 *
 * It is a thin wrapper over {@link ModalSelectListComponent}, the same shape `theme-selector.ts`
 * and `queue-mode-selector.ts` take: the modal already owns arrow keys, escape, the wheel, hover,
 * and click-to-select, so the only thing left here is turning `SubcommandDef`s into rows. A picker
 * that reimplemented any of that would be a second answer to a question the modal already answers.
 *
 * It never runs anything. It hands back the chosen `SubcommandDef` and the caller dispatches the
 * subcommand through the ordinary command path, so the picker is a way in and not a second
 * implementation of eight handlers.
 */
export class SubcommandPickerComponent extends ModalSelectWrapper {
	constructor(
		commandName: string,
		subcommands: readonly SubcommandDef[],
		onSelect: (subcommand: SubcommandDef) => void,
		onCancel: () => void,
	) {
		// The argument shape goes in the LABEL, not in `hint`: `SelectItem.hint` only feeds the
		// fuzzy filter, nothing paints it, so a usage put there would be invisible on the row it
		// describes. The label then reads `switch [provider]`, which is also what gets typed.
		const items: SelectItem[] = subcommands.map(sub => ({
			value: sub.name,
			label: sub.usage ? `${sub.name} ${sub.usage}` : sub.name,
			description: sub.description,
		}));
		super(
			new ModalSelectListComponent(
				{
					title: `/${commandName}`,
					items,
					theme: getSelectListTheme(),
					// The name column is sized to the names. Left at its default it took a third of the
					// card for a six-letter verb and truncated the description that says what the verb
					// does, which is the same dead end as not listing the subcommand at all.
					layout: { maxPrimaryColumnWidth: 22 },
				},
				{
					onSelect: item => {
						const chosen = subcommands.find(sub => sub.name === item.value);
						if (chosen) onSelect(chosen);
					},
					onCancel,
				},
			),
		);
	}
}
