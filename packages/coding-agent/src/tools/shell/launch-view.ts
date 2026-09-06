/**
 * What the launch card shows, for any host.
 *
 * The tool half in `launch.ts` decides what happened; this half decides what a reader is told, and
 * names no colour, glyph or component. A terminal draws it through `src/modes/terminal/draw/draw-tool-view.ts` and a
 * second host writes its own mapping from the same value.
 *
 * The card is one row per operation: a head row stating the op, the process it names and the facts
 * about that process, with the body carrying whatever the op produced. `logs` is the one op whose
 * body is the process's own output rather than the tool's words, so it is the one that frames.
 */

import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewTone,
} from "@veyyon/view";
import type { DaemonSnapshot, DaemonState } from "../../launch/protocol";
import {
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatDuration,
	LINE_NOUN,
	PREVIEW_LIMITS,
	pluralize,
	previewLine,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
} from "../core/render-utils";
import { callMeta, type LaunchRenderArgs, type LaunchToolDetails, readyPendingSummary } from "./launch";

/** What every card of this tool is titled, with the operation set after it. */
const LAUNCH_TITLE = "Launch";

/** The tool's own mark, which a settled card is titled by instead of an outcome icon. */
const LAUNCH_EMBLEM = "tool.launch";

/** The unit a held-back `list` count is in: the rows of that card are processes, not lines. */
const PROCESS_NOUN = { one: "process", many: "processes" } as const;

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface LaunchViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: LaunchToolDetails;
	isError?: boolean;
}

/** The role a daemon's state plays, which a host maps to its own appearance. */
function stateTone(state: DaemonState): ViewTone {
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

/**
 * The facts about one process: what it is doing, what it is, how long it has run, and what ends it.
 *
 * One entry per fact rather than a joined string, so the host puts its own separator between them.
 * The lifetime entry is here rather than on a row of its own because it is visible BEFORE it bites:
 * the default dies with the last client, persist dies with the broker, detached survives both.
 */
function daemonMeta(daemon: DaemonSnapshot): ViewLine[] {
	const meta: ViewLine[] = [[{ text: daemon.state, tone: stateTone(daemon.state) }]];
	if (daemon.readyPending?.length) {
		meta.push([{ text: `waiting on ${daemon.readyPending.join("+")}`, tone: "warning" }]);
	}
	if (daemon.signal) {
		meta.push([{ text: `signal ${daemon.signal}`, tone: "error" }]);
	} else if (daemon.exitCode !== undefined) {
		meta.push([{ text: `exit ${daemon.exitCode}`, tone: daemon.exitCode === 0 ? "muted" : "error" }]);
	} else if (daemon.pid !== undefined) {
		meta.push([{ text: `pid ${daemon.pid}` }]);
	}
	const lifespan = formatDuration((daemon.exitedAt ?? Date.now()) - daemon.startedAt);
	meta.push([{ text: daemon.exitedAt === undefined ? `up ${lifespan}` : `ran ${lifespan}` }]);
	if (daemon.restartCount > 0) meta.push([{ text: `restarts ${daemon.restartCount}` }]);
	if (daemon.detached) meta.push([{ text: "detached" }]);
	else if (daemon.persist) meta.push([{ text: "dies with broker" }]);
	else meta.push([{ text: "dies with last client" }]);
	if (daemon.terminatedBy) meta.push([{ text: `by ${daemon.terminatedBy}`, tone: "muted" }]);
	return meta;
}

/**
 * The same facts as the spans of one line, for a `list` row that states a whole process per line.
 *
 * A row of the listing is one line, so the facts cannot be entries the host separates: the row states
 * them itself, joined by a middle dot, and each keeps the tone it carries in a header's metadata. A
 * fact with no tone of its own is secondary detail, so it takes `dim` here rather than the row's
 * ground: on a header the whole metadata run is already quiet, and a body row has no such run.
 */
function daemonFacts(daemon: DaemonSnapshot): ViewLine {
	const spans: ViewSpan[] = [];
	for (const entry of daemonMeta(daemon)) {
		if (spans.length > 0) spans.push({ text: " · ", tone: "dim" });
		for (const span of entry) spans.push(span.tone === undefined ? { ...span, tone: "dim" } : span);
	}
	return spans;
}

/** The call's own context: the log filters, the wait condition or the payload a send carries. */
function callEntries(args: LaunchRenderArgs): ViewLine[] {
	return callMeta(args).map(entry => [{ text: entry }] as ViewLine);
}

/**
 * The command line a start names, before or after `op` decodes.
 *
 * A streamed call carries `application` several deltas before `op`, so a card keyed on
 * `op === "start"` alone shows nothing for that window.
 */
function startCommand(args: LaunchRenderArgs): string | undefined {
	if (!args.application) return undefined;
	if (args.op !== undefined && args.op !== "start") return undefined;
	return [args.application, ...(args.args ?? [])].join(" ");
}

/** The head row of every launch card: the op is the title and the process it names is the subject. */
function header(
	op: string | undefined,
	description: string | undefined,
	options: { status?: StatusRowView["status"]; emblem?: string; meta: readonly ViewLine[] },
): StatusRowView {
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.emblem === undefined ? {} : { emblem: options.emblem, emblemTone: "accent" as const }),
		title: `${LAUNCH_TITLE} ${op ?? ""}`.trimEnd(),
		...(description === undefined ? {} : { description }),
		meta: options.meta,
	};
}

