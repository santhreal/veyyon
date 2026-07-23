/**
 * Composer chrome, per the agreed design (docs/internal + the "/ menu" design
 * pitch mockups): a near-invisible tone-on-tone hairline above the input, the
 * content inset from the terminal edge, an ember `›` caret, and ONE dim
 * metadata line below. The chrome is silent — motion and color belong to the
 * content (menu selection, match highlights, the working spinner), never to
 * the frame.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Spacer, TERMINAL } from "@veyyon/tui";
import { groundHairlineHex, groundTintFgAnsi } from "../theme/ground-tints";
import { theme } from "../theme/theme";
import { EMBER } from "./sun";

/**
 * Left inset of the composer zone's content (the `›` gutter and the metadata
 * footline), in columns — the terminal realization of the design mockups'
 * horizontal composer padding. Nothing in the composer sits at column 0.
 */
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

/**
 * Resolve the composer's mode accents in ONE place (extracted from
 * interactive-mode, ARCH-2). The border is hidden; the accent lives on the
 * prompt glyph. DS-6 morph: a mode changes the GLYPH, not just the hue —
 * `!` full bypass (alarm), `$` bash (amber), `◈` plan (violet) — so the state
 * reads even where color is degraded or the operator is colorblind. Otherwise
 * the `›` carries the named-session identity accent or the theme's
 * borderAccent. No pinned hue: the theme (and any rebrand) owns the color
 * through its tokens. The `/yolo` bypass outranks every other treatment — the
 * operator must never lose sight of it.
 */
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

/**
 * A small breathing margin below the whole composer block so the prompt never
 * sits flush against the terminal's bottom edge — jammed there it read as "too
 * low". One row lifts it just off the floor in every state (home anchor and
 * mid-conversation alike); the home-screen fill math counts it via the composed
 * frame, so the anchor stays exact.
 */
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

/**
 * Mount the whole composer zone in its ONE canonical order (extracted from
 * interactive-mode, ARCH-2). The order IS the design: the working loader and
 * hook status sit above the hairline so they read next to the prompt while
 * keeping the one-line gap; the hairline separates transcript from composer;
 * one CardPadRow of tonal air above the input and one below (bare spacers
 * collapse the card to a cramped tinted strip — user screenshot, 2026-07-22);
 * the metadata footline and shortcuts hang under the card; and one margin row
 * floats the block off the terminal's bottom edge. Re-ordering any of these
 * rows is a design regression, which is why mounting lives here, testable,
 * instead of as a paste of addChild calls in the host.
 *
 * Returns the number of root children mounted: scroll isolation pins exactly
 * that many children as its live footer, so the count must come from here —
 * the one place the zone's composition can change.
 */
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

/**
 * One optional dim line of composer metadata. Renders nothing when the
 * provider has nothing to say — no empty chrome rows. `indent` shifts the
 * content off the terminal's left edge so the composer zone shares one
 * left margin (the mockups pad the composer; nothing sits at column 0).
 */
export class QuietZoneLine implements Component {
	constructor(
		private readonly line: (width: number) => string | null,
		private readonly indent = 0,
	) {}

	render(width: number): string[] {
		const pad = Math.max(0, Math.min(this.indent, width - 1));
		const line = this.line(width - pad);
		return line === null ? [] : [" ".repeat(pad) + line];
	}

	invalidate(): void {}
}

/**
 * One blank row of vertical air above and below the input. This row paints
 * NOTHING: the composer has no card and no tinted ground (user order,
 * 2026-07-22 — every attempt at a painted composer box read as a gray slab
 * on the real terminal; the composer is hairline + text + footline on the
 * terminal's own background). The class survives only to keep the zone's
 * mount order and row count stable; reintroducing any background paint here
 * is a design regression locked out by the composer suites.
 */
export class CardPadRow implements Component {
	render(): string[] {
		return [""];
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
		out += `\x1b[38;2;${EMBER[band].join(";")}m${rule}`;
	}
	return out;
}

/**
 * Full-width hairline separating the transcript from the composer zone.
 * A whisper, not a feature: the agreed composer mockups draw it as a 1px
 * tone-on-tone rule (near-black on black), so here it takes the faintest
 * structural token and never animates. Painting motion onto a solid rule
 * shatters it into uneven bright segments that read as a rendering glitch —
 * that mistake shipped once and is locked out by the composer-hairline suite.
 */
export class ComposerHairline implements Component {
	render(width: number): string[] {
		const w = Math.max(1, width);
		// Tone-on-tone means relative to the REAL ground: the static borderMuted
		// hex is calibrated for near-black terminals and vanishes on a grey one.
		// With an OSC 11-detected ground the hairline sits a fixed contrast step
		// above it on every terminal; without detection, the token fallback is
		// the exact pre-detection rendering.
		const derived = groundTintFgAnsi(groundHairlineHex(), TERMINAL.trueColor);
		const rule = theme.boxSharp.horizontal.repeat(w);
		return [derived !== undefined ? `${derived}${rule}\x1b[39m` : theme.fg("borderMuted", rule)];
	}

	invalidate(): void {}
}
