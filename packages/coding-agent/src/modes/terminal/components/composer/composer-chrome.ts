/**
 * Composer chrome, per the agreed design (docs/internal + the "/ menu" design
 * pitch mockups): a near-invisible tone-on-tone hairline above the input, the
 * content inset from the terminal edge, an ember `›` caret, and ONE dim
 * metadata line below. The chrome is silent — motion and color belong to the
 * content (menu selection, match highlights, the working spinner), never to
 * the frame.
 */

import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { Spacer } from "@veyyon/tui/components/spacer";
import type { Component } from "@veyyon/tui/core/component-types";
import { TERMINAL } from "@veyyon/tui/terminal-capabilities";
import { getProjectDir } from "@veyyon/utils/dirs";
import { clampLow } from "@veyyon/utils/math";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import { truncateToWidth } from "@veyyon/utils/width";
import { groundHairlineHex, groundTintFgAnsi } from "../../../../theme/ground-tints";
import { theme } from "../../../../theme/theme";
import { branchLabelFromFiles } from "../../../../utils/git-head";
import { EMBER } from "../chrome/sun";
import { isBranchOnTheRow, renderBranch } from "../status-line/branch";
import { renderLocation, resolveLocationOptions } from "../status-line/location";
import { segmentSeparator } from "../status-line/state-grammar";

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
 * The accent state of a composer nothing has happened to yet: no approval
 * bypass, no bash or python prefix, no plan mode, no borrowed subagent view,
 * no named session and no thinking level. It is what the launch composer
 * resolves its chrome from, and what every field of {@link ComposerAccentState}
 * falls back to before a session exists to answer for it.
 */
export const PRISTINE_COMPOSER_ACCENT_STATE: ComposerAccentState = {
	bypass: false,
	bashMode: false,
	pythonMode: false,
	planMode: false,
	focusedSubagent: false,
	sessionAccentAnsi: undefined,
	thinkingLevel: ThinkingLevel.Off,
};

/**
 * The editor surface the composer's chrome is written to. Structural rather
 * than `CustomEditor`, so this module stays a leaf of the component it dresses
 * instead of importing it back.
 */
export interface ComposerChromeTarget {
	borderColor: (str: string) => string;
	setBorderVisible(visible: boolean): void;
	setPlaceholder(placeholder: string | undefined): void;
	setPromptGutter(gutter: string): void;
	setPromptGutterContinuation(gutter: string): void;
	setRowBackground(background: string | undefined): void;
}

/**
 * Dress a composer editor: the borderless card, the ghost prompt, and the
 * resolved accents.
 *
 * Every composer in the process goes through here — the one the launch card
 * paints, the one the mode adopts, and the replacement an extension supplies —
 * so a composer that exists before the session cannot drift from the one that
 * exists after it. The border is hidden and the row background cleared because
 * the design has no composer card: the input renders on the terminal's own
 * ground.
 */
