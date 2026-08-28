/**
 * Composer oracle scenario runner.
 *
 * Drives real TUI and ComposerZone components over Ghostty VirtualTerminal,
 * captures the rendered grid, hit-testing mouse routing, and TUI segment ledger,
 * and evaluates all composer defect oracles.
 */

import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@veyyon/agent-core";
import { type Component, Container, Editor, Spacer, TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import { settleFrames } from "../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import {
	CardPadRow,
	COMPOSER_BOTTOM_MARGIN_ROWS,
	type ComposerAccentState,
	ComposerHairline,
	mountComposerZone,
	resolveComposerAccents,
} from "../../src/modes/components/composer-chrome";
import {
	type ComposerOracleFrameState,
	evaluateAllComposerOracles,
	type FrameSegmentSnapshot,
	type OracleEvaluationResult,
} from "../../src/modes/components/composer-defect-oracle";
import { getEditorTheme } from "../../src/modes/theme/theme";
import type { CorpusCaseState } from "./renderer-defect-corpus";

/** Transcript content component */
export class TranscriptMock implements Component {
	lines: string[] = [];

	invalidate(): void {}

	// A fresh array per render. The engine caches the rows a child returns as
	// the previous frame, so a double that hands back its own mutable buffer
	// makes an append rewrite that cache retroactively: the differential diff
	// then compares new rows against new rows, reports them unchanged, and
	// skips the repaint. Growing the transcript that way paints a second
	// composer and never paints the appended lines at all - a defect in the
	// double, not the renderer.
	render(): readonly string[] {
		return [...this.lines];
	}
}

/** Routable wrapper to observe mouse events on footer children */
export class RoutableTestComponent implements Component, MouseRoutable {
	calls: Array<{ event: SgrMouseEvent; line: number; col: number }> = [];
	constructor(
		public name: string,
		public rows: number = 1,
		public customRender?: (width: number) => string[],
	) {}

	invalidate(): void {}

	wantsPointer(): boolean {
		return true;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.calls.push({ event, line, col });
	}

	render(width: number): string[] {
		if (this.customRender) return this.customRender(width);
		if (this.rows === 0) return [];
		return Array.from({ length: this.rows }, (_, i) => `[${this.name}-${i}]`.slice(0, width));
	}
}

export interface RunnerOptions {
	width: number;
	height: number;
	modeState?: Partial<ComposerAccentState>;
	editorText?: string;
	transcriptLines?: number | string[];
	scrollIsolation?: boolean;
	scrollOffset?: number;
	focused?: boolean;
	statusMessage?: string;
	customParts?: Partial<Parameters<typeof mountComposerZone>[1]>;
}

export interface RunnerResult {
	terminal: VirtualTerminal;
	tui: TUI;
	frameState: ComposerOracleFrameState;
	evaluation: OracleEvaluationResult;
	transcript: TranscriptMock;
	advance: () => Promise<void>;
	cleanUp: () => void;
}

