/**
 * Overlay oracle scenario runner.
 *
 * Mounts a real composer through `runComposerOracleScenario`, records the frame the composer paints
 * on its own, then shows real overlays on the real TUI and captures the composited screen. The base
 * frame is read before any overlay opens, which is what lets an oracle say the modal disturbed a
 * column it never claimed.
 *
 * Overlays are `Component`s, not doubles of the compositor: `showOverlay` resolves the layout, clips
 * to `maxHeight`, truncates to width and composites cell by cell, and every one of those steps is on
 * the path this runner drives.
 */

import { stripVTControlCharacters } from "node:util";
import { type Component, CURSOR_MARKER, type OverlayHandle, type OverlayOptions, type TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { settleFrames } from "../../../tui/test/helpers/settle-frames";
import type { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import {
	evaluateAllOverlayOracles,
	type OverlayEvaluationResult,
	type OverlayOracleFrameState,
	type OverlaySnapshot,
} from "../../src/modes/components/overlay-defect-oracle";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./composer-oracle-runner";

/**
 * A modal that paints the block of text it is given.
 *
 * `caret` makes it a focusable card: it emits `CURSOR_MARKER` at that cell, which is how a real modal
 * with an input asks the engine for the hardware caret, and the engine reads the marker back out of
 * the composited window. Without it the card claims no caret.
 */
export class OverlayCard implements Component {
	constructor(
		readonly name: string,
		readonly lines: readonly string[],
		readonly caret: { line: number; col: number } | null = null,
	) {}

	invalidate(): void {}

	/** The card's text, with no marker in it: what the screen should show. */
	plainLines(width: number): string[] {
		// A card fills its width the way a bordered modal does, so a compositor that miscounts the
		// right edge shows up as a base column the card overwrote.
		return this.lines.map(line => line.slice(0, width).padEnd(Math.min(width, 40), " "));
	}

	render(width: number): string[] {
		const lines = this.plainLines(width);
		const caret = this.caret;
		if (!caret) return lines;
		const line = lines[caret.line] ?? "";
		lines[caret.line] = `${line.slice(0, caret.col)}${CURSOR_MARKER}${line.slice(caret.col)}`;
		return lines;
	}
}

/** One overlay to show, and how to place it. */
export interface OverlaySpec {
	name: string;
	lines: readonly string[];
	options?: OverlayOptions;
	/** Ask for the hardware caret at this cell of the card's own block. */
	caret?: { line: number; col: number };
	/** Close the overlay before the capture, so it is on the stack and painted by nothing. */
	hideBeforeCapture?: boolean;
}

export interface OverlayRunnerOptions extends RunnerOptions {
	overlays: readonly OverlaySpec[];
}

export interface OverlayRunnerResult {
	terminal: VirtualTerminal;
	tui: TUI;
	composer: RunnerResult;
	frameState: OverlayOracleFrameState;
	evaluation: OverlayEvaluationResult;
	/** Read the composited screen again and judge it again. */
	recapture: () => { frameState: OverlayOracleFrameState; evaluation: OverlayEvaluationResult };
	handles: readonly OverlayHandle[];
	cleanUp: () => void;
}

interface OverlayCaptureContext {
	term: VirtualTerminal;
	tui: TUI;
	width: number;
	height: number;
	baseViewportLines: readonly string[];
	cards: readonly { card: OverlayCard; spec: OverlaySpec; hidden: boolean }[];
}

/**
 * The width the engine renders an overlay at.
 *
 * `showOverlay` resolves this from the options and the terminal, and the resolution is private. The
 * default is the one case a snapshot can state without reaching into the engine: eighty columns or
 * the terminal, whichever is smaller. A spec that sets a width states it here too, which is why the
 * specs this suite drives keep to a literal `width`.
 */
function renderWidthFor(options: OverlayOptions | undefined, termWidth: number): number {
	const declared = options?.width;
	if (typeof declared === "number") return Math.min(declared, termWidth);
	return Math.min(80, termWidth);
}

/** Read the composited screen and judge it. */
export function captureOverlayFrameState(ctx: OverlayCaptureContext): OverlayOracleFrameState {
	const viewportLines = ctx.term.getViewport().map(line => stripVTControlCharacters(stripAnsi(line)));
	const overlays: OverlaySnapshot[] = ctx.cards.map((entry, stackIndex) => {
		const renderWidth = renderWidthFor(entry.spec.options, ctx.width);
		return {
			stackIndex,
			name: entry.spec.name,
			renderedLines: entry.card.plainLines(renderWidth).map(line => stripVTControlCharacters(stripAnsi(line))),
			renderWidth,
			visible: !entry.hidden,
			interactive: !entry.hidden,
			caretRequest: entry.spec.caret ?? null,
		};
	});

	return {
		width: ctx.width,
		height: ctx.height,
		viewportLines,
		baseViewportLines: ctx.baseViewportLines,
		cursor: ctx.term.getCursor(),
		overlays,
	};
}

/** Mount a composer, show the overlays, and judge the composited frame. */
export async function runOverlayOracleScenario(options: OverlayRunnerOptions): Promise<OverlayRunnerResult> {
	const composer = await runComposerOracleScenario(options);
	const baseViewportLines = composer.terminal.getViewport().map(line => stripVTControlCharacters(stripAnsi(line)));

	const cards: { card: OverlayCard; spec: OverlaySpec; hidden: boolean }[] = [];
	const handles: OverlayHandle[] = [];
	for (const spec of options.overlays) {
		const card = new OverlayCard(spec.name, spec.lines, spec.caret ?? null);
		const handle = composer.tui.showOverlay(card, spec.options);
		handles.push(handle);
		await settleFrames(composer.terminal, composer.tui);
		if (spec.hideBeforeCapture) {
			handle.hide();
			await settleFrames(composer.terminal, composer.tui);
		}
		cards.push({ card, spec, hidden: spec.hideBeforeCapture === true });
	}

	const ctx: OverlayCaptureContext = {
		term: composer.terminal,
		tui: composer.tui,
		width: options.width,
		height: options.height,
		baseViewportLines,
		cards,
	};

	const frameState = captureOverlayFrameState(ctx);
	return {
		terminal: composer.terminal,
		tui: composer.tui,
		composer,
		frameState,
		evaluation: evaluateAllOverlayOracles(frameState),
		recapture: () => {
			const next = captureOverlayFrameState(ctx);
			return { frameState: next, evaluation: evaluateAllOverlayOracles(next) };
		},
		handles,
		cleanUp: composer.cleanUp,
	};
}
