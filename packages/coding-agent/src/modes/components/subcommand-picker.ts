import type { SelectItem, SgrMouseEvent } from "@veyyon/tui";
import type { SubcommandDef } from "../../slash-commands/types";
import { getSelectListTheme } from "../theme/theme";
import { ModalSelectListComponent } from "./modal-select-list";

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
export class SubcommandPickerComponent {
	#inner: ModalSelectListComponent;

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
		this.#inner = new ModalSelectListComponent(
			{
				title: `/${commandName}`,
				items,
				theme: getSelectListTheme(),
				// No column literal. `maxPrimaryColumnWidth: 22` alone did not cap the
				// column, it PINNED it: the list defaulted its floor to whatever cap it
				// was given, so every subcommand card put exactly 22 cells between the
				// verb and its description — `/session`'s `info` sat twenty-two columns
				// from `Show session info and stats` — and any usage longer than that
				// was cut to fit, which is where `use <provider> <acco` came from. One
				// default, both symptoms. The list now measures the widest label and
				// caps it against a third of the card, which covers the short-verb case
				// and the long-usage case at once.
			},
			{
				onSelect: item => {
					const chosen = subcommands.find(sub => sub.name === item.value);
					if (chosen) onSelect(chosen);
				},
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

	dispose(): void {
		this.#inner.dispose();
	}
}
