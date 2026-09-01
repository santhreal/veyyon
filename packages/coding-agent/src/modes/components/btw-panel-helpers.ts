import type { TUI } from "@veyyon/tui";

/** Exported so a caller (and the rail suite) can enumerate every state the panel paints. */
export type BtwPanelState = "running" | "complete" | "aborted" | "error";

export interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
}
