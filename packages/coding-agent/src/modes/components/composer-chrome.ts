import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Component, MouseRoutable, SgrMouseEvent } from "@veyyon/tui";
import { Spacer, sliceByColumn, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { groundHairlineHex, groundTintFgAnsi } from "../theme/ground-tints";
import { theme } from "../theme/theme";
import { EMBER_FG_TRUECOLOR } from "./sun";

export const COMPOSER_INSET_COLS = 2;

export interface ComposerAccentState {
	bypass: boolean;
	bashMode: boolean;
	pythonMode: boolean;
	planMode: boolean;
	focusedSubagent: boolean;
	sessionAccentAnsi: string | undefined;
	thinkingLevel: ThinkingLevel;
}

export interface ComposerAccents {
	borderColor: (str: string) => string;
	promptGutter: string;
	promptGutterContinuation: string;
}

export function resolveComposerAccents(state: ComposerAccentState): ComposerAccents {
	let borderColor: (str: string) => string;
	if (state.bypass) {
		borderColor = theme.getBypassModeBorderColor();
	} else if (state.bashMode) {
		borderColor = theme.getBashModeBorderColor();
	} else if (state.pythonMode) {
		borderColor = theme.getPythonModeBorderColor();
	} else if (state.sessionAccentAnsi) {
		const ansi = state.sessionAccentAnsi;
		borderColor = (str: string) => `${ansi}${str}\x1b[39m`;
	} else {
		borderColor = theme.getThinkingBorderColor(state.thinkingLevel);
	}
	if (state.focusedSubagent) {
		const base = borderColor;
		borderColor = (str: string) => `\x1b[2m${base(str)}\x1b[22m`;
	}

	let gutter: string;
	if (state.bypass) {
		gutter = theme.getBypassModeBorderColor()("!");
	} else if (state.bashMode) {
		gutter = theme.getBashModeBorderColor()("$");
	} else if (state.pythonMode) {
		gutter = theme.getPythonModeBorderColor()("›");
	} else if (state.planMode) {
		gutter = theme.fg("modeAccent", "◈");
	} else {
		const open = state.sessionAccentAnsi ?? theme.getFgAnsi("borderAccent");
		gutter = `${open}›\x1b[39m`;
	}
	if (state.focusedSubagent) gutter = `\x1b[2m${gutter}\x1b[22m`;

	const inset = " ".repeat(COMPOSER_INSET_COLS);
	return {
		borderColor,
		promptGutter: `${inset}${gutter} `,
		promptGutterContinuation: `${inset}${theme.fg("dim", "┆")} `,
	};
}

export const COMPOSER_BOTTOM_MARGIN_ROWS = 1;

export interface ComposerZoneParts {
	statusContainer: Component;
	statusLine: Component;
	hookWidgetsAbove: Component;
	hairline: Component;
	editorContainer: Component;
	capabilityLine: Component;
	shortcuts: Component;
	hookWidgetsBelow: Component;
}

export function mountComposerZone(ui: { addChild(component: Component): void }, parts: ComposerZoneParts): number {
	ui.addChild(parts.statusContainer);
	ui.addChild(parts.statusLine);
	ui.addChild(parts.hookWidgetsAbove);
	ui.addChild(parts.hairline);
	ui.addChild(new CardPadRow());
	ui.addChild(parts.editorContainer);
	ui.addChild(new CardPadRow());
	ui.addChild(parts.capabilityLine);
	ui.addChild(parts.shortcuts);
	ui.addChild(parts.hookWidgetsBelow);
	ui.addChild(new Spacer(COMPOSER_BOTTOM_MARGIN_ROWS));
	return 11;
}

export class QuietZoneLine implements Component, MouseRoutable {
	onClick?: (col: number) => void;

	#lastPad = 0;

	#cachedWidth = -1;
	#cachedLine: string | null = null;
	#cachedRows: readonly string[] = [];

	constructor(
		private readonly line: (width: number) => string | null,
		private readonly indent = 0,
	) {}

	render(width: number): string[] {
		const pad = Math.max(0, Math.min(this.indent, width - 1));
		this.#lastPad = pad;
		const line = this.line(width - pad);
		if (width === this.#cachedWidth && line === this.#cachedLine) return this.#cachedRows as string[];
		this.#cachedWidth = width;
		this.#cachedLine = line;
		this.#cachedRows = line === null ? [] : [" ".repeat(pad) + line];
		return this.#cachedRows as string[];
	}

	routeMouse(event: SgrMouseEvent, _line: number, col: number): void {
		if (!event.leftClick) return;
		const inner = col - this.#lastPad;
		if (inner >= 0) this.onClick?.(inner);
	}

	wantsPointer(): boolean {
		return this.onClick !== undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLine = null;
	}
}

export class CardPadRow implements Component {
	readonly #rows: string[] = [""];

	render(): readonly string[] {
		return this.#rows;
	}

	invalidate(): void {}
}

export function emberTick(trueColor: boolean, cells = 3): string {
	const rule = theme.boxSharp.horizontal;
	if (!trueColor) return theme.fg("accent", rule.repeat(cells));
	let out = "";
	for (let i = 0; i < cells; i++) {
		const band = Math.max(0, 6 - i * 2);
		out += `${EMBER_FG_TRUECOLOR[band]}${rule}`;
	}
	return out;
}

export class ComposerHairline implements Component {
	#cachedWidth = -1;
	#cachedRows: readonly string[] = [];

	render(width: number): string[] {
		const w = Math.max(1, width);
		if (w === this.#cachedWidth) return this.#cachedRows as string[];
		this.#cachedWidth = w;
		const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
		const rule = theme.boxSharp.horizontal.repeat(w);
		this.#cachedRows = [derived !== undefined ? `${derived}${rule}\x1b[39m` : theme.fg("borderMuted", rule)];
		return this.#cachedRows as string[];
	}

	invalidate(): void {
		this.#cachedWidth = -1;
	}
}

export const COMPOSER_RESTING_ROWS = 8;

export const COMPOSER_PLACEHOLDER = "ask anything · / for commands";

export class StaticComposerFrame implements Component {
	#draft = "";

	setDraft(text: string): void {
		this.#draft = text;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		const clip = (row: string): string => truncateToWidth(row, w);
		const hairline = new ComposerHairline().render(w)[0] ?? "";
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		const gutter = `${theme.getFgAnsi("borderAccent")}›\x1b[39m`;
		return [
			"",
			clip(hairline),
			"",
			clip(`${inset}${gutter} ${this.#body(w - COMPOSER_INSET_COLS - 2)}`),
			"",
			"",
			"",
			"",
		];
	}

	#body(avail: number): string {
		if (!this.#draft) return theme.fg("dim", COMPOSER_PLACEHOLDER);
		if (avail < 1) return "";
		const drawn = visibleWidth(this.#draft);
		return drawn > avail ? sliceByColumn(this.#draft, drawn - avail, avail) : this.#draft;
	}

	invalidate(): void {}
}
