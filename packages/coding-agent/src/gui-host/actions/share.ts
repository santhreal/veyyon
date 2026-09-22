import { actingSettings } from "../acting-settings";
import { attachCollabBridge, shareSection } from "../collab-bridge";
import { getOrCreateAgentSession } from "../turns";
import { replyError } from "./active-session";
import type { ActionHandler, ActionHandlersMap } from "./types";

interface StartSharePayload {
	read_only?: boolean;
}

const handleStartShare: ActionHandler<StartSharePayload | undefined> = async (ctx, payload) => {
	try {
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
		const bridge = ctx.clientState.collabBridge;
		if (bridge) {
			await bridge.stop();
		}
		ctx.reply.snapshot(shareSection(bridge, await actingSettings(ctx)));
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "STOP_SHARE_FAILED", error);
	}
};

const handleRefreshShare: ActionHandler<void> = async ctx => {
	try {
		const bridge = ctx.clientState.collabBridge;
		ctx.reply.snapshot(shareSection(bridge, await actingSettings(ctx)));
		ctx.reply.success();
	} catch (error) {
		replyError(ctx, "REFRESH_SHARE_FAILED", error);
	}
};

export const shareActionHandlers: ActionHandlersMap = {
	StartShare: handleStartShare as ActionHandler,
	StopShare: handleStopShare as ActionHandler,
	RefreshShare: handleRefreshShare as ActionHandler,
};
