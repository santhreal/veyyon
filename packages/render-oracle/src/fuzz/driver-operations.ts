import {
	applyBurstStep,
	applyContent,
	checkpoint,
	chooseOperation,
	coalescedBurst,
	eagerStreamingMutation,
	highWaterPreviewCollapse,
	renderContentFrame,
} from "./driver-content-ops";
import type { DriverApplyOpContext } from "./driver-state";
import {
	attachChild,
	detachChild,
	editOverlay,
	forceRender,
	forceRenderAfterEmptyOverflow,
	forceRenderAllowUnknown,
	forceRenderClearScrollback,
	hideOverlay,
	moveBaseCursor,
	moveOverlayCursor,
	mutateChild,
	reorderChildren,
	resizeBoth,
	resizeHeight,
	resizeNoop,
	resizeWidth,
	resizeWithAppend,
	scrollPartial,
	scrollToBottom,
	scrollUp,
	showOverlay,
	toggleFocusInput,
	toggleOverlayHidden,
} from "./driver-view-ops";
import type { AppliedOperation } from "./operations";
import { assertNever } from "./traits";
import type { OperationKind } from "./types";

export {
	applyBurstStep,
	applyContent,
	checkpoint,
	chooseOperation,
	coalescedBurst,
	eagerStreamingMutation,
	highWaterPreviewCollapse,
	renderContentFrame,
};

