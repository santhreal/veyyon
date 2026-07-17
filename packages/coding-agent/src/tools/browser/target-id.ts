import type { Page, Target } from "puppeteer-core";
import { ToolError } from "../tool-errors";

/** CDP target id for a puppeteer target, via the private field when present. */
export async function targetIdForTarget(target: Target): Promise<string> {
	const raw = target as unknown as { _targetId?: unknown };
	if (typeof raw._targetId === "string") return raw._targetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

export async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}