export function applyComposerChrome(editor: ComposerChromeTarget, accents: ComposerAccents): void {
	editor.setBorderVisible(false);
	editor.setPlaceholder(COMPOSER_PLACEHOLDER);
	editor.borderColor = accents.borderColor;
	editor.setPromptGutter(accents.promptGutter);
	editor.setPromptGutterContinuation(accents.promptGutterContinuation);
	editor.setRowBackground(undefined);
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
 * one CardPadRow of tonal air above the input and one below; the metadata
 * footline and shortcuts hang under the card; and one margin row floats the
 * block off the terminal's bottom edge. Re-ordering any of these rows is a
 * design regression, which is why mounting lives here, testable, instead of as
 * a paste of addChild calls in the host.
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
 * Mount the launch composer: the same live editor container, wrapped in the
 * only chrome that has an owner before the session exists.
 *
 * It sits beside {@link mountComposerZone} because the two are one contract in
 * two states. Both compose to {@link COMPOSER_RESTING_ROWS} on the home screen,
 * so the mode's zone lands on the rows the card already reserved and the
 * handover changes text rather than position; a row added to one shape and not
 * the other is visible here, on the next screen of the same file.
 *
 * Returns the number of root children mounted, for the same reason
 * {@link mountComposerZone} does.
 */
export function mountLaunchComposer(ui: { addChild(component: Component): void }, editorContainer: Component): number {
	ui.addChild(new LaunchComposerHead());
	ui.addChild(editorContainer);
	ui.addChild(new LaunchComposerFoot());
	return 3;
}

/**
 * One optional dim line of composer metadata. Renders nothing when the
 * provider has nothing to say — no empty chrome rows. `indent` shifts the
 * content off the terminal's left edge so the composer zone shares one
 * left margin (the mockups pad the composer; nothing sits at column 0).
 */
export class QuietZoneLine implements Component, MouseRoutable {
	/**
	 * Optional click handler for the line's content. `col` is 0-based within
	 * the line as the provider rendered it (the indent is already subtracted),
	 * matching the coordinate space of StatusLineComponent.quietSegmentAt.
	 */
	onClick?: (col: number) => void;

	// The indent actually applied on the last render; clicks must subtract the
	// same amount, and it can differ from `indent` on very narrow widths.
	#lastPad = 0;

	constructor(
		private readonly line: (width: number) => string | null,
		private readonly indent = 0,
	) {}

	render(width: number): string[] {
		const pad = Math.max(0, Math.min(this.indent, width - 1));
		this.#lastPad = pad;
		const line = this.line(width - pad);
		return line === null ? [] : [" ".repeat(pad) + line];
	}

	routeMouse(event: SgrMouseEvent, _line: number, col: number): void {
		if (!event.leftClick) return;
		const inner = col - this.#lastPad;
		if (inner >= 0) this.onClick?.(inner);
	}

	/**
	 * Take the mouse grab whenever this line has a click handler.
	 *
	 * WITHOUT THIS THE FOOTLINE'S CLICK TARGETS ARE INERT. Button reports only arrive
	 * while the engine holds the mouse, and it takes the grab when the frame overflows
	 * the viewport OR a pinned footer child asks for it (`TUI.#syncWheelTracking`). A
	 * session that has not scrolled yet satisfies neither, so the gauge, the secrets chip
	 * and the path expansion all did nothing until the transcript happened to grow past
	 * one screen -- a click that works later in the session and not at the start of it.
	 * `ComposerShortcutsBar` declares the same grab for the same reason.
	 *
	 * Scoped to a line that can act on a click: a provider that only prints has no
	 * business costing the operator drag-select.
	 */
	wantsPointer(): boolean {
		return this.onClick !== undefined;
	}

	invalidate(): void {}
}

/**
 * One blank row of vertical air above and below the input. This row paints
 * NOTHING: the composer has no card and no tinted ground. Every painted
 * composer box read as a grey slab on a real terminal, so the composer is
 * hairline + text + footline on the terminal's own background. The class survives only to keep the zone's
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

/** Rows the home screen reserves for the composer zone while the mode's init
 * finishes (the real zone mounts into exactly this height). */
export const COMPOSER_RESTING_ROWS = 8;

const EDITOR_MAX_HEIGHT_MIN = 6;
const EDITOR_MAX_HEIGHT_MAX = 18;
const EDITOR_RESERVED_ROWS = 12;
const EDITOR_FALLBACK_ROWS = 24;
const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row

/**
 * Editor max-height cap for a terminal of `terminalRows` rows.
 *
 * Roomy terminals get the comfortable [6, 18] band. Small terminals shrink the
 * cap so the editor leaves at least EDITOR_MIN_CHROME_ROWS rows for the
 * transcript + status line. The editor is bordered, so it never renders fewer
 * than EDITOR_MIN_RENDERED_ROWS rows; once the terminal is too small for both
 * (terminalRows < EDITOR_MIN_RENDERED_ROWS + EDITOR_MIN_CHROME_ROWS) the cap is
 * pinned to that floor — returning a smaller number would not shrink the editor
 * any further, it would only misreport the rows it actually occupies.
 */
export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = clampLow(rows - EDITOR_RESERVED_ROWS, EDITOR_MAX_HEIGHT_MIN, EDITOR_MAX_HEIGHT_MAX);
	return clampLow(comfortable, EDITOR_MIN_RENDERED_ROWS, rows - EDITOR_MIN_CHROME_ROWS);
}