export async function applyOperation(context: DriverApplyOpContext, kind: OperationKind): Promise<AppliedOperation> {
	switch (kind) {
		case "appendSmall":
			return await applyContent(context.renderContentFrame, context.settle, kind, context.model.appendSmall(), true);
		case "appendExactWidth":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.appendExactWidth(context.term.columns),
				true,
			);
		case "appendBulk":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.appendBulk(context.scenario.bulkMax),
				true,
			);
		case "streamOne":
			return await applyContent(context.renderContentFrame, context.settle, kind, context.model.streamOne(), true);
		case "editVisibleLine":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.editVisibleLine(context.term.rows),
				true,
			);
		case "editOffscreenLine":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.editOffscreenLine(context.term.rows),
				true,
			);
		case "offscreenEditAppendRepeatedTail":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.offscreenEditAppendRepeatedTail(context.term.rows),
				true,
			);
		case "insertOffscreen":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.insertOffscreen(context.term.rows),
				true,
			);
		case "insertMiddle":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.insertMiddle(),
				true,
			);
		case "deleteTrailing":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.deleteTrailing(),
				false,
			);
		case "deleteMiddle":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.deleteMiddle(context.term.rows),
				true,
			);
		case "replaceAll":
			return await applyContent(context.renderContentFrame, context.settle, kind, context.model.replaceAll(), true);
		case "toggleCollapsible":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.toggleCollapsible(),
				true,
			);
		case "tickStatusHeader":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.tickStatusHeader(),
				true,
			);
		case "appendRepeatedTail":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.appendRepeatedTail(),
				true,
			);
		case "injectBlankCluster":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.injectBlankCluster(),
				true,
			);
		case "appendDuplicateOfExisting":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.appendDuplicateOfExisting(),
				true,
			);
		case "highWaterPreviewCollapse":
			return await highWaterPreviewCollapse(
				context.model,
				context.term.rows,
				context.renderContentFrame,
				context.settle,
			);
		case "eagerStreamingMutation":
			return await eagerStreamingMutation(
				context.model,
				context.streams,
				context.term.rows,
				context.renderContentFrame,
				context.settle,
			);
		case "scrollUp":
			return await scrollUp(context.term, context.streams, context.settle);
		case "scrollToBottom":
			return await scrollToBottom(context.term, context.tui, context.traits, context.settle);
		case "scrollPartial":
			return await scrollPartial(context.term, context.streams, context.settle);
		case "resizeWidth":
			return await resizeWidth(
				context.scenario,
				context.traits,
				context.term,
				context.tui,
				context.streams,
				context.settle,
			);
		case "resizeHeight":
			return await resizeHeight(
				context.scenario,
				context.traits,
				context.term,
				context.tui,
				context.streams,
				context.settle,
			);
		case "resizeWithAppend":
			return await resizeWithAppend(context.scenario, context.model, context.term, context.streams, context.settle);
		case "forceRender":
			return await forceRender(context.tui, context.settle);
		case "forceRenderAllowUnknown":
			return await forceRenderAllowUnknown(context.tui, context.settle);
		case "forceRenderClearScrollback":
			return await forceRenderClearScrollback(context.term, context.tui, context.settle);
		case "forceRenderAfterEmptyOverflow":
			return await forceRenderAfterEmptyOverflow({
				children: context.children,
				component: context.component,
				model: context.model,
				tui: context.tui,
				term: context.term,
				streams: context.streams,
				expectedFrame: context.expectedFrame,
				settle: context.settle,
			});
		case "toggleFocusInput":
			return await toggleFocusInput(
				context.component,
				context.model,
				context.tui,
				context.term,
				context.streams,
				context.settle,
			);
		case "moveCursorVisible":
			return await moveBaseCursor(
				context.component,
				context.model,
				context.tui,
				context.term,
				context.settle,
				"moveCursorVisible",
				false,
			);
		case "moveCursorOffscreen":
			return await moveBaseCursor(
				context.component,
				context.model,
				context.tui,
				context.term,
				context.settle,
				"moveCursorOffscreen",
				true,
			);
		case "showOverlay":
			return await showOverlay({
				overlays: context.overlays,
				hiddenOverlaySentinels: context.hiddenOverlaySentinels,
				allocOverlayId: context.allocOverlayId,
				streams: context.streams,
				term: context.term,
				tui: context.tui,
				settle: context.settle,
			});
		case "hideOverlay":
			return await hideOverlay({
				overlays: context.overlays,
				hiddenOverlaySentinels: context.hiddenOverlaySentinels,
				allocOverlayId: context.allocOverlayId,
				streams: context.streams,
				term: context.term,
				tui: context.tui,
				settle: context.settle,
			});
		case "toggleOverlayHidden":
			return await toggleOverlayHidden({
				overlays: context.overlays,
				hiddenOverlaySentinels: context.hiddenOverlaySentinels,
				allocOverlayId: context.allocOverlayId,
				streams: context.streams,
				term: context.term,
				tui: context.tui,
				settle: context.settle,
			});
		case "editOverlay":
			return await editOverlay({
				overlays: context.overlays,
				hiddenOverlaySentinels: context.hiddenOverlaySentinels,
				allocOverlayId: context.allocOverlayId,
				streams: context.streams,
				term: context.term,
				tui: context.tui,
				settle: context.settle,
			});
		case "moveOverlayCursor":
			return await moveOverlayCursor({
				overlays: context.overlays,
				hiddenOverlaySentinels: context.hiddenOverlaySentinels,
				allocOverlayId: context.allocOverlayId,
				streams: context.streams,
				term: context.term,
				tui: context.tui,
				settle: context.settle,
			});
		case "rotateUp":
			return await applyContent(context.renderContentFrame, context.settle, kind, context.model.rotateUp(), false);
		case "collapseToFew":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.collapseToFew(),
				false,
			);
		case "swapOffscreenRows":
			return await applyContent(
				context.renderContentFrame,
				context.settle,
				kind,
				context.model.swapOffscreenRows(context.term.rows),
				false,
			);
		case "coalescedBurst":
			return await coalescedBurst({
				model: context.model,
				term: context.term,
				scenario: context.scenario,
				streams: context.streams,
				tui: context.tui,
				renderContentFrame: context.renderContentFrame,
				settle: context.settle,
			});
		case "resizeBoth":
			return await resizeBoth(
				context.scenario,
				context.traits,
				context.term,
				context.tui,
				context.streams,
				context.settle,
			);
		case "resizeNoop":
			return await resizeNoop(context.term, context.settle);
		case "attachChild":
			return await attachChild({
				children: context.children,
				component: context.component,
				tui: context.tui,
				streams: context.streams,
				term: context.term,
				renderContentFrame: context.renderContentFrame,
				settle: context.settle,
			});
		case "detachChild":
			return await detachChild({
				children: context.children,
				component: context.component,
				tui: context.tui,
				streams: context.streams,
				term: context.term,
				renderContentFrame: context.renderContentFrame,
				settle: context.settle,
			});
		case "reorderChildren":
			return await reorderChildren({
				children: context.children,
				component: context.component,
				tui: context.tui,
				streams: context.streams,
				term: context.term,
				renderContentFrame: context.renderContentFrame,
				settle: context.settle,
			});
		case "mutateChild":
			return await mutateChild({
				children: context.children,
				component: context.component,
				tui: context.tui,
				streams: context.streams,
				term: context.term,
				renderContentFrame: context.renderContentFrame,
				settle: context.settle,
			});
		default:
			return assertNever(kind);
	}
}
