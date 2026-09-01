import type { Model } from "@veyyon/ai";
import type { Input } from "@veyyon/tui";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { ModelBrowserItem } from "./model-browser";

export type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" };

export type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" };

export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export interface ModelHubCallbacks {
	onAssign: (model: Model, role: string, thinkingLevel: ConfiguredThinkingLevel | undefined, selector: string) => void;
	onUnassign: (role: string) => void;
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	onLoginRequest?: (providerId: string) => void;
	onCycleOrderChange?: (order: string[]) => void;
	onCancel: () => void;
}

export interface ModelHubOptions {
	initialProviderId?: string;
}

export interface SidebarEntry {
	id: string;
	kind: "recent" | "roles" | "all" | "separator" | "provider";
	label: string;
	providerId?: string;
	locked?: boolean;
	annotation?: string;
	oauth?: boolean;
	catalogCount?: number;
}

export interface StripChip {
	label: string;
	styled: string;
	role?: string;
	action: "assign" | "unassign" | "fallback" | "fallbackModel" | "fallbackProvider" | "thinking";
	thinkingLevel?: ConfiguredThinkingLevel;
}

export type StripState =
	| {
			kind: "role" | "thinking";
			item: ModelBrowserItem;
			role?: string;
			chips: StripChip[];
			index: number;
			returnToRoles: boolean;
	  }
	| {
			kind: "roleName";
			input: Input;
	  };

export interface ChipRange {
	start: number;
	end: number;
	index: number;
}

export const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
export const RECENT_LIMIT = 15;
export const SIDEBAR_MIN_WIDTH = 18;
export const SIDEBAR_MAX_WIDTH = 26;

export const autoRefreshedProviders = new Set<string>();

export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}