/** SGR left-click press report at 0-based (row, col) */
function pressAt(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** SGR left-click release report at 0-based (row, col) */
function releaseAt(row: number, col = 0): string {
	return `\x1b[<0;${col + 1};${row + 1}m`;
}

/**
 * Execute a composer scenario and run all defect oracles on the resulting frame.
 */
export async function runComposerOracleScenario(options: RunnerOptions): Promise<RunnerResult> {
	const width = options.width;
	const height = options.height;

	const term = new VirtualTerminal(width, height, 10_000);
	const tui = new TUI(term, true);

	const accentState: ComposerAccentState = {
		bypass: options.modeState?.bypass ?? false,
		bashMode: options.modeState?.bashMode ?? false,
		pythonMode: options.modeState?.pythonMode ?? false,
		planMode: options.modeState?.planMode ?? false,
		focusedSubagent: options.modeState?.focusedSubagent ?? false,
		sessionAccentAnsi: options.modeState?.sessionAccentAnsi,
		thinkingLevel: options.modeState?.thinkingLevel ?? ThinkingLevel.Off,
	};

	const accents = resolveComposerAccents(accentState);

	// Root transcript
	const transcript = new TranscriptMock();
	if (typeof options.transcriptLines === "number") {
		transcript.lines = Array.from(
			{ length: options.transcriptLines },
			(_, i) => `transcript-output-line-${String(i).padStart(4, "0")}`,
		);
	} else if (Array.isArray(options.transcriptLines)) {
		transcript.lines = [...options.transcriptLines];
	}
	tui.addChild(transcript);

	// Pinned footer components
	const statusContainer = new Container();
	if (options.statusMessage) {
		statusContainer.addChild(
			new RoutableTestComponent("statusMessage", 1, (w: number) => [options.statusMessage!.slice(0, w)]),
		);
	}
	const statusLine = new RoutableTestComponent("statusLine", 0);
	const hookWidgetsAbove = new Container();
	const hairline = new ComposerHairline();

	const editorContainer = new Container();
	const editor = new Editor(getEditorTheme());
	editor.borderColor = accents.borderColor;
	editor.setPromptGutter(accents.promptGutter);
	editor.setPromptGutterContinuation(accents.promptGutterContinuation);
	editor.setRowBackground(undefined);
	editor.setBorderVisible(false);
	if (options.editorText !== undefined) {
		editor.setText(options.editorText);
	}

	editorContainer.addChild(editor);

	const capabilityLine = new RoutableTestComponent("capabilityLine", 1, (w: number) => [
		`location: ~/project · model: test-model`.slice(0, w),
	]);
	const shortcuts = new RoutableTestComponent("shortcuts", 1, (w: number) => [`/ menu · ^c exit`.slice(0, w)]);
	const hookWidgetsBelow = new Container();

	const mountedCount = mountComposerZone(tui, {
		statusContainer,
		statusLine,
		hookWidgetsAbove,
		hairline,
		editorContainer,
		capabilityLine,
		shortcuts,
		hookWidgetsBelow,
	});

	tui.setPinnedFooterChildCount(mountedCount);
	tui.setScrollIsolation(options.scrollIsolation ?? true);

	if (options.focused !== false) {
		tui.setFocus(editor);
	}

	tui.start();
	await settleFrames(term, tui);

	const allComponents = [
		{ name: "TranscriptMock", comp: transcript },
		{ name: "statusContainer", comp: statusContainer },
		{ name: "statusLine", comp: statusLine },
		{ name: "hookWidgetsAbove", comp: hookWidgetsAbove },
		{ name: "ComposerHairline", comp: hairline },
		{ name: "CardPadRow", comp: new CardPadRow() },
		{ name: "Editor", comp: editorContainer },
		{ name: "CardPadRow", comp: new CardPadRow() },
		{ name: "QuietZoneLine", comp: capabilityLine },
		{ name: "ComposerShortcuts", comp: shortcuts },
		{ name: "hookWidgetsBelow", comp: hookWidgetsBelow },
		{ name: "Spacer", comp: new Spacer(COMPOSER_BOTTOM_MARGIN_ROWS) },
	];

	const segments: FrameSegmentSnapshot[] = [];
	let offset = 0;
	for (const item of allComponents) {
		const rowCount = item.comp.render(width)?.length ?? 0;
		segments.push({
			startIndex: offset,
			rowCount,
			componentName: item.name,
		});
		offset += rowCount;
	}
	const totalFrameRows = offset;
	const footerSegments = segments.slice(-mountedCount);
	const pinnedFooterRows = footerSegments.reduce((sum, s) => sum + s.rowCount, 0);

	// Capture live footer lines from the live frame before any virtual scrolling
	const liveRawViewport = term.getViewport();
	const liveViewportLines = liveRawViewport.map(l => stripVTControlCharacters(stripAnsi(l)));
	const liveFooterTop = totalFrameRows < height ? totalFrameRows - pinnedFooterRows : height - pinnedFooterRows;
	const liveFooterLines: string[] = [];
	if (totalFrameRows < height) {
		liveFooterLines.push(...liveViewportLines.slice(Math.max(0, liveFooterTop), totalFrameRows));
	} else {
		liveFooterLines.push(...liveViewportLines.slice(Math.max(0, liveFooterTop), height));
	}

	// If scrollOffset requested, scroll back
	if (options.scrollOffset && options.scrollOffset > 0) {
		for (let i = 0; i < options.scrollOffset; i++) {
			// SGR wheel up
			term.sendInput("\x1b[<64;5;5M");
			await settleFrames(term, tui);
		}
	}

	// Read viewport lines
	const rawViewportLines = term.getViewport();
	const viewportLines = rawViewportLines.map(l => stripVTControlCharacters(stripAnsi(l)));
	const cursor = term.getCursor();
	let windowTopRow = 0;
	const virtualScrollTop = tui.virtualScrollActive ? (options.scrollOffset ?? 1) : null;
	let screenBounds = {
		footerTop: 0,
		footerBottom: 0,
		footerRowOffset: 0,
		contentBottom: 0,
	};

	if (tui.virtualScrollActive) {
		const footerRows = Math.min(pinnedFooterRows, height - 1);
		const footerTop = height - footerRows;
		screenBounds = {
			footerTop,
			footerBottom: height - 1,
			contentBottom: height - 1,
			footerRowOffset: height - pinnedFooterRows,
		};
	} else {
		if (totalFrameRows < height) {
			windowTopRow = 0;
			screenBounds = {
				footerTop: totalFrameRows - pinnedFooterRows,
				footerBottom: totalFrameRows - 1,
				footerRowOffset: totalFrameRows - pinnedFooterRows,
				contentBottom: totalFrameRows - 1,
			};
		} else {
			windowTopRow = totalFrameRows - height;
			screenBounds = {
				footerTop: height - pinnedFooterRows,
				footerBottom: height - 1,
				footerRowOffset: height - pinnedFooterRows,
				contentBottom: height - 1,
			};
		}
	}

	// Capture mouse click routing. Every footer row is probed, not just the boundaries: a click
	// offset shows up as a row in the middle of the footer dispatching to the transcript, and an
	// oracle that only sees the first and last footer row never looks at the rows between them.
	const mouseRouting = new Map<number, { routedTo: string | null; localLine: number | null; col: number | null }>();
	const probeRows = new Set<number>([
		0,
		Math.max(0, screenBounds.footerTop - 1),
		screenBounds.contentBottom,
		Math.min(height - 1, screenBounds.contentBottom + 1),
	]);
	for (let row = screenBounds.footerTop; row <= Math.min(height - 1, screenBounds.footerBottom); row += 1) {
		probeRows.add(row);
	}

	for (const r of probeRows) {
		if (r < 0 || r >= height) continue;
		capabilityLine.calls = [];
		shortcuts.calls = [];

		term.sendInput(pressAt(r, 5));
		term.sendInput(releaseAt(r, 5));

		let routedTo: string | null = null;
		let localLine: number | null = null;
		let col: number | null = null;

		if (capabilityLine.calls.length > 0) {
			const call = capabilityLine.calls[0]!;
			routedTo = "footer:capabilityLine";
			localLine = call.line;
			col = call.col;
		} else if (shortcuts.calls.length > 0) {
			const call = shortcuts.calls[0]!;
			routedTo = "footer:shortcuts";
			localLine = call.line;
			col = call.col;
		} else if (r < screenBounds.footerTop && r <= screenBounds.contentBottom) {
			routedTo = "transcript";
		}

		mouseRouting.set(r, { routedTo, localLine, col });
	}

	let expectedGlyph = "›";
	if (accentState.bypass) expectedGlyph = "!";
	else if (accentState.bashMode) expectedGlyph = "$";
	else if (accentState.planMode) expectedGlyph = "◈";

	const frameState: ComposerOracleFrameState = {
		width,
		height,
		viewportLines,
		rawViewportLines,
		cursor,
		totalFrameRows,
		windowTopRow,
		pinnedFooterChildCount: mountedCount,
		pinnedFooterRows,
		virtualScrollTop,
		screenBounds,
		segments:
			segments.length > 0
				? segments
				: [
						{
							startIndex: 0,
							rowCount: transcript.lines.length,
							componentName: "TranscriptMock",
						},
						{
							startIndex: transcript.lines.length,
							rowCount: 1,
							componentName: "ComposerHairline",
						},
						{
							startIndex: transcript.lines.length + 1,
							rowCount: 1,
							componentName: "CardPadRow",
						},
						{
							startIndex: transcript.lines.length + 2,
							rowCount: 1,
							componentName: "Editor",
						},
						{
							startIndex: transcript.lines.length + 3,
							rowCount: 1,
							componentName: "CardPadRow",
						},
						{
							startIndex: transcript.lines.length + 4,
							rowCount: 1,
							componentName: "QuietZoneLine",
						},
						{
							startIndex: transcript.lines.length + 5,
							rowCount: 1,
							componentName: "ComposerShortcuts",
						},
						{
							startIndex: transcript.lines.length + 6,
							rowCount: 1,
							componentName: "Spacer",
						},
					],
		mouseRouting,
		transcriptLineMarkers: ["transcript-output-line-"],
		expectedPromptGlyph: expectedGlyph,
		editorFocused: options.focused !== false,
		liveFooterLines,
	};

	const evaluation = evaluateAllComposerOracles(frameState);

	return {
		terminal: term,
		tui,
		frameState,
		evaluation,
		transcript,
		advance: async () => {
			tui.requestRender();
			await settleFrames(term, tui);
		},
		cleanUp: () => {
			tui.stop();
		},
	};
}

/** Convert runner options to CorpusCaseState */
export function runnerOptionsToCorpusState(options: RunnerOptions): CorpusCaseState {
	return {
		width: options.width,
		height: options.height,
		modeState: {
			bypass: options.modeState?.bypass,
			bashMode: options.modeState?.bashMode,
			pythonMode: options.modeState?.pythonMode,
			planMode: options.modeState?.planMode,
			focusedSubagent: options.modeState?.focusedSubagent,
			sessionAccentAnsi: options.modeState?.sessionAccentAnsi,
			thinkingLevel: options.modeState?.thinkingLevel,
		},
		editorText: options.editorText ?? "",
		transcriptLines:
			typeof options.transcriptLines === "number" ? options.transcriptLines : (options.transcriptLines?.length ?? 0),
		scrollIsolation: options.scrollIsolation ?? true,
		scrollOffset: options.scrollOffset ?? 0,
		focused: options.focused ?? true,
	};
}

export function corpusStateToRunnerOptions(state: CorpusCaseState): RunnerOptions {
	let thinkingLevel: ThinkingLevel = ThinkingLevel.Off;
	if (state.modeState.thinkingLevel) {
		thinkingLevel = state.modeState.thinkingLevel as ThinkingLevel;
	}
	return {
		width: state.width,
		height: state.height,
		modeState: {
			bypass: state.modeState.bypass,
			bashMode: state.modeState.bashMode,
			pythonMode: state.modeState.pythonMode,
			planMode: state.modeState.planMode,
			focusedSubagent: state.modeState.focusedSubagent,
			sessionAccentAnsi: state.modeState.sessionAccentAnsi,
			thinkingLevel,
		},
		editorText: state.editorText,
		transcriptLines: state.transcriptLines,
		scrollIsolation: state.scrollIsolation,
		scrollOffset: state.scrollOffset,
		focused: state.focused,
	};
}
