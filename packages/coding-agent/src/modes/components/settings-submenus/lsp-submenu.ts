import { type SelectItem, SelectList, Spacer, Text } from "@veyyon/tui";
import { settings } from "../../../config/settings";
import { getUi, type SettingPath } from "../../../config/settings-schema";
import { getSelectListTheme, theme } from "../../theme/theme";
import { MouseRoutedSubmenu } from "../select-list-mouse-routing";
import { lspPanelPaths } from "../settings-defs";

const LSP_PANEL_MAX_ROWS = 8;

export class LspSubmenu extends MouseRoutedSubmenu {
	#selectList: SelectList | undefined;
	#focused: string | undefined;

	constructor(
		private readonly onChange: (path: SettingPath, value: boolean) => void,
		private readonly onCancel: () => void,
		private readonly requestRender?: () => void,
		initialFocus?: SettingPath,
	) {
		super();
		this.#focused = initialFocus;
		this.#show();
	}

	#show(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "LSP")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("muted", "Each row is its own switch. Enter toggles. Esc returns to Files."), 0, 0),
		);
		this.addChild(new Spacer(1));

		const items: SelectItem[] = [];
		for (const path of lspPanelPaths()) {
			const ui = getUi(path);
			if (!ui) continue;
			const on = settings.get(path) === true;
			const state = on ? theme.fg("success", "on") : theme.fg("dim", "off");
			const label = path === "lsp.enabled" ? "Language Servers" : ui.label;
			items.push({
				value: path,
				label,
				description: `${state} · ${ui.description}`,
			});
		}

		const visible = Math.min(items.length, LSP_PANEL_MAX_ROWS);
		this.#selectList = new SelectList(items, visible, getSelectListTheme(), {
			minPrimaryColumnWidth: 1,
			maxPrimaryColumnWidth: 28,
		});
		const focusedIndex = this.#focused ? items.findIndex(item => item.value === this.#focused) : -1;
		if (focusedIndex >= 0) this.#selectList.setSelectedIndex(focusedIndex);
		this.#selectList.onSelect = item => {
			const path = item.value as SettingPath;
			const next = settings.get(path) !== true;
			settings.set(path, next as never);
			this.onChange(path, next);
			this.#focused = path;
			this.#show();
			this.requestRender?.();
		};
		this.#selectList.onCancel = this.onCancel;
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to toggle · Esc to go back"), 0, 0));
	}

	mouseTarget(): SelectList | undefined {
		return this.#selectList;
	}

	handleInput(data: string): void {
		if (this.#selectList) {
			this.#selectList.handleInput(data);
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}
