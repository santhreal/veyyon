import { collapseWhitespace, truncate } from "@veyyon/utils";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSession } from "../../session/agent-session";
import { commandConsumed } from "../helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, TuiSlashCommandRuntime } from "../types";

export function refreshStatusLine(ctx: Pick<InteractiveModeContext, "statusLine" | "ui">): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

export function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

export function formatYoloStatus(session: AgentSession): string {
	return session.isApprovalBypassed() ? "on" : "off";
}

export const AUTOCOMPLETE_DETAIL_LIMIT = 48;

export function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	return truncate(collapseWhitespace(value), limit);
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const shutdownHandlerTui = (
	_command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): SlashCommandResult => {
	runtime.ctx.editor.setText("");
	void runtime.ctx.shutdown();
	return commandConsumed();
};
