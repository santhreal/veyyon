import type { RollbackRow, UrlOpener } from "../../cli/rollback-cli";
import type { RollbackPickerComponent } from "./rollback-picker";

export interface RollbackPanelContext {
	currentVersion: string;
	openUrl: UrlOpener;
	rollback: (version: string) => Promise<void>;
	reportError: (message: string) => void;
	requestRender: () => void;
	done: () => void;
	listReleases?: () => Promise<RollbackRow[]>;
}

export type PanelState =
	| { kind: "loading" }
	| { kind: "failed"; reason: string }
	| { kind: "ready"; picker: RollbackPickerComponent };
