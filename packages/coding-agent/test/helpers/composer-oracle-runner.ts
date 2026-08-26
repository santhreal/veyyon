/**
 * Composer oracle scenario runner.
 *
 * Drives real TUI and ComposerZone components over Ghostty VirtualTerminal,
 * captures the rendered grid, hit-testing mouse routing, and TUI segment ledger,
 * and evaluates all composer defect oracles.
 */

import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@veyyon/agent-core";
import { type Component, Container, Editor, TUI } from "@veyyon/tui";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/tui/mouse";
import { stripAnsi } from "@veyyon/utils";
import { settleFrames } from "../../../tui/test/helpers/settle-frames";
import { pressAt, releaseAt, WHEEL_UP } from "../../../tui/test/helpers/sgr-mouse";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import {
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
	/**
	 * Substrings that identify a transcript row on screen, for the bleed oracle.
	 *
	 * Defaults to the marker the runner's own generated rows carry. A caller that supplies its own
	 * `transcriptLines` MUST supply markers for them: the bleed oracle looks for these substrings
	 * below the footer boundary, so content it cannot recognise makes the oracle inspect nothing
	 * and report nothing, which reads as a clean state.
	 */
	transcriptLineMarkers?: readonly string[];
}

export interface RunnerResult {
	terminal: VirtualTerminal;
	tui: TUI;
	frameState: ComposerOracleFrameState;
	evaluation: OracleEvaluationResult;
	transcript: TranscriptMock;
	/** The live editor, so a scenario can change the composer's own height. */
	editor: Editor;
	/**
	 * Everything the capture needs beyond the terminal itself.
	 *
	 * Exposed so a caller that drives operations after the mount re-reads the frame through the same
	 * code the mount used. `scrolledNotches` is the only field a caller updates: set it to the number
	 * of wheel notches currently applied before recapturing a frozen view.
	 */
	captureContext: ComposerCaptureContext;
	/** Read the frame as it stands now and judge it again. */
	recapture: () => { frameState: ComposerOracleFrameState; evaluation: OracleEvaluationResult };
	advance: () => Promise<void>;
	cleanUp: () => void;
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

	const partNames = new Map<Component, string>([
		[transcript, "TranscriptMock"],
		[statusContainer, "statusContainer"],
		[statusLine, "statusLine"],
		[hookWidgetsAbove, "hookWidgetsAbove"],
		[editorContainer, "Editor"],
		[capabilityLine, "QuietZoneLine"],
		[shortcuts, "ComposerShortcuts"],
		[hookWidgetsBelow, "hookWidgetsBelow"],
	]);

	let expectedPromptGlyph = "›";
	if (accentState.bypass) expectedPromptGlyph = "!";
	else if (accentState.bashMode) expectedPromptGlyph = "$";
	else if (accentState.planMode) expectedPromptGlyph = "◈";

	// The live footer has to be read before anything freezes the view, because it is the baseline the
	// frozen-view oracle compares the painted footer against.
	const liveLedger = composerSegments(tui, width, partNames);
	const liveFooterLines = liveFooterFromViewport(
		term,
		height,
		liveLedger.totalFrameRows,
		footerRowsOf(liveLedger.segments, mountedCount),
	);

	const captureContext: ComposerCaptureContext = {
		term,
		tui,
		width,
		height,
		pinnedFooterChildCount: mountedCount,
		segmentNames: partNames,
		probes: { capabilityLine, shortcuts },
		transcriptLineMarkers: options.transcriptLineMarkers ?? ["transcript-output-line-"],
		expectedPromptGlyph,
		editorFocused: options.focused !== false,
		liveFooterLines,
		scrolledNotches: 0,
	};

	if (options.scrollOffset && options.scrollOffset > 0) {
		for (let i = 0; i < options.scrollOffset; i++) {
			term.sendInput(WHEEL_UP);
			await settleFrames(term, tui);
		}
		captureContext.scrolledNotches = options.scrollOffset;
	}

