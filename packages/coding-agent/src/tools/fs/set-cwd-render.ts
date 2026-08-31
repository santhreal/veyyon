/**
 * Terminal drawing for the set_cwd tool. The tool half in `set-cwd.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../theme/theme";
import { framedBlock, renderStatusLine } from "../../tui";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../core/render-utils";
import { SET_CWD_TOOL_NAME } from "./reroot-hint";
import type { SetCwdToolDetails, SetCwdToolInput } from "./set-cwd";

export const setCwdToolRenderer = {
	name: SET_CWD_TOOL_NAME,
	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		const label = typeof pathArg === "string" ? truncateToWidth(shortenPath(pathArg), TRUNCATE_LENGTHS.TITLE) : "…";
		return new Text(theme.fg("toolTitle", `set_cwd ${label}`));
	},
	renderArguments(args: unknown): string {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		return typeof pathArg === "string" ? pathArg : "";
	},
	renderResult(
		result: AgentToolResult<SetCwdToolDetails>,
		_options: RenderResultOptions,
		theme: Theme,
	): Component | undefined {
		const details = result.details;
		// A no-op used to render exactly like a real move: the same green frame
		// naming the same directory. Reading back a run of retries, there was no
		// way to tell a change from a repeat of the same no-op.
		const line = !details
			? "cwd"
			: details.previous !== details.cwd
				? `${details.previous} → ${details.cwd}`
				: `${details.cwd} (already here)`;
		// The rule delta is the part of a re-root that changes how the agent behaves,
		// so it belongs on the status line rather than only in the model's copy of the
		// result. A move that silently swapped the governing AGENTS.md looked
		// identical to one that changed nothing.
		const applied = details?.rulesApplied?.length ?? 0;
		const dropped = details?.rulesDropped?.length ?? 0;
		const meta = [line];
		if (applied > 0 || dropped > 0) {
			const counts = [applied > 0 ? `+${applied}` : "", dropped > 0 ? `-${dropped}` : ""].filter(Boolean).join(" ");
			meta.push(`${counts} ${applied + dropped === 1 ? "rule file" : "rule files"}`);
		}
		return framedBlock(theme, width => ({
			header: renderStatusLine({ icon: "success", title: "cwd", meta }, theme),
			width,
		}));
	},
	renderPending(args: unknown, theme: Theme): Component {
		const pathArg = (args as Partial<SetCwdToolInput>)?.path;
		const label = typeof pathArg === "string" ? pathArg : "…";
		return new Text(theme.fg("toolTitle", `set_cwd ${label}`));
	},
};
