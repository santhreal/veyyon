/** Host the version picker outside a session. `veyyon rollback` with no arguments is a browse, and a browse wants the */
import { ProcessTerminal, TUI } from "@veyyon/tui";
import { RollbackPickerComponent } from "../modes/components/rollback-picker";
import type { RollbackRow, UrlOpener } from "./rollback-cli";

/** Show the picker and resolve the chosen version, or null when the operator cancelled or chose the version already running. */
export async function pickVersion(rows: readonly RollbackRow[], openUrl: UrlOpener): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	// One guard for both exits: `ui.stop()` twice tears down a terminal that is
	// already restored, and a second resolve would silently discard the first
	// choice.
	const finish = (version: string | null) => {
		if (resolved) return;
		resolved = true;
		ui.stop();
		resolve(version);
	};

	const picker = new RollbackPickerComponent(rows, {
		onSelect: version => finish(version),
		onCancel: () => finish(null),
		openUrl,
	});
	picker.setOnRequestRender(() => ui.requestRender());
	ui.showOverlay(picker, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
	ui.setFocus(picker);
	ui.start();
	return promise;
}
