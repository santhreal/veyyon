import type { TUI } from "@veyyon/tui/tui";
import type { JsonValue } from "@veyyon/utils";
import type { VirtualTerminal } from "../terminal/virtual-terminal";
import { LARGE_SCROLL } from "./constants";
import type { BurstStepContext, CheckpointContext, CoalescedBurstContext } from "./driver-state";
import { pickDifferent } from "./driver-view-ops";
import type { StressModel } from "./model";
import { type AppliedOperation, BURST_STEP_METADATA, contentOperation } from "./operations";
import type { StressRandomStreams, WeightedCandidate } from "./random";
import { weightedPick } from "./random";
import { assertNever } from "./traits";
import type { StressOverlayEntry } from "./types";
import {
	BURST_STEP_KINDS,
	type BurstStepKind,
	type JsonObject,
	type OperationKind,
	type Scenario,
	type Snapshot,
	type StressChildEntry,
	type TerminalStressTraits,
} from "./types";

export function chooseOperation(
	scenario: Scenario,
	traits: TerminalStressTraits,
	streams: StressRandomStreams,
	overlays: StressOverlayEntry[],
	children: StressChildEntry[],
	index: number,
	before: Snapshot,
	hasVisibleOverlay: () => boolean,
): OperationKind {
	if ((traits.ed3ScrollbackEraseRisk || traits.conptyHostScrollbackUnobservable) && before.position.baseY > 0) {
		if (before.atBottom && index % 47 === 0) return "scrollUp";
		if (!before.atBottom && index % 47 === 1) {
			return traits.foregroundStreaming ? "streamOne" : "eagerStreamingMutation";
		}
	}

	if (
		traits.strictNativeScrollback &&
		before.atBottom &&
		before.frame.length > before.height + 8 &&
		index % 43 === 0
	) {
		return "collapseToFew";
	}
	if (
		traits.strictNativeScrollback &&
		before.atBottom &&
		before.frame.length > before.height + 8 &&
		!hasVisibleOverlay() &&
		index % 37 === 0
	) {
		return "highWaterPreviewCollapse";
	}
	if (traits.strictNativeScrollback && before.atBottom && index % 41 === 0) {
		return "offscreenEditAppendRepeatedTail";
	}
	if (!before.atBottom && streams.ops.chance(0.28)) {
		return "scrollToBottom";
	}

	// Exact-width rows are the pending-wrap / DECAWM boundary case: a row whose
	// visible width equals the terminal width writes its last cell, latching
	// pending-wrap on autowrap terminals so a following cursor move can wrap and
	// staircase. The renderer disables autowrap around paints (\x1b[?7l). Skipped
	// for uniqueContent scenarios — at width 1-2 the finite cell alphabet cannot
	// stay unique across hundreds of ops.
	const weighted: readonly WeightedCandidate<OperationKind>[] = [
		{ item: "appendSmall", weight: 14 },
		{ item: "streamOne", weight: 12 },
		{ item: "appendExactWidth", weight: scenario.uniqueContent ? 0 : 5 },
		{ item: "appendRepeatedTail", weight: scenario.uniqueContent ? 2 : 8 },
		{ item: "appendDuplicateOfExisting", weight: scenario.uniqueContent ? 2 : 8 },
		{ item: "injectBlankCluster", weight: 5 },
		{ item: "appendBulk", weight: 3 },
		{ item: "editVisibleLine", weight: 8 },
		{ item: "editOffscreenLine", weight: 7 },
		{ item: "offscreenEditAppendRepeatedTail", weight: 5 },
		{ item: "insertOffscreen", weight: 3 },
		{ item: "insertMiddle", weight: 2 },
		{ item: "deleteTrailing", weight: 3 },
		{ item: "deleteMiddle", weight: 2 },
		{ item: "replaceAll", weight: 1 },
		{ item: "toggleCollapsible", weight: 2 },
		{ item: "tickStatusHeader", weight: 8 },
		{ item: "scrollUp", weight: before.position.baseY > 0 ? 4 : 0 },
		{ item: "scrollPartial", weight: before.position.baseY > 0 ? 3 : 0 },
		{ item: "scrollToBottom", weight: before.atBottom ? 2 : 8 },
		{ item: "resizeWidth", weight: 3 },
		{ item: "resizeHeight", weight: 3 },
		{ item: "forceRender", weight: 2 },
		{ item: "forceRenderAllowUnknown", weight: 2 },
		{ item: "forceRenderClearScrollback", weight: 1 },
		{ item: "forceRenderAfterEmptyOverflow", weight: 1 },
		{ item: "toggleFocusInput", weight: 2 },
		{ item: "moveCursorVisible", weight: 3 },
		{ item: "moveCursorOffscreen", weight: 2 },
		{ item: "showOverlay", weight: overlays.length < 2 ? 3 : 1 },
		{ item: "hideOverlay", weight: overlays.length > 0 ? 2 : 0 },
		{ item: "toggleOverlayHidden", weight: overlays.length > 0 ? 2 : 0 },
		{ item: "editOverlay", weight: overlays.length > 0 ? 4 : 0 },
		{ item: "moveOverlayCursor", weight: overlays.length > 0 ? 2 : 0 },
		{ item: "coalescedBurst", weight: 6 },
		{ item: "rotateUp", weight: 4 },
		{ item: "swapOffscreenRows", weight: 3 },
		{ item: "collapseToFew", weight: 1 },
		{ item: "highWaterPreviewCollapse", weight: 2 },
		// `eagerStreamingMutation` toggles the eager opt-in off in its `finally`,
		// which would end the modeled foreground-tool turn early; a foregroundStream
		// scenario keeps the opt-in on for its whole run, so skip it there.
		{
			item: "eagerStreamingMutation",
			weight: traits.preservesPaneHistory || traits.foregroundStreaming ? 0 : 3,
		},
		{ item: "resizeBoth", weight: 2 },
		{ item: "resizeNoop", weight: 1 },
		{ item: "resizeWithAppend", weight: 2 },
		{ item: "attachChild", weight: children.some(child => !child.active) ? 2 : 0 },
		{ item: "detachChild", weight: children.some(child => child.active) ? 2 : 0 },
		{ item: "reorderChildren", weight: children.filter(child => child.active).length > 1 ? 1 : 0 },
		{ item: "mutateChild", weight: children.some(child => child.active) ? 3 : 0 },
	];
	return weightedPick(streams.ops, weighted);
}