/** The ghost prompt the composer shows when its draft is empty. Owned here
 * because {@link applyComposerChrome} is the one place it is applied. */
export const COMPOSER_PLACEHOLDER = "ask anything · / for commands";

/**
 * The launch composer's chrome above the input: an empty status row, the
 * hairline, and one pad row.
 *
 * The input itself is not here. The launch card mounts the REAL editor between
 * these rows and {@link LaunchComposerFoot}, so what is on screen from the
 * first paint takes keystrokes; the mode's own zone then mounts the live
 * status line, footline and shortcuts around that same editor. These two
 * components are the rows that have no owner yet, and nothing else.
 *
 * Three rows here plus one input row plus four in the foot is
 * {@link COMPOSER_RESTING_ROWS}, which is what `mountComposerZone` composes to
 * at rest: the handover changes text, not position, so nothing slides.
 */
export class LaunchComposerHead implements Component {
	render(width: number): string[] {
		const w = Math.max(1, width);
		return ["", truncateToWidth(new ComposerHairline().render(w)[0] ?? "", w), ""];
	}

	invalidate(): void {}
}

/**
 * The launch composer's chrome below the input: one pad row, the metadata
 * footline, the shortcuts row and the bottom margin.
 *
 * The footline row is where the session's status line lands, and it landed
 * about a second after the composer above it: measured on a pty, the card and
 * its composer at 84-102ms and the status row at 1067-1083ms. The row is not
 * blank in the meantime. The half of it that does not need a session — where
 * you are and what branch you are on — is rendered here through the same
 * owners the live row renders it through ({@link renderLocation},
 * {@link renderBranch}), joined by the same {@link segmentSeparator}, so the
 * session's arrival ADDS the model, the mode and the context gauge to the
 * right of text that does not move.
 */
export class LaunchComposerFoot implements Component {
	render(width: number): string[] {
		const w = Math.max(1, width);
		const inset = " ".repeat(COMPOSER_INSET_COLS);
		return ["", truncateToWidth(`${inset}${this.#footline(w - COMPOSER_INSET_COLS)}`, w), "", ""];
	}

	/**
	 * Where you are and what branch you are on, on the row the live status line
	 * takes over.
	 *
	 * `QuietZoneLine` indents the live footline by the same inset and hands the
	 * segment the width that leaves, so the two rows are clipped against the
	 * same budget and the path breaks at the same column.
	 *
	 * The branch is read from `.git/HEAD` and its ref files, never by running
	 * git: this is the frame the terminal is already owed, and a subprocess on
	 * it costs more than the row is worth. A repository whose refs live in a
	 * reftable has no ref files to read, so it has no branch here and the live
	 * row fills it in when it arrives.
	 *
	 * Dirtiness is passed as `false` because that is what the live row renders
	 * until its own asynchronous `git status` lands, so the handover is
	 * byte-identical. Both are optimistic before the lookup answers; that is one
	 * defect in one place, not a difference between two rows.
	 */
	#footline(avail: number): string {
		const projectDir = getProjectDir();
		const location = renderLocation({ projectDir, options: resolveLocationOptions() }).content;
		const branch = isBranchOnTheRow() ? renderBranch(branchLabelFromFiles(projectDir), false) : "";
		const row = branch ? `${location}${segmentSeparator()}${branch}` : location;
		return truncateToWidth(row, avail);
	}

	invalidate(): void {}
}
