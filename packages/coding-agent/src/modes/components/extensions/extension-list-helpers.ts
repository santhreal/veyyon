import type { ExtensionKind, ExtensionRow } from "./types";

export interface ExtensionListCallbacks {
	onSelectionChange?: (extension: ExtensionRow | null) => void;
	onToggle?: (extensionId: string, enabled: boolean) => void;
	onMasterToggle?: (providerId: string) => void;
	masterSwitchProvider?: string | null;
}

export const DEFAULT_MAX_VISIBLE = 15;

export type ListItem =
	| { type: "master"; providerId: string; providerName: string; enabled: boolean }
	| { type: "kind-header"; kind: ExtensionKind; label: string; icon: string; count: number }
	| { type: "extension"; item: ExtensionRow };
