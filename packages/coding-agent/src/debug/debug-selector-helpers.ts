import * as url from "node:url";
import type { SelectItem } from "@veyyon/tui";
import type { InteractiveModeContext } from "../modes/types";

export type DebugSelectorContext = Pick<
	InteractiveModeContext,
	| "editor"
	| "handleDebugTranscriptCommand"
	| "hideThinkingBlock"
	| "planModeEnabled"
	| "present"
	| "session"
	| "sessionManager"
	| "showDebugSelector"
	| "showError"
	| "showHookConfirm"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "toolOutputExpanded"
	| "ui"
>;

export const DEBUG_MENU_ITEMS: SelectItem[] = [
	{ value: "open-artifacts", label: "Open: artifact folder", description: "Open session artifacts in file manager" },
	{ value: "performance", label: "Report: performance issue", description: "Profile CPU, reproduce, then bundle" },
	{ value: "work", label: "Profile: work scheduling", description: "Open flamegraph of last 30s" },
	{ value: "dump", label: "Report: dump session", description: "Create report bundle immediately" },
	{ value: "memory", label: "Report: memory issue", description: "Heap snapshot + bundle" },
	{ value: "logs", label: "View: recent logs", description: "Show last 50 log entries" },
	{ value: "system", label: "View: system info", description: "Show environment details" },
	{ value: "terminal", label: "View: terminal state", description: "Subprotocols, geometry, scrollback strategy" },
	{
		value: "protocols",
		label: "Test: terminal protocols",
		description: "Styling, links, text sizing, graphics, notify",
	},
	{ value: "raw-sse", label: "View: raw SSE stream", description: "Show live provider SSE frames" },
	{
		value: "remote-debugger",
		label: "Start: JS remote debugger",
		description: "Expose JavaScriptCore inspector socket (experimental)",
	},
	{
		value: "transcript",
		label: "Export: TUI transcript",
		description: "Write visible TUI conversation to a temp txt",
	},
	{ value: "clear-cache", label: "Clear: artifact cache", description: "Remove old session artifacts" },
];

export const formatFileHyperlink = (path: string): string => {
	const fileUrl = url.pathToFileURL(path).href;
	return `\x1b]8;;${fileUrl}\x07${path}\x1b]8;;\x07`;
};
