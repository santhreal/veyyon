import type { OverlayOptions, TUI } from "@veyyon/tui/tui";
import type { VirtualTerminal } from "../terminal/virtual-terminal";
import { LARGE_SCROLL } from "./constants";
import type { ChildOpsContext, EmptyOverflowOpsContext, OverlayOpsContext } from "./driver-state";
import type { StressModel } from "./model";
import { type AppliedOperation, contentOperation, forceRenderOperation, viewOperation } from "./operations";
import { type StressComponent, StressOverlayComponent, StressOverlayModel } from "./overlay-model";
import type { StressRandomStreams } from "./random";
import {
	type JsonObject,
	OVERLAY_ANCHORS,
	type Scenario,
	type StressChildEntry,
	type StressOverlayEntry,
	type TerminalStressTraits,
} from "./types";

export function pickDifferent(streams: StressRandomStreams, values: readonly number[], current: number): number {
	const candidates = values.filter(value => value !== current);
	return candidates.length === 0 ? current : streams.geometry.pick(candidates);
}

export function pickOverlay(
	overlays: StressOverlayEntry[],
	rng: StressRandomStreams["overlay"],
): StressOverlayEntry | undefined {
	if (overlays.length === 0) return undefined;
	return overlays[rng.int(0, overlays.length - 1)];
}

export function randomOverlayOptions(
	streams: StressRandomStreams,
	termColumns: number,
	termRows: number,
): { options: OverlayOptions; detail: JsonObject } {
	const rng = streams.overlay;
	const options: OverlayOptions = {};
	const detail: JsonObject = {};
	if (rng.chance(0.75)) {
		const width = rng.chance(0.35)
			? (`${rng.pick([25, 40, 60, 80])}%` as `${number}%`)
			: rng.int(1, Math.max(1, termColumns + 8));
		options.width = width;
		detail.width = width;
	}
	if (rng.chance(0.35)) {
		const maxHeight = rng.chance(0.35)
			? (`${rng.pick([25, 50, 75])}%` as `${number}%`)
			: rng.int(1, Math.max(1, termRows));
		options.maxHeight = maxHeight;
		detail.maxHeight = maxHeight;
	}
	if (rng.chance(0.25)) {
		const minWidth = rng.int(1, Math.max(1, termColumns + 4));
		options.minWidth = minWidth;
		detail.minWidth = minWidth;
	}
	if (rng.chance(0.5)) {
		const anchor = rng.pick(OVERLAY_ANCHORS);
		options.anchor = anchor;
		options.offsetX = rng.int(-3, 3);
		options.offsetY = rng.int(-2, 2);
		detail.anchor = anchor;
		detail.offsetX = options.offsetX;
		detail.offsetY = options.offsetY;
	} else {
		const row = rng.chance(0.45) ? (`${rng.pick([0, 25, 50, 75, 100])}%` as `${number}%`) : rng.int(-2, termRows + 2);
		const col = rng.chance(0.45)
			? (`${rng.pick([0, 25, 50, 75, 100])}%` as `${number}%`)
			: rng.int(-4, termColumns + 4);
		options.row = row;
		options.col = col;
		detail.row = row;
		detail.col = col;
	}
	if (rng.chance(0.6)) {
		if (rng.chance(0.5)) {
			const margin = rng.int(0, 2);
			options.margin = margin;
			detail.margin = margin;
		} else {
			const margin = {
				top: rng.int(0, 2),
				right: rng.int(0, 2),
				bottom: rng.int(0, 2),
				left: rng.int(0, 2),
			};
			options.margin = margin;
			detail.margin = margin;
		}
	}
	return { options, detail };
}

export async function showOverlay(context: OverlayOpsContext): Promise<AppliedOperation> {
	const id = context.allocOverlayId();
	const model = new StressOverlayModel(context.streams.overlay, id);
	const component = new StressOverlayComponent(model);
	const { options, detail } = randomOverlayOptions(context.streams, context.term.columns, context.term.rows);
	const handle = context.tui.showOverlay(component, options);
	const entry: StressOverlayEntry = {
		id,
		sentinel: model.sentinel,
		model,
		component,
		handle,
		options,
		hidden: false,
		detail,
	};
	context.overlays.push(entry);
	await context.settle();
	return viewOperation("showOverlay", {
		id,
		sentinel: model.sentinel,
		options: detail,
		lines: model.debugLines(),
	});
}

export async function hideOverlay(context: OverlayOpsContext): Promise<AppliedOperation> {
	const entry = pickOverlay(context.overlays, context.streams.overlay);
	if (entry === undefined) return viewOperation("hideOverlay", { skipped: true });
	entry.handle.hide();
	const remaining = context.overlays.filter(overlay => overlay !== entry);
	context.overlays.length = 0;
	context.overlays.push(...remaining);
	context.hiddenOverlaySentinels.add(entry.sentinel);
	await context.settle();
	return viewOperation("hideOverlay", { id: entry.id, sentinel: entry.sentinel });
}

