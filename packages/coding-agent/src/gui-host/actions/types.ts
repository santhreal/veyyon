import type * as net from "node:net";
import type { AuthStorage } from "@veyyon/ai";
import type { ClientSessionState } from "../turns";
import type { BackendError, HostActionTag, RequestId, SnapshotSection } from "../wire";

export interface ReplyHelper {
	success: () => void;
	failure: (error: Omit<BackendError, "request" | "occurred_at_ms"> & { occurred_at_ms?: number }) => void;
	snapshot: (section: SnapshotSection) => void;
}

export interface ActionContext {
	socket: net.Socket;
	clientState: ClientSessionState;
	cwd: string;
	agentDir: string;
	/** The one credential store this host reads and writes; resolved once per server. */
	authStorage: () => Promise<AuthStorage>;
	requestId: RequestId;
	actionTag: HostActionTag;
	reply: ReplyHelper;
}

export type ActionHandler<T = unknown> = (ctx: ActionContext, payload: T) => Promise<void> | void;

export type ActionHandlersMap = Partial<Record<HostActionTag, ActionHandler<never>>>;