/** The result's plain text as body lines, for an op whose structured detail did not arrive. */
function textLines(text: string): ViewLine[] {
	if (!text.trim()) return [];
	return replaceTabs(text.trimEnd())
		.split("\n")
		.map(line => [{ text: line, tone: "output" as const }] as ViewLine);
}

/** The text every op falls back to: the parts of the result the model was sent. */
function resultText(result: LaunchViewResult): string {
	return (
		result.content
			?.filter(item => item.type === "text")
			.map(item => item.text ?? "")
			.join("\n") ?? ""
	);
}

/** The rows a card shows and the count it kept back, for a body the tool caps itself. */
function capped(lines: readonly ViewLine[], limit: number | undefined, noun: ViewHiddenCount["noun"]): ViewSection {
	if (limit === undefined || lines.length <= limit) return { lines, clip: true };
	return {
		lines: lines.slice(0, limit),
		hidden: { count: lines.length - limit, noun, revealable: true },
		clip: true,
	};
}

/** What the `start` op reports beyond the process's own facts: what matched, and what did not. */
function startBody(details: LaunchToolDetails | undefined, args: LaunchRenderArgs): ViewLine[] {
	const daemon = details?.daemon;
	const body: ViewLine[] = [];
	if (daemon?.readyMatch) body.push([{ text: `log matched: ${replaceTabs(daemon.readyMatch)}`, tone: "dim" }]);
	if (daemon?.state === "failed" && daemon.exitReason) {
		body.push([{ text: replaceTabs(daemon.exitReason), tone: "error" }]);
	}
	if (details?.timedOut) {
		const pending = daemon ? readyPendingSummary(daemon, args.ready) : [];
		body.push([
			{
				text:
					pending.length > 0
						? `Not ready — ${pending.join("; ")}. Still running.`
						: "Readiness timed out; the process is still running.",
				tone: "warning",
			},
		]);
	}
	return body;
}

/** What the `wait` op reports: the pattern that matched, or the conditions that never did. */
function waitBody(details: LaunchToolDetails | undefined): ViewLine[] {
	const body: ViewLine[] = [];
	if (details?.matched) body.push([{ text: `matched: ${replaceTabs(details.matched)}`, tone: "dim" }]);
	if (details?.timedOut) {
		const pending = details.daemon ? readyPendingSummary(details.daemon) : [];
		body.push([
			{
				text: pending.length > 0 ? `Wait timed out — still waiting on ${pending.join("; ")}.` : "Wait timed out.",
				tone: "warning",
			},
		]);
	}
	return body;
}

