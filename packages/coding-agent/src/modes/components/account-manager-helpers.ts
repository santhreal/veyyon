import type { AccountRow } from "../../session/account-inventory";

export const NOTE_MAX_LINES = 3;
export const SIDEBAR_MIN_WIDTH = 20;
export const SIDEBAR_MAX_WIDTH = 30;
export const SIDEBAR_SUMMARY_ROWS = 3;

export const SHORTCUT_KEYS: Record<string, string> = {
	confirm: "\r",
	name: "n",
	refresh: "r",
	usage: "u",
	logout: "x",
	add: "a",
	search: "\x13",
	clearBlock: "c",
};

export interface AccountManagerCallbacks {
	onUseAccount: (row: AccountRow) => void;
	onRename: (row: AccountRow, name: string) => void;
	onRefresh: (provider: string, row?: AccountRow) => void;
	onLogout: (row: AccountRow) => void;
	onShowUsage: (row: AccountRow) => void;
	onAddAccount: (provider: string) => void;
	onClearRateLimitBlock: (row: AccountRow) => void;
	onCancel: () => void;
}

export interface AccountManagerOptions {
	initialProviderId?: string;
	requestRender?: () => void;
	terminalHeight?: number;
	loadBalancing?: boolean;
}

export type BodyTarget = { kind: "account"; credentialId: number } | { kind: "add" };

export interface BodyLine {
	text: string;
	target?: BodyTarget;
}
