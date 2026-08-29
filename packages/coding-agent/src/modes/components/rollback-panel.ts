import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";
import { buildRollbackRows } from "../../cli/rollback-cli";
import { getAllReleases, readVersionMoves } from "../../cli/update-cli";
import { theme } from "../theme/theme";
import type { PanelState, RollbackPanelContext } from "./rollback-panel-helpers";
import { RollbackPickerComponent } from "./rollback-picker";

export type { RollbackPanelContext };

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
			this.#state = { kind: "failed", reason: errorMessage(err) };
		}
		this.#context.requestRender();
	}

	#choose(version: string): void {
		this.#context.done();
		void this.#context
			.rollback(version)
			.catch(err => this.#context.reportError(`Could not move to ${version}: ${errorMessage(err)}`));
	}

	picker(): RollbackPickerComponent | null {
		return this.#state.kind === "ready" ? this.#state.picker : null;
	}

	handleInput(data: string): void {
		if (this.#state.kind === "ready") {
			this.#state.picker.handleInput(data);
			return;
		}
		if (data === "\x1b") this.#context.done();
	}

	render(width: number): string[] {
		if (this.#state.kind === "ready") return this.#state.picker.render(width).slice();
		if (this.#state.kind === "loading") {
			return new Text(theme.fg("muted", "Reading published versions..."), 1, 1).render(width).slice();
		}
		return new Text(theme.fg("warning", `Could not read the published versions: ${this.#state.reason}`), 1, 1)
			.render(width)
			.concat(new Text(theme.fg("dim", "Esc to go back, then open it again to retry."), 1, 0).render(width));
	}

	invalidate(): void {
		if (this.#state.kind === "ready") this.#state.picker.invalidate();
	}
}
