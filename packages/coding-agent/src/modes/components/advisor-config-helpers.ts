import type { Model } from "@veyyon/ai";
import { truncateToWidth } from "@veyyon/tui";
import { ADVISOR_DEFAULT_TOOL_NAMES, type AdvisorConfigScope, type WatchdogConfigDoc } from "../../advisor";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ConfiguredThinkingLevel } from "../../thinking";

export interface AdvisorConfigCallbacks {
	loadDoc: (scope: AdvisorConfigScope) => Promise<WatchdogConfigDoc>;
	save: (scope: AdvisorConfigScope, doc: WatchdogConfigDoc) => Promise<void>;
	close: () => void;
	requestRender: () => void;
	notify: (message: string) => void;
}

export interface AdvisorConfigDeps {
	modelRegistry: ModelRegistry;
	settings: Settings;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ConfiguredThinkingLevel }>;
	availableToolNames: string[];
	defaultModelLabel?: string;
}

export const PREVIEW_WIDTH = 60;

export function previewLine(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return truncateToWidth(first, PREVIEW_WIDTH);
}

export function commitTools(selected: ReadonlySet<string>, all: readonly string[]): string[] | undefined {
	if (selected.size === 0) return [];
	if (selected.size === ADVISOR_DEFAULT_TOOL_NAMES.size) {
		let matchesDefault = true;
		for (const name of ADVISOR_DEFAULT_TOOL_NAMES) {
			if (!selected.has(name)) {
				matchesDefault = false;
				break;
			}
		}
		if (matchesDefault) return undefined;
	}
	return all.filter(name => selected.has(name));
}

export function formatAdvisorTools(tools: readonly string[] | undefined, emptyLabel: string): string {
	if (tools === undefined) return "read, grep, glob (default)";
	return tools.length > 0 ? tools.join(", ") : emptyLabel;
}

export function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

export type Screen = "list" | "detail" | "name" | "model" | "tools" | "thinking" | "instructions";
