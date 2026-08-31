/**
 * Differential oracle: set_cwd tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f, where the renderer was declared in-place at
 * the foot of `src/tools/set-cwd.ts`. Only the members this suite compares are carried over:
 * `renderArguments` returns a string and `renderPending` was never reachable for a converted tool.
 * Frozen: never edited to make a test pass.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@veyyon/coding-agent/tools/core/render-utils";
import type { SetCwdToolDetails, SetCwdToolInput } from "@veyyon/coding-agent/tools/fs/set-cwd";
import { framedBlock, renderStatusLine } from "@veyyon/coding-agent/tui";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";

export function renderCall(args: unknown, _options: RenderResultOptions, theme: Theme): Component {
	const pathArg = (args as Partial<SetCwdToolInput>)?.path;
	const label = typeof pathArg === "string" ? truncateToWidth(shortenPath(pathArg), TRUNCATE_LENGTHS.TITLE) : "…";
	return new Text(theme.fg("toolTitle", `set_cwd ${label}`));
}

export function renderResult(
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
}
