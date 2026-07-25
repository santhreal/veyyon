import type { Page, Target } from "puppeteer-core";
import { ToolError } from "../tool-errors";

/**
 * The CDP target id of a page, which is how a tab is named across the worker boundary.
 *
 * The supervisor hands the worker a target id and the worker matches its own targets against it, so the
 * two sides MUST derive the id the same way: if one read puppeteer's private field and the other asked
 * CDP, a tab could be addressed under two ids and a command would silently land on no tab. They each
 * had a byte-identical private copy of this, which is the arrangement that makes such a drift possible.
 *
 * The private `_targetId` is read first because it costs nothing; the CDP round trip is the fallback for
 * a puppeteer version that does not carry it. Both answer the same id, and a target that yields neither
 * is an error rather than a guess: a wrong id is worse than a failed call, because it acts on a tab the
 * caller did not name.
 */
export async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		// The session is a debugging channel this function opened; failing to close it leaks a CDP
		// session but must not fail the call that already has its answer.
		await session.detach().catch(() => undefined);
	}
}

/** The CDP target id of the page's own target. See {@link targetIdForTarget}. */
export async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}
