import { agentPauseGate } from "@veyyon/agent-core";
import { type Component, matchesKey, type OverlayFocusOwner, parseSgrMouse } from "@veyyon/tui";
import { formatDurationCoarse } from "../../slash-commands/helpers/format";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import type { PauseScreenHost } from "./pause-screen-helpers";

import { renderPauseScreen, TICK_MS } from "./pause-screen-helpers";

export type { PauseScreenHost };
export { renderPauseScreen };

export class PauseScreenComponent implements Component, OverlayFocusOwner {
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	#startedAt = Date.now();

	constructor(readonly host: PauseScreenHost) {}

	run(): Promise<void> {
		this.#startedAt = agentPauseGate.pausedAt ?? Date.now();
		this.#timer ??= setInterval(() => {
			if (!this.#disposed) this.host.ui.requestRender();
		}, TICK_MS);
		this.host.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			if (parseSgrMouse(data)?.leftClick && !this.#disposed) this.#done.resolve();
			return;
		}
		if (
			matchesAppInterrupt(data) ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			matchesKey(data, "space") ||
			matchesKey(data, "ctrl+c")
		) {
			if (!this.#disposed) this.#done.resolve();
		}
	}

	render(width: number): readonly string[] {
		const elapsed = Date.now() - this.#startedAt;
		return renderPauseScreen(
			Math.max(1, width),
			Math.max(1, this.host.ui.terminal.rows),
			elapsed,
			this.host.sessionName,
		);
	}
}

export async function runPauseScreen(host: PauseScreenHost): Promise<void> {
	if (!agentPauseGate.pause()) return;
	const component = new PauseScreenComponent(host);
	const overlay = host.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		host.ui.setFocus(component);
		await component.run();
	} finally {
		component.dispose();
		host.ui.setFocus(component);
		overlay.hide();
		const heldMs = agentPauseGate.resume();
		if (heldMs !== undefined) {
			host.showStatus(`Resumed after ${formatDurationCoarse(heldMs)} — agents are running again.`);
		}
	}
}
