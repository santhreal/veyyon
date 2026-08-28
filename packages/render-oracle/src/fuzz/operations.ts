import type { BurstStepKind, JsonObject, OperationKind } from "./types";

export interface AppliedOperation {
	kind: OperationKind;
	detail: JsonObject;
	mutatesContent: boolean;
	checksRowAccounting: boolean;
	geometryChanged: boolean;
	forcedRender: boolean;
	checkpoint: boolean;
	mutatesViewport: boolean;
	coalesced?: boolean;
	// Maximum number of rows the op appended to the frame at any point while it
	// ran, even if a later step inside the same op removed them again (e.g. a
	// preview expanding and collapsing). Appended rows that overflow the
	// viewport legitimately scroll into terminal history and can never be
	// retracted from multiplexer pane history, so growth oracles must allow
	// them. Defaults to the net frame growth when absent.
	transientFrameGrowth?: number;
	// The periodic prompt-submit checkpoint pins the viewport to the bottom and
	// runs the prompt-submit reconciliation (a `/clear`-style forced rebuild for
	// `normal`; other hosts get a plain forced render). Native scrollback
	// must equal the transcript only when that reconciliation actually ran:
	// ConPTY/Windows and other unobservable host-scrollback paths deliberately
	// keep dirty history deferred until the renderer gets a positive at-tail probe.
	// Plain `scrollToBottom` / forced-render ops also set `checkpoint`, but on
	// Windows hosts a forced render cannot rebuild ConPTY-hidden history, so the
	// clean-buffer oracle keys on this flag for non-`normal` scenarios.
	reconcilesNativeScrollback?: boolean;
}

export type AppliedOperationOverrides = Partial<Omit<AppliedOperation, "kind" | "detail">>;

export function appliedOperation(
	kind: OperationKind,
	detail: JsonObject,
	overrides: AppliedOperationOverrides,
): AppliedOperation {
	return {
		kind,
		detail,
		mutatesContent: false,
		checksRowAccounting: false,
		geometryChanged: false,
		forcedRender: false,
		checkpoint: false,
		mutatesViewport: false,
		...overrides,
	};
}

export function contentOperation(
	kind: OperationKind,
	detail: JsonObject,
	checksRowAccounting: boolean,
	overrides: AppliedOperationOverrides = {},
): AppliedOperation {
	return appliedOperation(kind, detail, { mutatesContent: true, checksRowAccounting, ...overrides });
}

export function viewOperation(
	kind: OperationKind,
	detail: JsonObject,
	overrides: AppliedOperationOverrides = {},
): AppliedOperation {
	return appliedOperation(kind, detail, overrides);
}

export function forceRenderOperation(
	kind: OperationKind,
	detail: JsonObject,
	overrides: AppliedOperationOverrides = {},
): AppliedOperation {
	return appliedOperation(kind, detail, { forcedRender: true, ...overrides });
}

export type OperationLogKind = OperationKind | "periodicCheckpoint";

export interface OperationLogEntry {
	index: number;
	kind: OperationLogKind;
	detail: JsonObject;
	frameLengthBefore: number;
	frameLengthAfter: number;
	bufferLengthBefore: number;
	bufferLengthAfter: number;
	viewportYBefore: number;
	viewportYAfter: number;
	baseYBefore: number;
	baseYAfter: number;
	redrawsBefore: number;
	redrawsAfter: number;
}

export interface BurstStepMetadata {
	readonly mutatesContent: boolean;
	readonly geometryChanged: boolean;
	readonly forcedRender: boolean;
	readonly mutatesViewport: boolean;
}

export const BURST_STEP_METADATA = {
	appendSmall: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	streamOne: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	appendRepeatedTail: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	injectBlankCluster: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	editVisibleLine: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	editOffscreenLine: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	tickStatusHeader: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	resizeWidth: { mutatesContent: false, geometryChanged: true, forcedRender: false, mutatesViewport: true },
	resizeHeight: { mutatesContent: false, geometryChanged: true, forcedRender: false, mutatesViewport: true },
	scrollPartial: { mutatesContent: false, geometryChanged: false, forcedRender: false, mutatesViewport: true },
	scrollToBottom: { mutatesContent: false, geometryChanged: false, forcedRender: false, mutatesViewport: true },
	forceRender: { mutatesContent: false, geometryChanged: false, forcedRender: true, mutatesViewport: true },
} satisfies Record<BurstStepKind, BurstStepMetadata>;
