import type { InteractiveModeContext } from "../modes/types";
import type { SessionEntry } from "../session/session-entries";
import type { AgentSnapshot, CollabFrame } from "./protocol";

export const COLLAB_GUEST_ALLOWED_COMMANDS: Record<string, true> = {
	dump: true,
	export: true,
	copy: true,
	welcome: true, // `/help` is an alias of `/welcome`; the gate keys on the canonical name
	hotkeys: true,
	settings: true,
	leave: true,
	collab: true,
	exit: true,
	quit: true,
};

export type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
export type SnapshotChunkFrame = Extract<CollabFrame, { t: "snapshot-chunk" }>;

export interface PendingSnapshot {
	header: WelcomeFrame["header"];
	state: WelcomeFrame["state"];
	agents: AgentSnapshot[];
	readOnly: boolean;
	entryCount: number;
	entries: SessionEntry[];
	isResync: boolean;
}

export interface GuestIdleReconcilerCtx {
	statusLine: { markActivityEnd: () => void };
	clearWorkingLoader: () => void;
}

export function reconcileGuestIdleHostState(ctx: GuestIdleReconcilerCtx, isStreaming: boolean): void {
	if (isStreaming) return;
	ctx.statusLine.markActivityEnd();
	ctx.clearWorkingLoader();
}

export interface GuestSnapshotActivityReconcilerCtx extends GuestIdleReconcilerCtx {
	statusLine: GuestIdleReconcilerCtx["statusLine"] & { markActivityStart: () => void };
}

export function reconcileGuestSnapshotHostState(ctx: GuestSnapshotActivityReconcilerCtx, isStreaming: boolean): void {
	if (isStreaming) {
		ctx.statusLine.markActivityStart();
		return;
	}
	reconcileGuestIdleHostState(ctx, false);
}

export type CollabGuestContext = Pick<
	InteractiveModeContext,
	| "chatContainer"
	| "clearWorkingLoader"
	| "collabGuest"
	| "compactionQueuedMessages"
	| "eventBus"
	| "eventController"
	| "handleResumeSession"
	| "pendingMessagesContainer"
	| "pendingTools"
	| "reloadTodos"
	| "renderInitialMessages"
	| "resetObserverRegistry"
	| "session"
	| "sessionManager"
	| "settings"
	| "showError"
	| "showHookEditor"
	| "showHookSelector"
	| "showStatus"
	| "statusContainer"
	| "statusLine"
	| "streamingComponent"
	| "streamingMessage"
	| "syncRunningSubagentBadge"
	| "ui"
	| "updateEditorBorderColor"
>;
