/**
 * The version picker as a `/settings` sub-panel.
 *
 * The picker itself takes rows and draws them. Getting those rows means asking
 * the release source over the network, which a settings submenu cannot do
 * before it returns: `submenu` hands back a Component synchronously, and the
 * fetch takes as long as it takes.
 *
 * So this is the three states that request actually has, drawn rather than
 * hidden. A panel that rendered an empty list while loading would look like a
 * project with no releases; one that rendered an empty list on failure would
 * look the same, and both are the silent-empty-catalog failure the CLI path
 * refuses (Law 10). Loading says it is loading, failure says what broke and
 * that you can close and retry, and only a real list draws as a list.
 */
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import { buildRollbackRows, type RollbackRow, type UrlOpener } from "../../cli/rollback-cli";
import { getAllReleases, readVersionMoves } from "../../cli/update-cli";
import { theme } from "../theme/theme";
import { RollbackPickerComponent } from "./rollback-picker";

/** What the panel needs from its host, so none of it is reached for globally. */
export interface RollbackPanelContext {
	/** The version running now, marked in the list and never a target. */
	currentVersion: string;
	/** Opens a URL in the operator's browser. */
	openUrl: UrlOpener;
	/** Performs the move once a version is chosen. */
	rollback: (version: string) => Promise<void>;
	/** Reports a failure to the operator, since a panel that closed silently would look like success. */
	reportError: (message: string) => void;
	/** Asks the host to repaint after an async state change. */
	requestRender: () => void;
	/** Closes the panel. */
	done: () => void;
	/** Injected so a test drives the panel without a network. */
	listReleases?: () => Promise<RollbackRow[]>;
}

type PanelState =
	| { kind: "loading" }
	| { kind: "failed"; reason: string }
	| { kind: "ready"; picker: RollbackPickerComponent };

export class RollbackPanelComponent implements Component {
	#state: PanelState = { kind: "loading" };
	#context: RollbackPanelContext;

	constructor(context: RollbackPanelContext) {
		this.#context = context;
		void this.#load();
	}

	async #load(): Promise<void> {
		try {
			const rows = this.#context.listReleases
				? await this.#context.listReleases()
				: buildRollbackRows(await getAllReleases(), this.#context.currentVersion, await readVersionMoves());
			this.#state = {
				kind: "ready",
				picker: new RollbackPickerComponent(rows, {
					onSelect: version => this.#choose(version),
					onCancel: () => this.#context.done(),
					openUrl: this.#context.openUrl,
				}),
			};
		} catch (err) {
			// Named, not swallowed: "could not reach the release source" and "there
			// are no versions" are different facts and must not look the same.
			this.#state = { kind: "failed", reason: errorMessage(err) };
		}
		this.#context.requestRender();
	}

	/**
	 * Start the move, then close.
	 *
	 * The panel closes FIRST because the install writes progress to the terminal
	 * and can fail with a message worth reading; under a settings overlay all of
	 * it would paint into a screen about to be restored. A failure is reported
	 * through the host rather than into the closed panel.
	 */
	#choose(version: string): void {
		this.#context.done();
		void this.#context
			.rollback(version)
			.catch(err => this.#context.reportError(`Could not move to ${version}: ${errorMessage(err)}`));
	}

	/** The picker once it exists, for tests and for host-side focus wiring. */
	picker(): RollbackPickerComponent | null {
		return this.#state.kind === "ready" ? this.#state.picker : null;
	}

	handleInput(data: string): void {
		if (this.#state.kind === "ready") {
			this.#state.picker.handleInput(data);
			return;
		}
		// Esc closes a panel that is still loading or has failed. Without this the
		// only way out of a failed fetch would be to close the whole settings
		// overlay, which loses the operator's place in it.
		if (data === "\x1b") this.#context.done();
	}

	render(width: number): string[] {
		if (this.#state.kind === "ready") return [...this.#state.picker.render(width)];
		if (this.#state.kind === "loading") {
			return [...new Text(theme.fg("muted", "Reading published versions..."), 1, 1).render(width)];
		}
		return [
			...new Text(theme.fg("warning", `Could not read the published versions: ${this.#state.reason}`), 1, 1).render(
				width,
			),
			...new Text(theme.fg("dim", "Esc to go back. Check your connection and open it again."), 1, 0).render(width),
		];
	}

	invalidate(): void {
		if (this.#state.kind === "ready") this.#state.picker.invalidate();
	}
}
