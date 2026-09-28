/**
 * What the composer sends on behalf of a session's extensions: the draft it
 * holds, so `getEditorText` reads it, and the completions it asks for, which
 * the extension completion sources answer.
 *
 * Both name the session the composer belongs to. The session's extensions
 * are loaded only while this window holds it, so a draft reported for another
 * session has nothing to read it and is taken without effect, and a
 * completion asked for another session is answered with none: no source for
 * it is loaded here. Neither is a refusal, since both happen in the moment a
 * window switches sessions and the composer's next request is for the new one.
 */
import type { ComposerRefusal, ExtensionChrome } from "../extension-chrome";
import { activeManager } from "./active-session";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

interface ReportComposerDraftPayload {
	session?: unknown;
	text?: unknown;
	cursor?: unknown;
	applied_edit?: unknown;
}

interface CompleteComposerPayload {
	session?: unknown;
	query?: unknown;
	text?: unknown;
	cursor?: unknown;
}

function isOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function refuse(ctx: ActionContext, refusal: ComposerRefusal): void {
	ctx.reply.failure({ scope: "Extension", code: refusal.code, message: refusal.message, retryable: false });
}

/** The chrome of `session` when this window holds it with its extensions loaded. */
function chromeOf(ctx: ActionContext, session: string): ExtensionChrome | undefined {
	const chrome = ctx.clientState.extensionChrome;
	return chrome && activeManager(ctx)?.getSessionId() === session ? chrome : undefined;
}

const handleReportComposerDraft: ActionHandler<ReportComposerDraftPayload | undefined> = (ctx, payload) => {
	const { session, text, cursor, applied_edit: appliedEdit } = payload ?? {};
	if (typeof session !== "string" || typeof text !== "string" || !isOffset(cursor) || !isOffset(appliedEdit)) {
		return refuse(ctx, {
			code: "INVALID_ARGUMENTS",
			message: "ReportComposerDraft needs session, text, a byte cursor and the applied_edit sequence number",
		});
	}
	const refusal = chromeOf(ctx, session)?.reportDraft(text, cursor, appliedEdit);
	if (refusal) return refuse(ctx, refusal);
	ctx.reply.success();
};

const handleCompleteComposer: ActionHandler<CompleteComposerPayload | undefined> = async (ctx, payload) => {
	const { session, query, text, cursor } = payload ?? {};
	if (typeof session !== "string" || !isOffset(query) || typeof text !== "string" || !isOffset(cursor)) {
		return refuse(ctx, {
			code: "INVALID_ARGUMENTS",
			message: "CompleteComposer needs session, the query sequence number, text and a byte cursor",
		});
	}
	const chrome = chromeOf(ctx, session);
	if (!chrome) {
		ctx.reply.snapshot({ ComposerCompletions: { session, completions: { query, items: [] } } });
		ctx.reply.success();
		return;
	}
	const refusal = await chrome.complete(query, text, cursor);
	if (refusal) return refuse(ctx, refusal);
	ctx.reply.success();
};

export const composerActionHandlers: ActionHandlersMap = {
	ReportComposerDraft: handleReportComposerDraft as ActionHandler<never>,
	CompleteComposer: handleCompleteComposer as ActionHandler<never>,
};
