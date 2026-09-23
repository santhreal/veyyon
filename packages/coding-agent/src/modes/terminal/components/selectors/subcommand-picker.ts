import type { SelectItem, SelectListTruncatePrimaryContext } from "@veyyon/tui";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import type { SubcommandDef } from "../../../../slash-commands/types";
import { getSelectListTheme } from "../../../../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";
import { ModalSelectWrapper } from "./select-list-mouse-routing";

/** Cells between the name column and the description, as `SelectList` lays it out. */
const NAME_COLUMN_GAP = 2;

/**
 * A usage cut short at a word, never inside one.
 *
 * `add <name> [http|sse` reads as a malformed usage; `add <name> …` reads as one with more
 * arguments than the row holds. The cut falls after the subcommand name at the latest, since the
 * name is what gets typed.
 */
function truncateUsageAtToken({ text, maxWidth }: SelectListTruncatePrimaryContext): string {
	if (visibleWidth(text) <= maxWidth) return text;
	const head = truncateToWidth(text, maxWidth - 1, "");
	const cut = head.lastIndexOf(" ");
	return cut > 0 ? `${head.slice(0, cut)} …` : truncateToWidth(text, maxWidth);
}

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
					// The name column is as wide as the widest usage, so `reset [openai-codex|anthropic]`
					// shows whole; the card widens to hold it and the descriptions beside it. A usage cut
					// mid-token read as a malformed command.
					layout: {
						maxPrimaryColumnWidth:
							items.reduce((widest, item) => Math.max(widest, visibleWidth(item.label)), 0) + NAME_COLUMN_GAP,
						truncatePrimary: truncateUsageAtToken,
					},
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
