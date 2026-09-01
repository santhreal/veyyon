import type { Component } from "../tui";
import { sanitizeSingleLine } from "../utils";

export interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	labelForValue?: (value: string) => string;
	values?: string[];
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	changed?: boolean;
	readOnly?: boolean;
	heading?: boolean;
	group?: string;
	keywords?: readonly string[];
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean, changed: boolean) => string;
	value: (text: string, selected: boolean, changed: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
	heading?: (text: string, dimmed: boolean) => string;
	section?: (text: string, active: boolean) => string;
	hovered?: (text: string, strength: number) => string;
}

export interface SettingSection {
	name: string;
	firstItemIndex: number;
	lastItemIndex: number;
}

export interface SettingsListOptions {
	layout?: "auto" | "flat";
	typeToSearch?: boolean;
	emptyText?: string;
	hint?: string;
	sidebarWidth?: number;
	descriptionMode?: "reserved" | "expand" | "none";
	expandedIds?: ReadonlySet<string>;
}

export function getSettingItemFilterText(item: SettingItem): string {
	let text = `${item.label} ${item.id}`;
	if (item.group) text += ` ${item.group}`;
	if (item.keywords?.length) text += ` ${item.keywords.join(" ")}`;
	if (item.description) text += ` ${item.description}`;
	return sanitizeSingleLine(text);
}
