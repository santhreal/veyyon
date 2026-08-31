/**
 * Terminal drawing for the launch tool. The tool half in `launch.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { DaemonSnapshot, DaemonState } from "../../launch/protocol";
import type { Theme, ThemeColor } from "../../theme/theme";
import { framedBlock, outputBlockContentWidth, renderStatusLine } from "../../tui";
import {
	capPreviewLines,
	createCachedComponent,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	PREVIEW_LIMITS,
	pluralize,
	previewLine,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../core/render-utils";
import { callMeta, type LaunchRenderArgs, type LaunchToolDetails, readyPendingSummary } from "./launch";
import { styleTerminalRow } from "./terminal-output";

function stateColor(state: DaemonState): ThemeColor {
	switch (state) {
		case "running":
		case "ready":
			return "success";
		case "failed":
			return "error";
		case "exited":
			return "muted";
		default:
			return "warning";
	}
}

/** Compact `state · pid · uptime` fragments for the status-line meta slot. */
function daemonMeta(daemon: DaemonSnapshot, theme: Theme): string[] {
	const meta = [theme.fg(stateColor(daemon.state), daemon.state)];
	if (daemon.readyPending?.length) meta.push(theme.fg("warning", `waiting on ${daemon.readyPending.join("+")}`));
	if (daemon.signal) {
		meta.push(theme.fg("error", `signal ${daemon.signal}`));
	} else if (daemon.exitCode !== undefined) {
		meta.push(theme.fg(daemon.exitCode === 0 ? "muted" : "error", `exit ${daemon.exitCode}`));
	} else if (daemon.pid !== undefined) {
		meta.push(`pid ${daemon.pid}`);
	}
	const lifespan = formatDuration((daemon.exitedAt ?? Date.now()) - daemon.startedAt);
	meta.push(daemon.exitedAt === undefined ? `up ${lifespan}` : `ran ${lifespan}`);
	if (daemon.restartCount > 0) meta.push(`restarts ${daemon.restartCount}`);
	// The owning condition that ends this daemon, visible BEFORE it bites:
	// the default dies with the last client, persist dies with the broker,
	// detached survives both.
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("dies with broker");
	else meta.push("dies with last client");
	if (daemon.terminatedBy) meta.push(theme.fg("muted", `by ${daemon.terminatedBy}`));
	return meta;
}

/**
 * The command line a start names, before or after `op` decodes. A streamed call
 * carries `application` several deltas before `op`, so a renderer keyed on
 * `op === "start"` alone shows nothing for that window.
 */
function startCommand(args: LaunchRenderArgs): string | undefined {
	if (!args.application) return undefined;
	if (args.op !== undefined && args.op !== "start") return undefined;
	return [args.application, ...(args.args ?? [])].join(" ");
}

/**
 * Append a result's plain text as body lines. Every op reaches this when the
 * structured detail it renders from is absent: an error the broker answered
 * before it had a snapshot leaves the text as the only thing to show, and a
 * block with a header and no rows reads as a tool that did nothing.
 */
function pushTextLines(body: string[], text: string, theme: Theme): void {
	if (!text.trim()) return;
	for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("toolOutput", line));
}

