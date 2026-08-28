import { CURSOR_MARKER, TUI } from "@veyyon/tui/tui";
import { StressRenderScheduler } from "../frames/scheduler";
import type { VirtualTerminal } from "../terminal/virtual-terminal";
import { assertOracles } from "./driver-assertions";
import { applyOperation, checkpoint, chooseOperation, renderContentFrame } from "./driver-operations";
import {
	applyShadowWrite,
	createDriverShadowState,
	type DriverShadowState,
	syncShadowCommitted,
} from "./driver-shadow";
import { failStressInvariant } from "./driver-state";
import {
	compositeExpectedOverlays,
	createTerminal,
	expectedFrameFromLines,
	expectedTerminalLine,
	isExpectedOverlayVisible,
	normalizeLines,
} from "./expected-frame";
import { StressModel } from "./model";
import type { AppliedOperation, OperationLogEntry, OperationLogKind } from "./operations";
import { StressComponent } from "./overlay-model";
import { createRandomStreams, type StressRandomStreams } from "./random";
import { maxOf } from "./snapshot";
import { terminalStressTraits } from "./traits";
import type {
	ExpectedFrame,
	JsonObject,
	Scenario,
	Snapshot,
	StressChildEntry,
	StressOverlayEntry,
	TerminalStressTraits,
} from "./types";

interface MutableTerminalHook {
	write: (data: string) => void;
	resize: (columns: number, rows: number) => void;
}

interface MutableTuiHook {
	render: (width: number) => readonly string[];
}

export class StressDriver {
	#scenario: Scenario;
	#streams: StressRandomStreams;
	#traits: TerminalStressTraits;
	#scheduler: StressRenderScheduler;
	#term: VirtualTerminal;
	#tui: TUI;
	#model: StressModel;
	#component: StressComponent;
	#children: StressChildEntry[] = [];
	#overlays: StressOverlayEntry[] = [];
	#hiddenOverlaySentinels = new Set<string>();
	#nextOverlayId = 0;
	#opLog: OperationLogEntry[] = [];
	#operationCoverage = new Map<OperationLogKind, number>();
	// Lines that legitimately appeared 2+ times in any committed frame. Native
	// scrollback retains rows from every past frame — content that leaves the
	// frame (a detached child, collapsed preview, truncation-colliding rows
	// after a width shrink) keeps its committed copies in history forever, so
	// the duplicate oracle must allow them cumulatively, not just against the
	// current frame.
	#everDuplicatedFrameLines = new Set<string>();
	// Shadow commit ledger and synchronized-output tracking state.
	#shadow: DriverShadowState;

