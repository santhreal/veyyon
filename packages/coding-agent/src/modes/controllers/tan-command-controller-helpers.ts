import * as fs from "node:fs/promises";
import type { InteractiveModeContext } from "../types";

export type TanCommandControllerContext = Pick<
	InteractiveModeContext,
	"mcpManager" | "rebuildChatFromMessages" | "session" | "sessionManager" | "settings" | "showError" | "showStatus"
>;

export const TAN_LABEL_PREVIEW_LENGTH = 80;

export async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}