/** TUI renderer: one status header per op, meta from structured details, capped body lines. */
export const launchToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	animatedPendingPreview: true,
	// Only an op that can sit produces a partial result worth animating. list,
	// describe, stop, restart and send answer in one round trip, and a spinner
	// over those is motion with nothing behind it.
	animatedPartialResult: (args: unknown) => {
		const op = (args as LaunchRenderArgs).op;
		return op === "start" || op === "logs" || op === "wait";
	},

	renderCall(args: LaunchRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const op = args.op;
		const command = startCommand(args);
		// The command line is the description when nothing named the process, and
		// context beside the name when something did. Placing it here rather than
		// filtering it back out of the meta keeps the two from disagreeing once
		// `previewLine` truncates one copy and not the other.
		const target = args.name ?? command;
		const meta = callMeta(args);
		if (args.name && command) meta.unshift(previewLine(replaceTabs(command), TRUNCATE_LENGTHS.SHORT));
		const header = renderStatusLine(
			{
				icon: options.spinnerFrame !== undefined ? "running" : "pending",
				spinnerFrame: options.spinnerFrame,
				title: op ? `Launch ${op}` : "Launch",
				description: target ? previewLine(replaceTabs(target), TRUNCATE_LENGTHS.TITLE) : undefined,
				meta,
			},
			theme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: LaunchToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: LaunchRenderArgs,
	): Component {
		const details = result.details;
		const params = args ?? {};
		const op = details?.op ?? params.op;
		const isError = result.isError === true;
		const daemon = details?.daemon;
		const failed = isError || daemon?.state === "failed";
		const text =
			result.content
				?.filter(item => item.type === "text")
				.map(item => item.text ?? "")
				.join("\n") ?? "";

		const meta: string[] = [];
		const body: string[] = [];
		let description = params.name ?? daemon?.name;

		if (isError) {
			for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("error", line));
		} else {
			switch (op) {
				case "start": {
					meta.push(...callMeta(params));
					if (daemon) meta.push(...daemonMeta(daemon, theme));
					if (daemon?.readyMatch) body.push(theme.fg("dim", `log matched: ${replaceTabs(daemon.readyMatch)}`));
					if (daemon?.state === "failed" && daemon.exitReason)
						body.push(theme.fg("error", replaceTabs(daemon.exitReason)));
					if (details?.timedOut) {
						const pending = daemon ? readyPendingSummary(daemon, params.ready) : [];
						body.push(
							theme.fg(
								"warning",
								pending.length > 0
									? `Not ready — ${pending.join("; ")}. Still running.`
									: "Readiness timed out; the process is still running.",
							),
						);
					}
					if (!daemon) pushTextLines(body, text, theme);
					break;
				}
				case "send":
					meta.push(...callMeta(params));
					if (daemon) meta.push(...daemonMeta(daemon, theme));
					if (!daemon) pushTextLines(body, text, theme);
					break;
				case "stop":
				case "restart":
					if (daemon) meta.push(...daemonMeta(daemon, theme));
					if (!daemon) pushTextLines(body, text, theme);
					break;
				case "wait": {
					meta.push(...callMeta(params));
					if (daemon) meta.push(...daemonMeta(daemon, theme));
					if (details?.matched) body.push(theme.fg("dim", `matched: ${replaceTabs(details.matched)}`));
					if (details?.timedOut) {
						const pending = daemon ? readyPendingSummary(daemon) : [];
						body.push(
							theme.fg(
								"warning",
								pending.length > 0
									? `Wait timed out — still waiting on ${pending.join("; ")}.`
									: "Wait timed out.",
							),
						);
					}
					if (!daemon) pushTextLines(body, text, theme);
					break;
				}
				case "list": {
					const daemons = details?.daemons;
					if (daemons !== undefined) {
						description = `${daemons.length || "no"} ${pluralize("process", daemons.length)}`;
						for (const item of daemons) {
							body.push(
								`${theme.fg("accent", replaceTabs(item.name))} ${theme.fg("dim", daemonMeta(item, theme).join(theme.sep.dot))}`,
							);
						}
					} else if (text.trim()) {
						pushTextLines(body, text, theme);
					} else {
						description = "no processes";
					}
					// `daemons` is absent on the fallback path above, which is the case
					// this branch exists to render: treat it as no live processes so the
					// completion rows below still print.
					const settled = new Set(
						(daemons ?? []).filter(item => item.exitedAt !== undefined).map(item => `${item.id}${item.exitedAt}`),
					);
					for (const record of (details?.completions ?? []).filter(
						item => !settled.has(`${item.id}${item.exitedAt}`),
					)) {
						body.push(
							`${theme.fg("muted", replaceTabs(record.name))} ${theme.fg("dim", `completed${theme.sep.dot}by ${record.terminatedBy}`)}`,
						);
					}
					break;
				}
				case "logs": {
					if (details?.state) meta.push(theme.fg(stateColor(details.state), details.state));
					if (details?.cursor !== undefined) meta.push(`cursor ${details.cursor}`);
					if (details?.timedOut) meta.push(theme.fg("warning", "follow timed out"));
					// Strip the trailing `[name: state; cursor=N]` status suffix `toolContent` appends.
					const logText = text.replace(/\n?\[[^\n]*\]$/, "").trimEnd();
					const terminalRows = details?.terminalRows;
					if (terminalRows) {
						for (const row of terminalRows) body.push(styleTerminalRow(row, theme.getFgAnsi("toolOutput")));
					} else if (logText) {
						for (const line of logText.split("\n")) body.push(theme.fg("toolOutput", replaceTabs(line)));
					}
					break;
				}
				case "describe": {
					if (daemon) meta.push(...daemonMeta(daemon, theme));
					const spec = details?.spec;
					if (spec) {
						body.push(theme.fg("toolOutput", replaceTabs([spec.application, ...spec.args].join(" "))));
						body.push(theme.fg("dim", `cwd ${shortenPath(spec.cwd)}`));
						const flags = [`pty ${spec.pty}`, `restart ${spec.restart}`];
						if (spec.detached) flags.push("detached");
						else if (spec.persist) flags.push("persistent");
						body.push(theme.fg("dim", flags.join(theme.sep.dot)));
					} else {
						pushTextLines(body, text, theme);
					}
					break;
				}
				default:
					pushTextLines(body, text, theme);
			}
		}

		const header = renderStatusLine(
			{
				...(failed
					? { icon: "error" as const }
					: options.isPartial
						? { icon: "pending" as const }
						: { iconOverride: theme.styledSymbol("tool.launch", "accent") }),
				title: `Launch ${op ?? ""}`.trimEnd(),
				description: description ? replaceTabs(description) : undefined,
				meta,
			},
			theme,
		);

		if (op === "logs") {
			return framedBlock(theme, width => {
				const innerWidth = outputBlockContentWidth(width);
				const rows = body.map(line => truncateToWidth(line, innerWidth));
				return {
					header,
					state: options.isPartial ? "pending" : failed ? "error" : "success",
					sections: [
						{
							label: theme.fg("toolTitle", "Output"),
							lines: capPreviewLines(rows.length > 0 ? rows : [theme.fg("dim", "(no output)")], theme, {
								expanded: options.expanded,
								max: DEFAULT_TERMINAL_PREVIEW_LINES,
							}),
						},
					],
					width,
				};
			});
		}

		return createCachedComponent(
			() => options.expanded,
			(width, expanded) => {
				// A failure prints whatever the process said and `list` prints a row per
				// daemon; neither has a ceiling, so both collapse until asked to expand.
				const collapsedLimit = isError
					? PREVIEW_LIMITS.OUTPUT_COLLAPSED
					: op === "list"
						? PREVIEW_LIMITS.COLLAPSED_ITEMS
						: undefined;
				let visible = body;
				if (!expanded && collapsedLimit !== undefined && body.length > collapsedLimit) {
					const remaining = body.length - collapsedLimit;
					visible = [
						...body.slice(0, collapsedLimit),
						theme.fg(
							"dim",
							`${formatMoreItems(remaining, isError ? "line" : "process")} ${formatExpandHint(theme, false, true)}`,
						),
					];
				}
				return [header, ...visible].map(line => truncateToWidth(line, width));
			},
		);
	},
};
