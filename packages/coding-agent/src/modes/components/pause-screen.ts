import { agentPauseGate } from "@veyyon/agent-core";
import {
	type Component,
	centerLine,
	matchesKey,
	type OverlayFocusOwner,
	type OverlayHandle,
	type OverlayOptions,
	parseSgrMouse,
	TERMINAL,
} from "@veyyon/tui";
import { formatClock } from "@veyyon/utils";
import { formatDurationCoarse } from "../../slash-commands/helpers/format";
import { theme } from "../theme/theme";
import { matchesAppInterrupt } from "../utils/keybinding-matchers";
import { renderEmberField } from "./sun";

export interface PauseScreenHost {
	ui: {
		showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
		setFocus(component: Component): void;
		requestRender(): void;
		readonly terminal: { readonly rows: number };
	};
	showStatus(message: string, options?: { dim?: boolean }): void;
	readonly sessionName?: string;
}

const TICK_MS = 1_000;

const BAR_ROWS = 7;
const BAR_WIDTH = 5;
const BAR_GAP = 4;

const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;

const TITLE = "P A U S E D";
const BODY_LINES = [
	"Main agent, subagents, and advisor hold at their next step.",
	"In-flight calls finish; nothing new starts until you resume.",
] as const;
const RESUME_HINT = "esc · enter · space · click — resume";
const COMPACT_RESUME_HINT = "esc · click — resume";

export function renderPauseScreen(width: number, height: number, elapsedMs: number, sessionName?: string): string[] {
	const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
	const content: string[] = [];

	if (compact) {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
		}
		content.push(centerLine(theme.bold(theme.fg("accent", `▌▌ ${TITLE}`)), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push(centerLine(theme.fg("dim", COMPACT_RESUME_HINT), width));
	} else {
		if (sessionName) {
			content.push(centerLine(theme.bold(sessionName), width));
			content.push("");
			content.push("");
		}
		const t = Math.min(1, elapsedMs / 6000);
		const left = renderEmberField({ cols: BAR_WIDTH, rows: BAR_ROWS, time: t, trueColor: TERMINAL.trueColor });
		const right = renderEmberField({
			cols: BAR_WIDTH,
			rows: BAR_ROWS,
			time: t,
			trueColor: TERMINAL.trueColor,
			seed: 7,
		});
		for (let i = 0; i < BAR_ROWS; i++) {
			content.push(centerLine(`${left[i]}${" ".repeat(BAR_GAP)}${right[i]}`, width));
		}
		content.push("");
		content.push(centerLine(theme.bold(theme.fg("accent", TITLE)), width));
		content.push("");
		for (let bi = 0; bi < BODY_LINES.length; bi++) {
			content.push(centerLine(theme.fg("muted", BODY_LINES[bi]!), width));
		}
		content.push("");
		content.push(centerLine(theme.fg("dim", `paused for ${formatClock(elapsedMs)}`), width));
		content.push("");
		content.push(centerLine(theme.fg("dim", RESUME_HINT), width));
	}

	const topPad = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = new Array(topPad).fill("");
	for (let i = 0; i < content.length; i++) lines.push(content[i]!);
	while (lines.length < height) lines.push("");
	return lines.slice(0, Math.max(1, height));
}

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