	const recapture = (): { frameState: ComposerOracleFrameState; evaluation: OracleEvaluationResult } => {
		const next = captureComposerFrameState(captureContext);
		return { frameState: next, evaluation: evaluateAllComposerOracles(next) };
	};

	const first = recapture();

	return {
		terminal: term,
		tui,
		frameState: first.frameState,
		evaluation: first.evaluation,
		transcript,
		editor,
		captureContext,
		recapture,
		advance: async () => {
			tui.requestRender();
			await settleFrames(term, tui);
		},
		cleanUp: () => {
			tui.stop();
		},
	};
}

/** Click probe targets, so a capture can record where a row's click was dispatched. */
interface ComposerClickProbes {
	capabilityLine: RoutableTestComponent;
	shortcuts: RoutableTestComponent;
}

/** Everything a frame capture needs that is not readable from the terminal. */
export interface ComposerCaptureContext {
	term: VirtualTerminal;
	tui: TUI;
	width: number;
	height: number;
	pinnedFooterChildCount: number;
	/** Display names for the parts the caller built. Other children use their constructor name. */
	segmentNames: ReadonlyMap<Component, string>;
	/** Probe targets, or null to read the frame without sending clicks into it. */
	probes: ComposerClickProbes | null;
	transcriptLineMarkers: readonly string[];
	expectedPromptGlyph: string;
	editorFocused: boolean;
	/** The footer as the live tail paints it, read once before anything freezes the view. */
	liveFooterLines: readonly string[];
	/** Wheel notches currently applied. Zero on the live tail. */
	scrolledNotches: number;
}

/** The ledger, and the frame length it accounts for. */
interface ComposerLedger {
	segments: FrameSegmentSnapshot[];
	totalFrameRows: number;
}

/**
 * The segment ledger, walked from the tui's own root children.
 *
 * The membership and order are the mount's, not a second copy of them. An earlier version of this
 * restated `mountComposerZone`'s eleven `addChild` calls and stood in fresh `CardPadRow` and `Spacer`
 * instances for the ones the mount had created, so a change to the zone's composition left every
 * segment-reading oracle judging a frame that was never painted. Only the display names belong to the
 * caller: three of the parts are bare Containers, which a constructor name cannot tell apart.
 */
export function composerSegments(
	tui: TUI,
	width: number,
	segmentNames: ReadonlyMap<Component, string>,
): ComposerLedger {
	const segments: FrameSegmentSnapshot[] = [];
	let offset = 0;
	for (const child of tui.children) {
		const rowCount = child.render(width)?.length ?? 0;
		segments.push({
			startIndex: offset,
			rowCount,
			componentName: segmentNames.get(child) ?? child.constructor.name,
		});
		offset += rowCount;
	}
	return { segments, totalFrameRows: offset };
}

/** Rows the last `childCount` segments occupy. */
function footerRowsOf(segments: readonly FrameSegmentSnapshot[], childCount: number): number {
	return segments.slice(-childCount).reduce((sum, s) => sum + s.rowCount, 0);
}

/** The footer as the current viewport paints it. */
function liveFooterFromViewport(
	term: VirtualTerminal,
	height: number,
	totalFrameRows: number,
	pinnedFooterRows: number,
): string[] {
	const lines = term.getViewport().map(l => stripVTControlCharacters(stripAnsi(l)));
	const footerTop = totalFrameRows < height ? totalFrameRows - pinnedFooterRows : height - pinnedFooterRows;
	const end = totalFrameRows < height ? totalFrameRows : height;
	return lines.slice(Math.max(0, footerTop), end);
}

/**
 * Read the painted frame and everything the oracles judge it by.
 *
 * One owner. A caller that drives operations after the mount and then rebuilds this by hand ends up
 * judging its own model of the composer, and the model drifts the first time the extraction changes.
 */
