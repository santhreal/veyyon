import type { TreeFilterMode } from "../../config/settings-schema";
import type { SessionTreeNode } from "../../session/session-entries";

export interface GutterInfo {
	position: number; // displayIndent level where the connector was shown
	show: boolean; // true = show │, false = show spaces
}

export interface FlatNode {
	node: SessionTreeNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: GutterInfo[];
	isVirtualRootChild: boolean;
}

export type FilterMode = TreeFilterMode;

export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}
