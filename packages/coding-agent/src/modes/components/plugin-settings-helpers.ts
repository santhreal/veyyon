import { matchesKey } from "@veyyon/tui";
import type { InstalledPluginSummary } from "../../extensibility/plugins/marketplace";
import type { InstalledPlugin } from "../../extensibility/plugins/types";
import type { ModalShortcut } from "./modal-shell";

export function handleInputOrEscape(
	data: string,
	input: { handleInput(data: string): void },
	onCancel: () => void,
): void {
	if (data === "\x1b" || data === "\x1b\x1b" || matchesKey(data, "escape")) {
		onCancel();
		return;
	}
	input.handleInput(data);
}

export const PLUGIN_LIST_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter configure" },
	{ label: "esc close", clickable: true, id: "close" },
];

export const PLUGIN_DETAIL_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter edit" },
	{ label: "esc back", clickable: true, id: "back" },
];

export const MARKETPLACE_DETAIL_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter toggle" },
	{ label: "esc back", clickable: true, id: "back" },
];

export type PluginListEntry =
	| { kind: "npm"; plugin: InstalledPlugin }
	| { kind: "marketplace"; plugin: InstalledPluginSummary };

export interface PluginListCallbacks {
	onNpmSelect: (plugin: InstalledPlugin) => void;
	onMarketplaceSelect: (plugin: InstalledPluginSummary) => void;
	onCancel: () => void;
}

export function marketplaceEnabled(summary: InstalledPluginSummary): boolean {
	return summary.entries[0]?.enabled !== false;
}

export function entryValue(entry: PluginListEntry): string {
	if (entry.kind === "npm") return `npm:${entry.plugin.name}`;
	return `mkt:${entry.plugin.scope}:${entry.plugin.id}`;
}

export function findEntryByValue(entries: ReadonlyArray<PluginListEntry>, value: string): PluginListEntry | undefined {
	return entries.find(e => entryValue(e) === value);
}