export async function toggleOverlayHidden(context: OverlayOpsContext): Promise<AppliedOperation> {
	const entry = pickOverlay(context.overlays, context.streams.overlay);
	if (entry === undefined) return viewOperation("toggleOverlayHidden", { skipped: true });
	entry.hidden = !entry.hidden;
	entry.handle.setHidden(entry.hidden);
	if (entry.hidden) context.hiddenOverlaySentinels.add(entry.sentinel);
	await context.settle();
	return viewOperation("toggleOverlayHidden", {
		id: entry.id,
		sentinel: entry.sentinel,
		hidden: entry.hidden,
	});
}

export async function editOverlay(context: OverlayOpsContext): Promise<AppliedOperation> {
	const entry = pickOverlay(context.overlays, context.streams.overlay);
	if (entry === undefined) return viewOperation("editOverlay", { skipped: true });
	const detail = entry.model.mutate(context.term.columns);
	context.tui.requestRender();
	await context.settle();
	return viewOperation("editOverlay", { id: entry.id, detail });
}

export async function moveOverlayCursor(context: OverlayOpsContext): Promise<AppliedOperation> {
	const entry = pickOverlay(context.overlays, context.streams.overlay);
	if (entry === undefined) return viewOperation("moveOverlayCursor", { skipped: true });
	const cursor = entry.model.setCursor(context.term.columns);
	context.tui.setFocus(entry.component);
	context.tui.requestRender();
	await context.settle();
	return viewOperation("moveOverlayCursor", { id: entry.id, cursor });
}

export async function moveBaseCursor(
	component: StressComponent,
	model: StressModel,
	tui: TUI,
	term: VirtualTerminal,
	settle: () => Promise<void>,
	kind: "moveCursorVisible" | "moveCursorOffscreen",
	offscreen: boolean,
): Promise<AppliedOperation> {
	const cursor = offscreen
		? model.setCursorOffscreen(term.rows, term.columns)
		: model.setCursorVisible(term.rows, term.columns);
	tui.setFocus(component);
	tui.requestRender();
	await settle();
	return viewOperation(kind, { cursor });
}

export async function toggleFocusInput(
	component: StressComponent,
	model: StressModel,
	tui: TUI,
	term: VirtualTerminal,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	let cursor: JsonObject | null = null;
	if (component.focused) {
		tui.setFocus(null);
	} else {
		cursor = streams.cursor.chance(0.25)
			? model.setCursorOffscreen(term.rows, term.columns)
			: model.setCursorVisible(term.rows, term.columns);
		tui.setFocus(component);
	}
	tui.requestRender();
	await settle();
	return viewOperation("toggleFocusInput", { focused: component.focused, cursor });
}

export function syncChildOrder(children: StressChildEntry[], component: StressComponent, tui: TUI): void {
	for (const child of children) tui.removeChild(child.component);
	tui.removeChild(component);
	tui.addChild(component);
	for (const child of children) {
		if (child.active) tui.addChild(child.component);
	}
}

export async function attachChild(context: ChildOpsContext): Promise<AppliedOperation> {
	const child = context.children.find(entry => !entry.active);
	if (child === undefined) return viewOperation("attachChild", { skipped: true });
	child.active = true;
	syncChildOrder(context.children, context.component, context.tui);
	context.renderContentFrame();
	await context.settle();
	return contentOperation("attachChild", { id: child.id, lines: child.model.debugLines() }, false);
}

export async function detachChild(context: ChildOpsContext): Promise<AppliedOperation> {
	const active = context.children.filter(entry => entry.active);
	const child = active.length === 0 ? undefined : active[context.streams.children.int(0, active.length - 1)];
	if (child === undefined) return viewOperation("detachChild", { skipped: true });
	child.active = false;
	context.tui.removeChild(child.component);
	context.renderContentFrame();
	await context.settle();
	return contentOperation("detachChild", { id: child.id }, false);
}

export async function reorderChildren(context: ChildOpsContext): Promise<AppliedOperation> {
	const active = context.children.filter(entry => entry.active);
	if (active.length < 2) return viewOperation("reorderChildren", { skipped: true });
	const first = context.children.shift();
	if (first !== undefined) context.children.push(first);
	syncChildOrder(context.children, context.component, context.tui);
	context.renderContentFrame();
	await context.settle();
	return contentOperation(
		"reorderChildren",
		{ activeOrder: context.children.filter(child => child.active).map(child => child.id) },
		false,
	);
}

export async function mutateChild(context: ChildOpsContext): Promise<AppliedOperation> {
	const active = context.children.filter(entry => entry.active);
	const child = active.length === 0 ? undefined : active[context.streams.children.int(0, active.length - 1)];
	if (child === undefined) return viewOperation("mutateChild", { skipped: true });
	const detail = context.streams.children.chance(0.5)
		? child.model.appendSmall()
		: child.model.editVisibleLine(context.term.rows);
	context.renderContentFrame();
	await context.settle();
	return contentOperation("mutateChild", { id: child.id, detail }, false);
}

export async function resizeBoth(
	scenario: Scenario,
	traits: TerminalStressTraits,
	term: VirtualTerminal,
	tui: TUI,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const columns = pickDifferent(streams, scenario.widthChoices, term.columns);
	const rows = pickDifferent(streams, scenario.heightChoices, term.rows);
	term.resize(columns, rows);
	if (!traits.strictNativeScrollback && !traits.foregroundStreaming) {
		tui.requestRender(true);
	}
	await settle();
	return viewOperation("resizeBoth", { columns, rows }, { geometryChanged: true, mutatesViewport: true });
}