/** One row per live process, then one per process that ended since the last listing. */
function listBody(details: LaunchToolDetails | undefined): ViewLine[] {
	const body: ViewLine[] = [];
	for (const item of details?.daemons ?? []) {
		body.push([{ text: replaceTabs(item.name), tone: "accent" }, { text: " " }, ...daemonFacts(item)]);
	}
	// `daemons` is absent on the text fallback, which is the case this reads as no live processes so
	// the completion rows still print.
	const settled = new Set(
		(details?.daemons ?? []).filter(item => item.exitedAt !== undefined).map(item => `${item.id}${item.exitedAt}`),
	);
	for (const record of (details?.completions ?? []).filter(item => !settled.has(`${item.id}${item.exitedAt}`))) {
		body.push([
			{ text: replaceTabs(record.name), tone: "muted" },
			{ text: " " },
			{ text: `completed · by ${record.terminatedBy}`, tone: "dim" },
		]);
	}
	return body;
}

/** What `describe` reports: the spec the process was started from. */
function describeBody(details: LaunchToolDetails | undefined): ViewLine[] {
	const spec = details?.spec;
	if (!spec) return [];
	const flags = [`pty ${spec.pty}`, `restart ${spec.restart}`];
	if (spec.detached) flags.push("detached");
	else if (spec.persist) flags.push("persistent");
	return [
		[{ text: replaceTabs([spec.application, ...spec.args].join(" ")), tone: "output" }],
		[{ text: `cwd ${shortenPath(spec.cwd)}`, tone: "dim" }],
		[{ text: flags.join(" · "), tone: "dim" }],
	];
}

/**
 * The process's own output, as the rows it wrote.
 *
 * A pty-backed process reports the screen it drew, which the card states verbatim as a captured run:
 * the styles in those rows are the program's, and a tool that decoded them into its own tones would
 * be picking colours for output it only watched. A pipe-backed process reports lines of text, which
 * carry no styling of their own and are the tool's `output` tone.
 */
function logsBody(details: LaunchToolDetails | undefined, text: string): ViewLine[] {
	// The trailing `[name: state; cursor=N]` suffix is what the model is told, not what a reader is.
	const logText = text.replace(/\n?\[[^\n]*\]$/, "").trimEnd();
	const terminalRows = details?.terminalRows;
	if (terminalRows) return terminalRows.map((row): ViewLine => [{ text: row, captured: true }]);
	if (!logText) return [];
	return logText.split("\n").map(line => [{ text: replaceTabs(line), tone: "output" as const }] as ViewLine);
}