	constructor(scenario: Scenario) {
		this.#scenario = scenario;
		this.#streams = createRandomStreams(scenario.seed);
		this.#traits = terminalStressTraits(scenario);
		this.#scheduler = new StressRenderScheduler();
		this.#shadow = createDriverShadowState();
		const maxHeight = maxOf(scenario.heightChoices);
		this.#model = new StressModel(this.#streams.content, maxHeight + 12, scenario.uniqueContent, "root-");
		this.#component = new StressComponent(this.#model, scenario.reflow);
		this.#children = [0, 1].map(id => {
			const model = new StressModel(
				this.#streams.children,
				Math.max(1, Math.min(3, maxHeight)),
				scenario.uniqueContent,
				`child${id}-`,
			);
			return { id, model, component: new StressComponent(model, scenario.reflow), active: false };
		});
		this.#term = createTerminal(scenario);
		// Capture every byte written to the terminal so per-op oracles can audit
		// emission discipline (synchronized-output bracketing, autowrap restore).
		const realWrite = this.#term.write.bind(this.#term);
		const terminalHook = this.#term as unknown as MutableTerminalHook;
		terminalHook.write = (data: string) => {
			this.#shadow.writeLog.push(data);
			realWrite(data);
			applyShadowWrite(this.#shadow, this.#tui.committedRows, data);
		};
		// Mirror the engine's resize-event signal: a net-unchanged resize still
		// reflows the terminal, and the engine classifies it as a geometry frame
		// (audit skipped, commits frozen in multiplexers) — a dimension compare
		// alone cannot see it.
		const realResize = this.#term.resize.bind(this.#term);
		terminalHook.resize = (columns: number, rows: number) => {
			this.#shadow.shadowResizePending = true;
			realResize(columns, rows);
		};
		this.#tui = new TUI(this.#term, true, { renderScheduler: this.#scheduler });
		this.#tui.addChild(this.#component);
		const realRender = this.#tui.render.bind(this.#tui);
		const tuiHook = this.#tui as unknown as MutableTuiHook;
		tuiHook.render = (width: number) => {
			const lines = realRender(width);
			this.#shadow.shadowFrameGeometryChanged =
				this.#shadow.shadowResizePending ||
				(this.#shadow.shadowFrameWidth > 0 &&
					(width !== this.#shadow.shadowFrameWidth || this.#term.rows !== this.#shadow.shadowFrameHeight));
			this.#shadow.shadowResizePending = false;
			// Sync BEFORE overwriting the shadow frame: any commits raised by the
			// previous frame's emit must materialize from the frame that was on
			// screen when they scrolled off, not from the frame about to render.
			syncShadowCommitted(this.#shadow, this.#tui.committedRows);
			// Markers are engine-internal sentinels; the engine strips them from
			// this same array immediately after render returns, and its commit
			// ledger (prefix + audit) only ever sees stripped rows — mirror that
			// exactly. (Also: stripVTControlCharacters would otherwise swallow
			// everything after an APC introducer during normalization.)
			const stripped = lines.map(line => (line.includes(CURSOR_MARKER) ? line.replaceAll(CURSOR_MARKER, "") : line));
			this.#shadow.shadowFrame = stripped.map(line => expectedTerminalLine(line, width));
			this.#shadow.shadowFrameWidth = width;
			this.#shadow.shadowFrameHeight = this.#term.rows;
			this.#shadow.shadowFrameOverlay = this.#tui.hasOverlay();
			return lines;
		};
	}

	async run(): Promise<void> {
		try {
			this.#tui.start();
			await this.#settle();
			this.#assertOracles(
				{
					kind: "forceRender",
					detail: { initial: true },
					mutatesContent: false,
					checksRowAccounting: false,
					geometryChanged: false,
					forcedRender: true,
					mutatesViewport: false,
					checkpoint: false,
				},
				this.#snapshot(),
				this.#snapshot(),
				-1,
			);

			for (let index = 0; index < this.#scenario.iterations; index++) {
				const before = this.#snapshot();
				const kind =
					this.#scenario.replayOperations?.[index] ??
					chooseOperation(
						this.#scenario,
						this.#traits,
						this.#streams,
						this.#overlays,
						this.#children,
						index,
						before,
						() => this.#hasVisibleOverlay(),
					);
				const op = await applyOperation(
					{
						scenario: this.#scenario,
						traits: this.#traits,
						streams: this.#streams,
						term: this.#term,
						tui: this.#tui,
						model: this.#model,
						component: this.#component,
						children: this.#children,
						overlays: this.#overlays,
						hiddenOverlaySentinels: this.#hiddenOverlaySentinels,
						allocOverlayId: () => {
							const id = this.#nextOverlayId;
							this.#nextOverlayId += 1;
							return id;
						},
						expectedFrame: () => this.#expectedFrame(),
						renderContentFrame: () => this.#renderContentFrame(),
						settle: () => this.#settle(),
					},
					kind,
				);
				const after = this.#snapshot();
				this.#recordOperation(index, op.kind, op.detail, before, after);
				this.#assertOracles(op, before, after, index);

				if ((index + 1) % 50 === 0) {
					await checkpoint(
						{
							term: this.#term,
							tui: this.#tui,
							traits: this.#traits,
							settle: () => this.#settle(),
						},
						() => this.#snapshot(),
						(idx, opKind, detail, b, a) => this.#recordOperation(idx, opKind, detail, b, a),
						(o, b, a, idx) => this.#assertOracles(o, b, a, idx),
						index,
						"periodicCheckpoint",
					);
				}
			}
		} finally {
			this.#tui.stop();
			await this.#term.flush();
		}
	}

	#snapshot(): Snapshot {
		// The final emit of an op raises the engine counter after its write
		// (post-write, so the write hook saw the pre-raise value); reconcile
		// before reading tape length or the parity oracle undercounts.
		syncShadowCommitted(this.#shadow, this.#tui.committedRows);
		const position = this.#term.getBufferPosition();
		const expected = this.#expectedFrame();
		const view = normalizeLines(this.#term.getViewport());
		const viewBackgroundColumns: number[][] = [];
		for (let row = 0; row < this.#term.rows; row++) {
			viewBackgroundColumns.push(this.#term.getViewportRowBackgroundColumns(row));
		}
		// Tmux pane history is intentionally preserved, so overlay bytes can remain
		// in historical scrollback after resize/reflow. The non-strict tmux stress
		// oracle only checks live viewport behavior; avoid repeatedly materializing
		// huge preserved pane history that no invariant consumes.
		return {
			buffer: this.#traits.preservesPaneHistory ? view : normalizeLines(this.#term.getScrollBuffer()),
			view,
			viewBackgroundColumns,
			frameBackgroundColumns: expected.backgroundColumns,
			position,
			cursor: this.#term.getCursor(),
			expectedCursor: expected.cursor,
			redraws: this.#tui.fullRedraws,
			width: this.#term.columns,
			height: this.#term.rows,
			frame: expected.frame,
			atBottom: position.viewportY >= position.baseY,
			shadowTapeLength: this.#shadow.shadowTape.length,
		};
	}

	#expectedFrame(): ExpectedFrame {
		const width = this.#term.columns;
		const height = this.#term.rows;
		const baseLines = this.#baseFrameLines(width);
		const composed = compositeExpectedOverlays(baseLines, this.#overlays, width, height);
		return expectedFrameFromLines(composed, width, height);
	}

	#baseFrameLines(width: number): string[] {
		return [
			...this.#component.render(width),
			...this.#children.flatMap(child => (child.active ? child.component.render(width) : [])),
		];
	}

	#hasVisibleOverlay(): boolean {
		return this.#overlays.some(entry => isExpectedOverlayVisible(entry, this.#term.columns, this.#term.rows));
	}

	#settle(): Promise<void> {
		return this.#scheduler.drain(this.#term);
	}

	#renderContentFrame(): void {
		renderContentFrame(this.#tui, this.#term, this.#traits);
	}

	#recordOperation(
		index: number,
		kind: OperationLogKind,
		detail: JsonObject,
		before: Snapshot,
		after: Snapshot,
	): void {
		this.#operationCoverage.set(kind, (this.#operationCoverage.get(kind) ?? 0) + 1);
		this.#opLog.push({
			index,
			kind,
			detail,
			frameLengthBefore: before.frame.length,
			frameLengthAfter: after.frame.length,
			bufferLengthBefore: before.buffer.length,
			bufferLengthAfter: after.buffer.length,
			viewportYBefore: before.position.viewportY,
			viewportYAfter: after.position.viewportY,
			baseYBefore: before.position.baseY,
			baseYAfter: after.position.baseY,
			redrawsBefore: before.redraws,
			redrawsAfter: after.redraws,
		});
	}

	#assertOracles(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		assertOracles(
			{
				scenario: this.#scenario,
				traits: this.#traits,
				term: this.#term,
				overlays: this.#overlays,
				hiddenOverlaySentinels: this.#hiddenOverlaySentinels,
				everDuplicatedFrameLines: this.#everDuplicatedFrameLines,
				shadow: this.#shadow,
				hasVisibleOverlay: () => this.#hasVisibleOverlay(),
				fail: (message, o, b, a, idx, extra) => this.#fail(message, o, b, a, idx, extra),
			},
			op,
			before,
			after,
			index,
		);
	}

	#fail(
		message: string,
		op: AppliedOperation,
		before: Snapshot,
		after: Snapshot,
		index: number,
		extra: JsonObject,
	): never {
		failStressInvariant(
			{
				scenario: this.#scenario,
				opLog: this.#opLog,
				traits: this.#traits,
				operationCoverage: this.#operationCoverage,
				shadow: this.#shadow,
				writeLog: this.#shadow.writeLog,
				children: this.#children,
				overlays: this.#overlays,
				model: this.#model,
			},
			message,
			op,
			before,
			after,
			index,
			extra,
		);
	}
}
