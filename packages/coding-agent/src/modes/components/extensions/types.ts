import type { SourceMeta } from "../../../capability/types";

export type ExtensionKind =
	| "extension-module"
	| "skill"
	| "rule"
	| "tool"
	| "mcp"
	| "prompt"
	| "instruction"
	| "context-file"
	| "hook"
	| "slash-command";

export type ExtensionState = "active" | "disabled" | "shadowed";

export type DisabledReason = "provider-disabled" | "item-disabled" | "shadowed";

export interface ExtensionRow {
	id: string;
	kind: ExtensionKind;
	name: string;
	displayName: string;
	description?: string;
	trigger?: string;
	path: string;
	source: {
		provider: string;
		providerName: string;
		level: "user" | "project" | "native";
	};
	state: ExtensionState;
	disabledReason?: DisabledReason;
	shadowedBy?: string;
	raw: unknown;
}

export type TreeNodeType = "provider" | "kind" | "item";

export interface TreeNode {
	id: string;
	label: string;
	type: TreeNodeType;
	enabled: boolean;
	collapsed: boolean;
	children: TreeNode[];
	count?: number;
}

export interface FlatTreeItem {
	node: TreeNode;
	depth: number;
	index: number;
}

export interface ProviderTab {
	id: string;
	label: string;
	enabled: boolean;
	count: number;
}

export interface DashboardState {
	tabs: ProviderTab[];
	activeTabIndex: number;

	extensions: ExtensionRow[];
	tabFiltered: ExtensionRow[];
	searchFiltered: ExtensionRow[];
	searchQuery: string;

	listIndex: number;
	scrollOffset: number;

	selected: ExtensionRow | null;
}

export function makeExtensionId(kind: ExtensionKind, name: string): string {
	return `${kind}:${name}`;
}

export function sourceFromMeta(meta: SourceMeta): ExtensionRow["source"] {
	return {
		provider: meta.provider,
		providerName: meta.providerName,
		level: meta.level,
	};
}
