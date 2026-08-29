import type { TUI } from "@veyyon/tui";

export type OmfgPanelState =
	| "generating"
	| "validating"
	| "confirming"
	| "saving"
	| "saved"
	| "rejected"
	| "aborted"
	| "error";

export interface OmfgPanelComponentOptions {
	complaint: string;
	tui: TUI;
}
