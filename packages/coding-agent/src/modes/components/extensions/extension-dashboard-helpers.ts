import type { Tab } from "@veyyon/tui";
import { theme } from "../../../modes/theme/theme";
import type { ProviderTab } from "./types";

export const SCROLL_LIST_THEME = {
	track: (t: string) => theme.fg("muted", t),
	thumb: (t: string) => theme.fg("accent", t),
};

export const EXT_SHORTCUTS = [
	{ label: "up/down navigate" },
	{ label: "space toggle", clickable: true, id: "toggle" },
	{ label: "left/right provider" },
	{ label: "esc close", clickable: true, id: "close" },
] as const;

export function buildTabBarTabs(tabs: ProviderTab[]): Tab[] {
	const result = new Array<Tab>(tabs.length);
	for (let ti = 0; ti < tabs.length; ti++) {
		const tab = tabs[ti]!;
		const isAll = tab.id === "all";
		const isEmptyEnabled = tab.count === 0 && tab.enabled && !isAll;
		const isDisabled = !tab.enabled && !isAll;
		let label = tab.label;
		if (tab.count > 0) label += ` (${tab.count})`;
		if (isDisabled) label = `${theme.status.disabled} ${label}`;
		result[ti] = { id: tab.id, label, short: tab.label, muted: isEmptyEnabled };
	}
	return result;
}