export function renderContentFrame(tui: TUI, term: VirtualTerminal, traits: TerminalStressTraits): void {
	if (traits.foregroundStreaming) {
		// A foreground tool's own re-render: a plain, non-forced request. The
		// renderer keeps the live tail through `viewportRepaint`/`diff`;
		// offscreen-edit growth advances the rendered line count without
		// committing the overflow to native history, which is the lagging
		// high-water state a later shrink must still re-anchor from.
		tui.requestRender();
		return;
	}
	const position = term.getBufferPosition();
	const atBottom = position.viewportY >= position.baseY;
	if (!traits.strictNativeScrollback && atBottom) {
		tui.requestRender(true);
	} else {
		tui.requestRender();
	}
}

export async function applyContent(
	renderContentFrameFn: () => void,
	settle: () => Promise<void>,
	kind: OperationKind,
	detail: JsonObject,
	checksRowAccounting: boolean,
): Promise<AppliedOperation> {
	renderContentFrameFn();
	await settle();
	return contentOperation(kind, detail, checksRowAccounting);
}

export async function eagerStreamingMutation(
	model: StressModel,
	streams: StressRandomStreams,
	termRows: number,
	renderContentFrameFn: () => void,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const detail: JsonObject = streams.content.chance(0.5) ? model.streamOne() : model.editOffscreenLine(termRows);
	renderContentFrameFn();
	await settle();
	return contentOperation("eagerStreamingMutation", detail, false);
}

export async function highWaterPreviewCollapse(
	model: StressModel,
	termRows: number,
	renderContentFrameFn: () => void,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	// `beginHighWaterPreview` first pads seed rows up to `height + 8`, THEN
	// pushes the preview rows — so the op's true peak frame growth is the
	// padding plus the preview count, not the preview count alone. In a
	// multiplexer every one of those overflowing rows enters irretractable pane
	// history, so the transient bound must measure the actual expansion.
	const lengthBeforeBegin = model.lines.length;
	const begin = model.beginHighWaterPreview(termRows);
	const expandedFrameGrowth = model.lines.length - lengthBeforeBegin;
	renderContentFrameFn();
	await settle();
	const start = typeof begin.start === "number" ? begin.start : 0;
	const count = typeof begin.count === "number" ? begin.count : 0;
	const collapse = model.collapseHighWaterPreview(start, count);
	renderContentFrameFn();
	await settle();
	return {
		kind: "highWaterPreviewCollapse",
		detail: { begin, collapse },
		mutatesContent: true,
		checksRowAccounting: false,
		geometryChanged: false,
		forcedRender: false,
		mutatesViewport: false,
		checkpoint: false,
		// The preview rows AND the seed-padding rows that begin appended scroll
		// into history while expanded; the collapse cannot retract them, and a
		// multiplexer pane keeps every one. Bound by the measured expansion.
		transientFrameGrowth: Math.max(count, expandedFrameGrowth),
	};
}

