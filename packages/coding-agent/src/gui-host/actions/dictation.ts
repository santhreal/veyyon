import { actingSettings } from "../acting-settings";
import { dictationForClient } from "../dictation-bridge";
import { replyError } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/**
 * Whether this host may open a microphone at all.
 *
 * Recognising speech provisions a recorder and downloads a speech model on
 * first use, so a host whose `stt.enabled` is off refuses before any of that
 * runs rather than acquiring both and then declining to listen. The capability
 * snapshot carries the same gate, so the window draws the control greyed with
 * this reason on it.
 */
async function dictationRefusal(ctx: ActionContext): Promise<string | null> {
	const settings = await actingSettings(ctx);
	return settings.get("stt.enabled") ? null : "Speech to text is off. Turn on stt.enabled in settings to dictate.";
}

/**
 * Open the microphone, or close it and hand back what was said.
 *
 * The action names no session: the microphone and the draft it fills belong to
 * the window, so a second window dictating records its own audio into its own
 * composer while this one is open.
 */
const handleToggleDictation: ActionHandler<void> = async ctx => {
	const refusal = await dictationRefusal(ctx);
	if (refusal) {
		ctx.reply.failure({
			scope: "Session",
			code: "DICTATION_DISABLED",
			message: refusal,
			retryable: false,
		});
		return;
	}
	const dictation = dictationForClient(ctx.clientState, ctx.socket);
	try {
		await dictation.toggle();
		ctx.reply.snapshot({ Dictation: dictation.view() });
		ctx.reply.success();
	} catch (error) {
		ctx.reply.snapshot({ Dictation: dictation.view() });
		replyError(ctx, "DICTATION_FAILED", error);
	}
};

/**
 * Close the microphone and discard what it heard.
 *
 * Discarding never checks the setting: a dictation opened before the setting
 * was turned off still holds a microphone, and refusing to close it would
 * leave it open.
 */
const handleCancelDictation: ActionHandler<void> = ctx => {
	const dictation = dictationForClient(ctx.clientState, ctx.socket);
	dictation.cancel();
	ctx.reply.snapshot({ Dictation: dictation.view() });
	ctx.reply.success();
};

export const dictationActionHandlers: ActionHandlersMap = {
	ToggleDictation: handleToggleDictation as ActionHandler,
	CancelDictation: handleCancelDictation as ActionHandler,
};