export const launchToolView: Required<ToolViewRenderer<LaunchRenderArgs, LaunchViewResult>> = {
	/**
	 * The card while the operation is running: the op, the process it names, and how it was called.
	 *
	 * The command line is the description when nothing named the process, and context beside the name
	 * when something did. Stating it here rather than filtering it back out of the metadata keeps the
	 * two from disagreeing once one copy is shortened and the other is not.
	 */
	renderCall(args, context: ToolViewContext): ToolView {
		const command = startCommand(args);
		const target = args.name ?? command;
		const meta = callEntries(args);
		if (args.name && command) {
			meta.unshift([{ text: previewLine(replaceTabs(command), TRUNCATE_LENGTHS.SHORT) }]);
		}
		return header(args.op, target ? previewLine(replaceTabs(target), TRUNCATE_LENGTHS.TITLE) : undefined, {
			// A surface that animates says the operation is running; one that does not says it is
			// pending, which is the same distinction the row drew from whether it had a frame.
			status: context.frame === undefined ? "pending" : "running",
			meta,
		});
	},

	renderResult(result, context: ToolViewContext, args): ToolView {
		const details = result.details;
		const params = args ?? {};
		const op = details?.op ?? params.op;
		const isError = result.isError === true;
		const daemon = details?.daemon;
		const failed = isError || daemon?.state === "failed";
		const partial = context.partial === true;
		const text = resultText(result);

		const meta: ViewLine[] = [];
		let body: ViewLine[] = [];
		let description = params.name ?? daemon?.name;

		if (isError) {
			body = replaceTabs(text.trimEnd())
				.split("\n")
				.map(line => [{ text: line, tone: "error" as const }] as ViewLine);
		} else {
			switch (op) {
				case "start":
					meta.push(...callEntries(params));
					if (daemon) meta.push(...daemonMeta(daemon));
					body = startBody(details, params);
					if (!daemon) body.push(...textLines(text));
					break;
				case "send":
					meta.push(...callEntries(params));
					if (daemon) meta.push(...daemonMeta(daemon));
					if (!daemon) body = textLines(text);
					break;
				case "stop":
				case "restart":
					if (daemon) meta.push(...daemonMeta(daemon));
					if (!daemon) body = textLines(text);
					break;
				case "wait":
					meta.push(...callEntries(params));
					if (daemon) meta.push(...daemonMeta(daemon));
					body = waitBody(details);
					if (!daemon) body.push(...textLines(text));
					break;
				case "list": {
					const daemons = details?.daemons;
					if (daemons !== undefined) {
						description = `${daemons.length || "no"} ${pluralize("process", daemons.length)}`;
					} else if (!text.trim()) {
						description = "no processes";
					}
					body = daemons === undefined && text.trim() ? textLines(text) : [];
					body.push(...listBody(details));
					break;
				}
				case "logs":
					if (details?.state) meta.push([{ text: details.state, tone: stateTone(details.state) }]);
					if (details?.cursor !== undefined) meta.push([{ text: `cursor ${details.cursor}` }]);
					if (details?.timedOut) meta.push([{ text: "follow timed out", tone: "warning" }]);
					body = logsBody(details, text);
					break;
				case "describe":
					if (daemon) meta.push(...daemonMeta(daemon));
					body = describeBody(details);
					if (body.length === 0) body = textLines(text);
					break;
				default:
					body = textLines(text);
			}
		}

		const head = header(op, description ? replaceTabs(description) : undefined, {
			...(failed
				? { status: "error" as const }
				: partial
					? { status: "pending" as const }
					: { emblem: LAUNCH_EMBLEM }),
			meta,
		});

		if (op === "logs") {
			// The one op whose body is the process's own output: it frames, and the state goes on the
			// card's edge rather than across output nobody highlighted.
			const rows = body.length > 0 ? body : [[{ text: "(no output)", tone: "dim" as const }] as ViewLine];
			const card: FramedBlockView = {
				kind: "framedBlock",
				header: head,
				state: partial ? "pending" : failed ? "error" : "success",
				contents: "data",
				sections: [
					{
						label: "Output",
						lines: rows,
						clip: true,
						...(context.expanded ? {} : { tail: { max: DEFAULT_TERMINAL_PREVIEW_LINES } }),
					},
				],
			};
			return card;
		}

		// A failure prints whatever the process said and `list` prints a row per process; neither has a
		// ceiling of its own, so both are capped until the reader asks for the rest.
		const limit = context.expanded
			? undefined
			: isError
				? PREVIEW_LIMITS.OUTPUT_COLLAPSED
				: op === "list"
					? PREVIEW_LIMITS.COLLAPSED_ITEMS
					: undefined;
		const section = capped(body, limit, isError ? LINE_NOUN : PROCESS_NOUN);
		return {
			kind: "headedBlock",
			header: head,
			lines: section.lines,
			...(section.hidden === undefined ? {} : { hidden: section.hidden }),
		};
	},
};
