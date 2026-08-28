/** Composer chrome, per the agreed design (docs/internal + the "/ menu" design pitch mockups): a near-invisible tone-on-tone hairline above the input, the */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Component, MouseRoutable, SgrMouseEvent } from "@veyyon/tui";
import { Spacer, sliceByColumn, TERMINAL, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { groundHairlineHex, groundTintFgAnsi } from "../theme/ground-tints";
import { theme } from "../theme/theme";
import { EMBER_FG_TRUECOLOR } from "./sun";

/** Left inset of the composer zone's content (the `›` gutter and the metadata footline), in columns — the terminal realization of the design mockups' */
export const COMPOSER_INSET_COLS = 2;

/** The mode/session state the composer accents are a pure function of. The
 * host resolves anything needing settings or the session (the accent ANSI);
 * the resolver only decides, so every glyph morph is unit-testable byte-exact. */
export interface ComposerAccentState {
	/** `/yolo` full approval bypass — the persistent danger state. */
	bypass: boolean;
	bashMode: boolean;
	pythonMode: boolean;
	/** Plan mode, active (enabled and not paused). */
	planMode: boolean;
	/** A focused subagent view borrows the composer; its chrome dims. */
	focusedSubagent: boolean;
	/** The named-session identity accent, already resolved (or undefined when
	 * the accent is disabled or the session is unnamed). */
	sessionAccentAnsi: string | undefined;
	thinkingLevel: ThinkingLevel;
}

/** The composer's resolved chrome accents: the (hidden) border color, the
 * prompt gutter, and the multiline continuation gutter. */
export interface ComposerAccents {
	borderColor: (str: string) => string;
	promptGutter: string;
	promptGutterContinuation: string;
}

/** Resolve the composer's mode accents in ONE place (extracted from interactive-mode, ARCH-2). The border is hidden; the accent lives on the */
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
		// Focused subagent view: faint the outline so the borrowed session is
		// visually distinct from the main one.
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
		// A named session keeps its identity accent; otherwise the `›` takes
		// the theme's borderAccent (ember on titanium) — a fixed hue, never
		// activity-tinted. The chrome is silent; motion belongs to content.
		const open = state.sessionAccentAnsi ?? theme.getFgAnsi("borderAccent");
		gutter = `${open}›\x1b[39m`;
	}
	if (state.focusedSubagent) gutter = `\x1b[2m${gutter}\x1b[22m`;

	const inset = " ".repeat(COMPOSER_INSET_COLS);
	return {
		borderColor,
		promptGutter: `${inset}${gutter} `,
		// DS-6 multiline whisper: wrapped/subsequent input rows carry a dim `┆`
		// under the prompt glyph, so a multi-line draft reads as one body with a
		// quiet spine instead of floating text.
		promptGutterContinuation: `${inset}${theme.fg("dim", "┆")} `,
	};
}

/** A small breathing margin below the whole composer block so the prompt never sits flush against the terminal's bottom edge — jammed there it read as "too */
export const COMPOSER_BOTTOM_MARGIN_ROWS = 1;

/** The pre-built components the composer zone mounts, in the host's names.
 * The zone owns only ORDER and the connective tissue (pad rows, bottom
 * margin); each part's behavior stays with its owner. */
export interface ComposerZoneParts {
	/** Working loader / transient status. */
	statusContainer: Component;
	/** Hook status line (quiet status lives around the composer, not here). */
	statusLine: Component;
	hookWidgetsAbove: Component;
	hairline: Component;
	editorContainer: Component;
	/** The quiet metadata footline (location · capability). */
	capabilityLine: Component;
	shortcuts: Component;
	hookWidgetsBelow: Component;
}

/** Mount the whole composer zone in its ONE canonical order (extracted from interactive-mode, ARCH-2). The order IS the design: the working loader and */
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

/** One optional dim line of composer metadata. Renders nothing when the provider has nothing to say — no empty chrome rows. `indent` shifts the */
export class QuietZoneLine implements Component, MouseRoutable {
	/** Optional click handler for the line's content. `col` is 0-based within the line as the provider rendered it (the indent is already subtracted), */
	onClick?: (col: number) => void;

	// The indent actually applied on the last render; clicks must subtract the
	// same amount, and it can differ from `indent` on very narrow widths.
	#lastPad = 0;

	// Render cache: when the provider's line content and width are unchanged between frames, return the same array reference so the TUI engine's
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

	/** Take the mouse grab whenever this line has a click handler. WITHOUT THIS THE FOOTLINE'S CLICK TARGETS ARE INERT. Button reports only arrive */
	wantsPointer(): boolean {
		return this.onClick !== undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLine = null;
	}
}

/** One blank row of vertical air above and below the input. This row paints NOTHING: the composer has no card and no tinted ground. Every painted */
export class CardPadRow implements Component {
	// Cached: the content never changes, so a single array reference lets the
	// TUI engine's stableRows tracking skip re-ingesting this row every frame.
	readonly #rows: string[] = [""];

	render(): readonly string[] {
		return this.#rows;
	}

	invalidate(): void {}
}

/** The horizon sun tick: three rule cells fading down the ember ramp — the
 *  website's progress-sun-on-the-header-rule motif, one shared recipe. */
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

/** Full-width hairline separating the transcript from the composer zone. A whisper, not a feature: the agreed composer mockups draw it as a 1px */
export class ComposerHairline implements Component {
	#cachedWidth = -1;
	#cachedRows: readonly string[] = [];

	render(width: number): string[] {
		const w = Math.max(1, width);
		if (w === this.#cachedWidth) return this.#cachedRows as string[];
		this.#cachedWidth = w;
		// Tone-on-tone means relative to the REAL ground: the static borderMuted hex is calibrated for near-black terminals and vanishes on a grey one.
		const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
		const rule = theme.boxSharp.horizontal.repeat(w);
		this.#cachedRows = [derived !== undefined ? `${derived}${rule}\x1b[39m` : theme.fg("borderMuted", rule)];
		return this.#cachedRows as string[];
	}

	invalidate(): void {
		this.#cachedWidth = -1;
	}
}

/** Rows the home screen reserves for the composer zone while the mode's init
 * finishes (the real zone mounts into exactly this height). */
export const COMPOSER_RESTING_ROWS = 8;

/** The ghost prompt the real composer shows when its draft is empty. Owned
 * here so the first frame's static composer and the live editor show the same
 * sentence — the swap between them must be invisible. */
export const COMPOSER_PLACEHOLDER = "ask anything · / for commands";

/** The composer at rest, painted by the FIRST frame so the prompt is on screen from the first paint instead of arriving when the mode's init finishes. */
export class StaticComposerFrame implements Component {
	#draft = "";

	/** Show text that was typed before the live composer exists. The card paints this frame and session startup then runs for the better */
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

	/** The ghost prompt, or the tail of the draft when one has been typed. */
	#body(avail: number): string {
		if (!this.#draft) return theme.fg("dim", COMPOSER_PLACEHOLDER);
		if (avail < 1) return "";
		const drawn = visibleWidth(this.#draft);
		return drawn > avail ? sliceByColumn(this.#draft, drawn - avail, avail) : this.#draft;
	}

	invalidate(): void {}
}