export function applyBurstStep(context: BurstStepContext, kind: BurstStepKind): JsonObject {
	switch (kind) {
		case "appendSmall":
			return context.model.appendSmall();
		case "streamOne":
			return context.model.streamOne();
		case "appendRepeatedTail":
			return context.model.appendRepeatedTail();
		case "injectBlankCluster":
			return context.model.injectBlankCluster();
		case "editVisibleLine":
			return context.model.editVisibleLine(context.term.rows);
		case "editOffscreenLine":
			return context.model.editOffscreenLine(context.term.rows);
		case "tickStatusHeader":
			return context.model.tickStatusHeader();
		case "resizeWidth": {
			const columns = pickDifferent(context.streams, context.scenario.widthChoices, context.term.columns);
			context.term.resize(columns, context.term.rows);
			return { columns };
		}
		case "resizeHeight": {
			const rows = pickDifferent(context.streams, context.scenario.heightChoices, context.term.rows);
			context.term.resize(context.term.columns, rows);
			return { rows };
		}
		case "scrollPartial": {
			const amount = context.streams.geometry.int(1, Math.max(1, context.term.rows));
			const direction = context.streams.geometry.chance(0.5) ? -1 : 1;
			context.term.scrollLines(direction * amount);
			return { amount: direction * amount };
		}
		case "scrollToBottom":
			context.term.scrollLines(LARGE_SCROLL);
			return { amount: LARGE_SCROLL };
		case "forceRender":
			context.tui.requestRender(true);
			return {};
		default:
			return assertNever(kind);
	}
}

export async function coalescedBurst(context: CoalescedBurstContext): Promise<AppliedOperation> {
	const count = context.streams.ops.int(2, 6);
	const steps: JsonValue[] = [];
	let mutatesContent = false;
	let geometryChanged = false;
	let forcedRender = false;
	let mutatesViewport = false;
	for (let i = 0; i < count; i++) {
		const stepKind = context.streams.ops.pick(BURST_STEP_KINDS);
		const detail = applyBurstStep(context, stepKind);
		steps.push({ kind: stepKind, detail });
		const metadata = BURST_STEP_METADATA[stepKind];
		mutatesContent ||= metadata.mutatesContent;
		geometryChanged ||= metadata.geometryChanged;
		mutatesViewport ||= metadata.mutatesViewport;
		forcedRender ||= metadata.forcedRender;
		// Schedule without settling so the throttle coalesces every step into one paint.
		if (stepKind !== "forceRender") context.tui.requestRender();
	}
	context.renderContentFrame();
	await context.settle();
	return {
		kind: "coalescedBurst",
		detail: { count, steps },
		mutatesContent,
		checksRowAccounting: false,
		geometryChanged,
		forcedRender,
		mutatesViewport,
		checkpoint: false,
		coalesced: true,
	};
}

export async function checkpoint(
	context: CheckpointContext,
	snapshot: () => Snapshot,
	recordOperation: (
		index: number,
		kind: "periodicCheckpoint",
		detail: JsonObject,
		before: Snapshot,
		after: Snapshot,
	) => void,
	assertOracles: (op: AppliedOperation, before: Snapshot, after: Snapshot, index: number) => void,
	index: number,
	kind: "periodicCheckpoint",
): Promise<void> {
	const before = snapshot();
	// Model a prompt submit: the editor keystroke pins the terminal to the
	// bottom, then the app reconciles any deferred native-scrollback rewrite
	// only if the renderer can prove the native host viewport is at the tail.
	context.term.scrollLines(LARGE_SCROLL);
	let reconcilesNativeScrollback = false;
	if (context.traits.strictNativeScrollback || context.traits.preservesPaneHistory) {
		// Normal POSIX uses a /clear-style forced rebuild; tmux keeps its forced
		// repaint (its pane history cannot be destructively reconciled).
		context.tui.requestRender(true, {
			clearScrollback: context.traits.strictNativeScrollback,
		});
		reconcilesNativeScrollback = context.traits.strictNativeScrollback;
	} else {
		// Unknown-viewport / ED3-risk / Windows hosts: the deferred
		// native-scrollback reconciliation no longer exists, so a prompt submit
		// is a plain forced render that never destructively rewrites native
		// scrollback.
		context.tui.requestRender(true);
	}
	await context.settle();
	const after = snapshot();
	recordOperation(index, kind, { forcedCheckpoint: context.traits.strictNativeScrollback }, before, after);
	assertOracles(
		{
			kind: "scrollToBottom",
			detail: { periodic: true },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: true,
			mutatesViewport: true,
			checkpoint: true,
			reconcilesNativeScrollback,
		},
		before,
		after,
		index,
	);
}