export function captureComposerFrameState(ctx: ComposerCaptureContext): ComposerOracleFrameState {
	const { term, tui, width, height, pinnedFooterChildCount } = ctx;
	const { segments, totalFrameRows } = composerSegments(tui, width, ctx.segmentNames);
	const pinnedFooterRows = footerRowsOf(segments, pinnedFooterChildCount);

	const rawViewportLines = term.getViewport();
	const viewportLines = rawViewportLines.map(l => stripVTControlCharacters(stripAnsi(l)));
	const cursor = term.getCursor();
	const virtualScrollTop = tui.virtualScrollActive ? ctx.scrolledNotches || 1 : null;

	// While the view is live, the footer on screen IS the baseline, so refresh it. A sequence that
	// resizes and then freezes would otherwise compare the frozen footer against a baseline captured
	// at the old width and report a difference the renderer never painted.
	if (!tui.virtualScrollActive) {
		ctx.liveFooterLines = liveFooterFromViewport(term, height, totalFrameRows, pinnedFooterRows);
	}

	let windowTopRow = 0;
	let screenBounds: ComposerOracleFrameState["screenBounds"];
	if (tui.virtualScrollActive) {
		screenBounds = {
			footerTop: height - Math.min(pinnedFooterRows, height - 1),
			footerBottom: height - 1,
			footerRowOffset: height - pinnedFooterRows,
			contentBottom: height - 1,
		};
	} else if (totalFrameRows < height) {
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

	return {
		width,
		height,
		viewportLines,
		rawViewportLines,
		cursor,
		totalFrameRows,
		windowTopRow,
		pinnedFooterChildCount,
		pinnedFooterRows,
		virtualScrollTop,
		screenBounds,
		segments,
		mouseRouting: ctx.probes ? probeClickRouting(ctx, screenBounds) : undefined,
		transcriptLineMarkers: ctx.transcriptLineMarkers,
		expectedPromptGlyph: ctx.expectedPromptGlyph,
		editorFocused: ctx.editorFocused,
		liveFooterLines: ctx.liveFooterLines,
	};
}

/**
 * Click each interesting row and record where the click landed.
 *
 * Every footer row is probed, not only the boundaries: a click offset shows up as a row in the middle
 * of the footer dispatching to the transcript, and an oracle that sees only the first and last footer
 * row never looks at the rows between them.
 */
function probeClickRouting(
	ctx: ComposerCaptureContext,
	screenBounds: ComposerOracleFrameState["screenBounds"],
): Map<number, { routedTo: string | null; localLine: number | null; col: number | null }> {
	const { term, height, probes } = ctx;
	const routing = new Map<number, { routedTo: string | null; localLine: number | null; col: number | null }>();
	if (!probes) return routing;

	const rows = new Set<number>([
		0,
		Math.max(0, screenBounds.footerTop - 1),
		screenBounds.contentBottom,
		Math.min(height - 1, screenBounds.contentBottom + 1),
	]);
	for (let row = screenBounds.footerTop; row <= Math.min(height - 1, screenBounds.footerBottom); row += 1) {
		rows.add(row);
	}

	for (const row of rows) {
		if (row < 0 || row >= height) continue;
		probes.capabilityLine.calls = [];
		probes.shortcuts.calls = [];

		term.sendInput(pressAt(row, 5));
		term.sendInput(releaseAt(row, 5));

		const hit = probes.capabilityLine.calls[0]
			? { name: "footer:capabilityLine", call: probes.capabilityLine.calls[0] }
			: probes.shortcuts.calls[0]
				? { name: "footer:shortcuts", call: probes.shortcuts.calls[0] }
				: null;

		if (hit) {
			routing.set(row, { routedTo: hit.name, localLine: hit.call.line, col: hit.call.col });
		} else if (row < screenBounds.footerTop && row <= screenBounds.contentBottom) {
			routing.set(row, { routedTo: "transcript", localLine: null, col: null });
		} else {
			routing.set(row, { routedTo: null, localLine: null, col: null });
		}
	}

	return routing;
}
