import { actingSettings } from "../acting-settings";
import { attachCollabBridge, shareSection } from "../collab-bridge";
import { attachCollabGuestBridge, joinRefusal, leaveShareOnWindow } from "../collab-guest-bridge";
import { getOrCreateAgentSession } from "../turns";
import { activateSession, replyError } from "./active-session";
import type { ActionHandler, ActionHandlersMap } from "./types";

interface StartSharePayload {
	read_only?: boolean;
}

const handleStartShare: ActionHandler<StartSharePayload | undefined> = async (ctx, payload) => {
	try {
		const guest = ctx.clientState.collabGuestBridge;
		if (guest && guest.phase !== "off") {
			ctx.reply.failure({
				scope: "Session",
				code: "ALREADY_A_GUEST",
				message: "This window is in someone else's share. Leave it before hosting one.",
				retryable: false,
			});
			return;
		}
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		const relayUrl = session.settings.get("collab.relayUrl")?.trim();
		if (!relayUrl) {
			ctx.reply.failure({
				scope: "Session",
				code: "RELAY_NOT_CONFIGURED",
				message: "No relay configured. Set collab.relayUrl in settings.",
				retryable: false,
			});
			return;
		}

		const bridge = attachCollabBridge(session, ctx.clientState, ctx.socket);
		await bridge.start(Boolean(payload?.read_only));
		ctx.reply.snapshot(bridge.currentSection());
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "START_SHARE_FAILED", error);
	}
};

const handleStopShare: ActionHandler<void> = async ctx => {
	try {
		await ctx.clientState.collabBridge?.stop();
		ctx.reply.snapshot(shareSection(ctx.clientState, await actingSettings(ctx)));
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "STOP_SHARE_FAILED", error);
	}
};

const handleRefreshShare: ActionHandler<void> = async ctx => {
	try {
		ctx.reply.snapshot(shareSection(ctx.clientState, await actingSettings(ctx)));
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "REFRESH_SHARE_FAILED", error);
	}
};

interface JoinSharePayload {
	session?: string;
	link?: string;
}

/**
 * Join the share a link names, on the window that asked.
 *
 * The join replaces what the window was on with a replica of the host's
 * session, so it runs on the same session the rest of the window's actions
 * run on: the session the payload names is activated first, and the one it
 * was on is what a later leave returns to.
 */
const handleJoinShare: ActionHandler<JoinSharePayload | undefined> = async (ctx, payload) => {
	const link = payload?.link?.trim();
	if (!link) {
		ctx.reply.failure({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			message: "JoinShare needs the collab link to join",
			retryable: false,
		});
		return;
	}
	try {
		const refusal = joinRefusal(ctx.clientState);
		if (refusal) {
			ctx.reply.failure({
				scope: "Session",
				code: "ALREADY_HOSTING",
				message: refusal,
				retryable: false,
			});
			return;
		}
		if (payload?.session && !(await activateSession(ctx, payload.session))) return;
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		const bridge = attachCollabGuestBridge(session, ctx.clientState, ctx.socket);
		await bridge.join(link);
		ctx.reply.snapshot(bridge.currentSection());
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "JOIN_SHARE_FAILED", error);
	}
};

/**
 * Leave the share this window is in, on whichever side it is on.
 *
 * The window is what joined, so the action names no session: the replica a
 * join put the window on is a file outside the sessions directory, and
 * naming it would make leaving depend on a lookup that cannot resolve it.
 */
const handleLeaveShare: ActionHandler<void> = async ctx => {
	try {
		await leaveShareOnWindow(ctx.clientState);
		ctx.reply.snapshot(shareSection(ctx.clientState, await actingSettings(ctx)));
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "LEAVE_SHARE_FAILED", error);
	}
};

export const shareActionHandlers: ActionHandlersMap = {
	StartShare: handleStartShare as ActionHandler,
	StopShare: handleStopShare as ActionHandler,
	RefreshShare: handleRefreshShare as ActionHandler,
	JoinShare: handleJoinShare as ActionHandler,
	LeaveShare: handleLeaveShare as ActionHandler,
};