export async function resizeNoop(term: VirtualTerminal, settle: () => Promise<void>): Promise<AppliedOperation> {
	term.resize(term.columns, term.rows);
	await settle();
	return viewOperation("resizeNoop", { columns: term.columns, rows: term.rows });
}

export async function scrollUp(
	term: VirtualTerminal,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const amount = streams.geometry.int(1, Math.max(1, term.rows * 2));
	term.scrollLines(-amount);
	await settle();
	return viewOperation("scrollUp", { amount }, { mutatesViewport: true });
}

export async function scrollToBottom(
	term: VirtualTerminal,
	tui: TUI,
	traits: TerminalStressTraits,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	term.scrollLines(LARGE_SCROLL);
	tui.requestRender(true, { clearScrollback: traits.strictNativeScrollback });
	await settle();
	return forceRenderOperation(
		"scrollToBottom",
		{ forcedCheckpoint: traits.strictNativeScrollback },
		{ checkpoint: true, mutatesViewport: true },
	);
}

export async function scrollPartial(
	term: VirtualTerminal,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const amount = streams.geometry.int(1, Math.max(1, term.rows));
	const direction = streams.geometry.chance(0.5) ? -1 : 1;
	term.scrollLines(direction * amount);
	await settle();
	return viewOperation("scrollPartial", { amount: direction * amount }, { mutatesViewport: true });
}

export async function resizeWidth(
	scenario: Scenario,
	traits: TerminalStressTraits,
	term: VirtualTerminal,
	tui: TUI,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const columns = pickDifferent(streams, scenario.widthChoices, term.columns);
	term.resize(columns, term.rows);
	if (!traits.strictNativeScrollback && !traits.foregroundStreaming) {
		tui.requestRender(true);
	}
	await settle();
	return viewOperation("resizeWidth", { columns }, { geometryChanged: true, mutatesViewport: true });
}

export async function resizeHeight(
	scenario: Scenario,
	traits: TerminalStressTraits,
	term: VirtualTerminal,
	tui: TUI,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const rows = pickDifferent(streams, scenario.heightChoices, term.rows);
	term.resize(term.columns, rows);
	if (!traits.strictNativeScrollback && !traits.foregroundStreaming) {
		tui.requestRender(true);
	}
	await settle();
	return viewOperation("resizeHeight", { rows }, { geometryChanged: true, mutatesViewport: true });
}

export async function resizeWithAppend(
	scenario: Scenario,
	model: StressModel,
	term: VirtualTerminal,
	streams: StressRandomStreams,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	const appended = model.appendSmall();
	const rows = pickDifferent(streams, scenario.heightChoices, term.rows);
	const columns = streams.geometry.chance(0.5)
		? pickDifferent(streams, scenario.widthChoices, term.columns)
		: term.columns;
	term.resize(columns, rows);
	await settle();
	return contentOperation("resizeWithAppend", { appended, columns, rows }, false, {
		geometryChanged: true,
		mutatesViewport: true,
	});
}

export async function forceRender(tui: TUI, settle: () => Promise<void>): Promise<AppliedOperation> {
	tui.requestRender(true);
	await settle();
	return forceRenderOperation("forceRender", {});
}

export async function forceRenderAllowUnknown(tui: TUI, settle: () => Promise<void>): Promise<AppliedOperation> {
	tui.requestRender(true);
	await settle();
	return forceRenderOperation("forceRenderAllowUnknown", {});
}

export async function forceRenderClearScrollback(
	term: VirtualTerminal,
	tui: TUI,
	settle: () => Promise<void>,
): Promise<AppliedOperation> {
	term.scrollLines(LARGE_SCROLL);
	tui.requestRender(true, { clearScrollback: true });
	await settle();
	return {
		...forceRenderOperation("forceRenderClearScrollback", { clearScrollback: true }, { mutatesViewport: true }),
		checkpoint: true,
	};
}

export async function forceRenderAfterEmptyOverflow(context: EmptyOverflowOpsContext): Promise<AppliedOperation> {
	const detachedChildren: number[] = [];
	for (const child of context.children) {
		if (!child.active) continue;
		child.active = false;
		detachedChildren.push(child.id);
		context.tui.removeChild(child.component);
	}
	const empty = context.model.clear();
	context.tui.requestRender(true, { clearScrollback: true });
	await context.settle();
	const clearedFrameLength = context.expectedFrame().frame.length;
	const overflowCount = context.term.rows + context.streams.geometry.int(1, 4);
	const overflow = context.model.appendCount(overflowCount, "overflow");
	context.tui.requestRender(true);
	await context.settle();
	return {
		...forceRenderOperation(
			"forceRenderAfterEmptyOverflow",
			{ detachedChildren, empty, overflow },
			{ mutatesViewport: true },
		),
		mutatesContent: true,
		transientFrameGrowth: clearedFrameLength + overflowCount,
	};
}
