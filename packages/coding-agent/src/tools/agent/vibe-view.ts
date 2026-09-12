/**
 * What a vibe card shows, for any host.
 *
 * The tool half in `vibe.ts` starts, steers, watches and kills worker sessions; this half states what
 * a card says about them and names no colour, no glyph and no width. Two shapes carry all five tools:
 * the mini composer, which is the message a director typed into a worker's own CLI, and the wall,
 * which is one row per worker with the tool it is part way through under it.
 *
 * The wall is why a row states its own state and its own flavour: the workers on it succeeded, are
 * still going and died, side by side, so each row carries the mark and the badge the host draws, and
 * the runs that are still arriving say so and let the host animate them. Nothing here reads a clock
 * except the elapsed turn duration the tool measured, and nothing here decides what motion looks like.
 */

import { formatDuration } from "@veyyon/utils/format";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { finiteNumber, isRecord } from "@veyyon/utils/type-guards";
import type {
	HeadedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSpan,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
import type { VibeCli, VibeScreenSnapshot, VibeSessionState } from "../../session/vibe-runtime";
import { oneLineLabel } from "../../task/types";
import { extractResultText, shortenEmbeddedPaths, type ToolViewResult } from "../core/render-utils";
import type { VibeOp, VibeToolDetails } from "./vibe";

const COMPOSER_LINE_MAX = 96;
const TV_LINE_MAX = 110;
const TV_TRACE_COLLAPSED = 2;
const TV_TRACE_EXPANDED = 6;
const TV_OUTPUT_COLLAPSED = 1;
const TV_OUTPUT_EXPANDED = 3;
const COMPOSER_ROWS_COLLAPSED = 2;
const COMPOSER_ROWS_EXPANDED = 6;
const NAME_MAX = 40;
const MODEL_MAX = 40;
const SESSION_LIST_MAX = 60;

/** The two columns a worker's own rows sit in, under the row that names it. */
const SCREEN_BODY_INDENT = "  ";

/** The arguments a vibe card reads, which are the five schemas' fields as one shape. */
export interface VibeRenderArgs {
	cli?: VibeCli;
	prompt?: string;
	name?: string;
	session?: string;
	message?: string;
	sessions?: string[];
}

/** The result a vibe card reads: the text every tool returns, and the shared details payload. */
export interface VibeToolResult extends ToolViewResult<VibeToolDetails> {}

/** The state a worker reports, as the mark a host draws for it. */
function stateStatus(state: VibeSessionState): ViewStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
		case "dead":
			return "aborted";
	}
}

/** The tone a worker's flavour badge carries, which is what its state means. */
function stateTone(state: VibeSessionState): ViewTone {
	switch (state) {
		case "running":
		case "starting":
			return "accent";
		case "idle":
			return "success";
		case "dead":
			return "muted";
	}
}

/** One-line, tab-free fragment for a row inside a card. */
function rowText(text: string, max: number): string {
	return oneLineLabel(replaceTabs(shortenEmbeddedPaths(text)), max);
}

/** The literal separator between two runs of a row, which the tool states and the host never adds. */
const GAP: ViewSpan = { text: " " };

/** The mark every row of a worker's body opens with. */
function hook(tone: ViewTone): ViewSpan {
	return { text: "-", symbol: "format.bullet", tone };
}

/** What the call asked for, in the words the row is titled with. */
function describeCall(op: VibeOp, args: VibeRenderArgs | undefined): string {
	switch (op) {
		case "spawn":
			return `spawn ${args?.cli ?? "?"}${args?.name ? ` · ${rowText(args.name, NAME_MAX)}` : ""}`;
		case "send":
			return `send → ${args?.session ? rowText(args.session, NAME_MAX) : "?"}`;
		case "wait":
			return args?.sessions?.length
				? `wait on ${rowText(args.sessions.join(", "), SESSION_LIST_MAX)}`
				: "wait on running sessions";
		case "kill":
			return `kill ${args?.session ? rowText(args.session, NAME_MAX) : "?"}`;
		case "list":
			return "sessions";
	}
}

/**
 * The composer rows: the message being typed into a worker's CLI.
 *
 * The caret is a run of its own rather than text appended to the message, because it is the host's
 * mark for the position a reader is typing at; it appears on the frames the surface says are even, so
 * the blink is the tool's rhythm and the clock is the host's.
 */
function composerRows(message: string, options: { caret: boolean; expanded: boolean }): ViewLine[] {
	const raw = message.split(/\r?\n/).filter(line => line.trim().length > 0);
	const max = options.expanded ? COMPOSER_ROWS_EXPANDED : COMPOSER_ROWS_COLLAPSED;
	const visible = raw.slice(0, max).map(line => rowText(line, COMPOSER_LINE_MAX));
	if (visible.length === 0) visible.push("");
	const overrun = raw.length > max;
	return visible.map((line, index) => {
		const lead: ViewSpan[] = index === 0 ? [{ text: ">", tone: "accent" }, GAP] : [{ text: SCREEN_BODY_INDENT }];
		const body: ViewSpan[] = [{ text: line, tone: "output" }];
		const last = index === visible.length - 1;
		if (last && overrun) body.push(GAP, { text: "…", tone: "output" });
		else if (last && options.caret) body.push({ text: "|", symbol: "sep.block", tone: "accent" });
		return [...lead, ...body];
	});
}

/** Whether a worker is between the start of a turn and its end. */
function isLive(screen: VibeScreenSnapshot): boolean {
	return screen.state === "running" || screen.state === "starting";
}

/**
 * One worker's rows: what it is, then what it is doing.
 *
 * The id and the tool it is part way through are the moving parts, so both are marked live and the
 * host animates whichever of them it can. A settled worker states the outcome its turn reached
 * instead of the state it is resting in.
 */
function screenRows(
	screen: VibeScreenSnapshot,
	context: ToolViewContext,
	settled?: "completed" | "failed" | "cancelled",
): ViewLine[] {
	const live = isLive(screen);
	const status: ViewStatus =
		settled === "failed" ? "error" : settled === "cancelled" ? "aborted" : stateStatus(screen.state);
	const head: ViewSpan[] = [
		{ text: "", status },
		GAP,
		{ text: screen.cli, tone: stateTone(screen.state), badge: true },
		GAP,
		{ text: screen.id, tone: live ? "accent" : "output", live },
		GAP,
		{ text: settled ?? screen.state, tone: "dim" },
		GAP,
		{ text: `${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`, tone: "muted" },
	];
	if (screen.turnStartedAt !== undefined) {
		head.push(GAP, { text: formatDuration(Date.now() - screen.turnStartedAt), tone: "dim" });
	}
	if (screen.model) head.push(GAP, { text: rowText(screen.model, MODEL_MAX), tone: "muted" });

	const body: ViewLine[] = [];
	if (live) {
		if (screen.turnMessage) {
			body.push([
				{ text: SCREEN_BODY_INDENT },
				{ text: ">", tone: "accent" },
				GAP,
				{ text: rowText(screen.turnMessage, TV_LINE_MAX), tone: "dim" },
			]);
		}
		const traceCap = context.expanded ? TV_TRACE_EXPANDED : TV_TRACE_COLLAPSED;
		for (const line of screen.trace.slice(-traceCap)) {
			body.push([{ text: SCREEN_BODY_INDENT }, hook("dim"), GAP, { text: rowText(line, TV_LINE_MAX), tone: "dim" }]);
		}
		if (screen.currentTool) {
			const detail = screen.lastIntent ?? screen.currentToolArgs;
			const label = `${screen.currentTool}${detail ? `: ${detail}` : ""}`;
			body.push([
				{ text: SCREEN_BODY_INDENT },
				hook("accent"),
				GAP,
				{ text: rowText(label, TV_LINE_MAX), tone: "muted", live: true },
			]);
		} else if (screen.lastIntent) {
			body.push([
				{ text: SCREEN_BODY_INDENT },
				hook("accent"),
				GAP,
				{ text: rowText(screen.lastIntent, TV_LINE_MAX), tone: "muted" },
			]);
		}
		const outputCap = context.expanded ? TV_OUTPUT_EXPANDED : TV_OUTPUT_COLLAPSED;
		for (const line of screen.outputTail.slice(-outputCap)) {
			if (line.trim().length === 0) continue;
			body.push([
				{ text: SCREEN_BODY_INDENT },
				{ text: SCREEN_BODY_INDENT },
				{ text: rowText(line, TV_LINE_MAX), tone: "muted" },
			]);
		}
	} else if (screen.lastActivity) {
		body.push([
			{ text: SCREEN_BODY_INDENT },
			hook("dim"),
			GAP,
			{ text: rowText(screen.lastActivity, TV_LINE_MAX), tone: "muted" },
		]);
	}

	if (settled === undefined) return [head, ...body];
	const tone: ViewTone = settled === "completed" ? "success" : settled === "failed" ? "error" : "warning";
	return [head, ...body, [{ text: `turn ${settled} — result delivered`, tone }]];
}

/** The row a card that has no details of its own falls back to. */
function fallbackText(result: VibeToolResult, absent: string): string {
	return extractResultText(result.content) || absent;
}

const VIBE_CLIS: readonly VibeCli[] = ["fast", "good"];
const VIBE_STATES: readonly VibeSessionState[] = ["starting", "running", "idle", "dead"];
const SETTLED_STATUSES = ["completed", "failed", "cancelled"] as const;

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return finiteNumber(value) ?? undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function oneOf<T extends string>(value: unknown, members: readonly T[]): T | undefined {
	return typeof value === "string" && (members as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** A worker snapshot from whatever a session file recorded, or nothing when it has no id or flavour. */
function screenOf(raw: unknown): VibeScreenSnapshot | undefined {
	if (!isRecord(raw)) return undefined;
	const id = optionalString(raw.id);
	const cli = oneOf(raw.cli, VIBE_CLIS);
	const state = oneOf(raw.state, VIBE_STATES);
	if (id === undefined || cli === undefined || state === undefined) return undefined;
	return {
		id,
		cli,
		state,
		model: optionalString(raw.model),
		turns: optionalNumber(raw.turns) ?? 0,
		queued: optionalNumber(raw.queued) ?? 0,
		turnStartedAt: optionalNumber(raw.turnStartedAt),
		turnMessage: optionalString(raw.turnMessage),
		currentTool: optionalString(raw.currentTool),
		currentToolArgs: optionalString(raw.currentToolArgs),
		lastIntent: optionalString(raw.lastIntent),
		trace: stringList(raw.trace),
		outputTail: stringList(raw.outputTail),
		lastActivity: optionalString(raw.lastActivity),
		lastActivityAt: optionalNumber(raw.lastActivityAt) ?? 0,
	};
}

function waitOf(raw: unknown): VibeToolDetails["wait"] {
	if (!isRecord(raw)) return undefined;
	const settled: NonNullable<VibeToolDetails["wait"]>["settled"] = [];
	if (Array.isArray(raw.settled)) {
		for (const entry of raw.settled) {
			if (!isRecord(entry)) continue;
			const id = optionalString(entry.id);
			const status = oneOf(entry.status, SETTLED_STATUSES);
			if (id === undefined || status === undefined) continue;
			settled.push({ id, jobId: optionalString(entry.jobId) ?? "", status });
		}
	}
	return {
		settled,
		stillRunning: stringList(raw.stillRunning),
		timedOut: raw.timedOut === true,
		waiting: raw.waiting === true ? true : undefined,
	};
}

/**
 * The details a vibe card reads, from whatever the result carries.
 *
 * A result read back from a session file, a collab wire or an older build is not the shape the tool
 * wrote today, and a card that indexes into it as if it were throws inside the host's draw. Every
 * field is checked here and a malformed one is dropped, so the card states what it can and never
 * fails. A payload that is not a record at all reads as no details, which is the text-only card.
 */
export function normalizeVibeDetails(raw: unknown): VibeToolDetails | undefined {
	if (!isRecord(raw)) return undefined;
	const op = oneOf(raw.op, ["spawn", "send", "wait", "kill", "list"] as const);
	if (op === undefined) return undefined;
	const screens: VibeScreenSnapshot[] = [];
	if (Array.isArray(raw.screens)) {
		for (const entry of raw.screens) {
			const screen = screenOf(entry);
			if (screen !== undefined) screens.push(screen);
		}
	}
	const details: VibeToolDetails = { op, screens };
	if (isRecord(raw.spawned)) {
		const id = optionalString(raw.spawned.id);
		const cli = oneOf(raw.spawned.cli, VIBE_CLIS);
		if (id !== undefined && cli !== undefined) {
			details.spawned = { id, cli, jobId: optionalString(raw.spawned.jobId) ?? "" };
		}
	}
	if (isRecord(raw.send)) {
		const id = optionalString(raw.send.id);
		const mode = oneOf(raw.send.mode, ["turn", "steered", "queued"] as const);
		if (id !== undefined && mode !== undefined) {
			details.send = { id, mode, jobId: optionalString(raw.send.jobId) };
		}
	}
	const wait = waitOf(raw.wait);
	if (wait !== undefined) details.wait = wait;
	if (isRecord(raw.killed)) {
		const id = optionalString(raw.killed.id);
		if (id !== undefined) details.killed = { id, cancelledTurn: raw.killed.cancelledTurn === true };
	}
	return details;
}

/**
 * The composer card: the message, and what became of it.
 *
 * `typing` is what the card is: a call is a message still being typed, so it blinks a caret on the
 * frames the surface repaints; a result is a message that was delivered, and a delivered message
 * carries no caret whatever the frame says.
 */
function composerCard(
	header: StatusRowView,
	message: string,
	context: ToolViewContext,
	footer: ViewLine,
	typing: boolean,
): ToolView {
	const caret = typing && context.frame !== undefined && (context.frame & 1) === 0;
	return {
		kind: "headedBlock",
		header,
		lines: [...composerRows(message, { caret, expanded: context.expanded }), footer],
	} satisfies HeadedBlockView;
}

/** The wall: one row per worker, under a row that reports the set. */
function wallCard(op: VibeOp, details: VibeToolDetails, context: ToolViewContext): ToolView {
	const screens = details.screens;
	const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
	const running = screens.filter(isLive).length;
	const meta: ViewLine[] = [];
	if (running > 0) meta.push([{ text: `${running} on air`, tone: "accent" }]);
	if (settledById.size > 0) meta.push([{ text: `${settledById.size} settled`, tone: "success" }]);
	if (details.wait?.timedOut) meta.push([{ text: "timed out", tone: "warning" }]);
	const title =
		op === "wait"
			? details.wait?.waiting === true
				? "vibe wait — watching the wall"
				: "vibe wait"
			: `vibe sessions (${screens.length})`;
	return {
		kind: "headedBlock",
		header: {
			kind: "statusRow",
			status: details.wait?.timedOut ? "warning" : running > 0 ? "info" : "done",
			title,
			meta,
		},
		lines: screens.flatMap(screen => screenRows(screen, context, settledById.get(screen.id))),
	} satisfies HeadedBlockView;
}

/**
 * The card each of the five vibe tools describes, by the operation it performs.
 *
 * One factory rather than five modules: every tool returns the same details payload and differs in
 * the row it is titled with and the outcome it leads with, which is exactly what the operation says.
 */
export function createVibeToolView(op: VibeOp): Required<ToolViewRenderer<VibeRenderArgs, VibeToolResult>> {
	const composerOp = op === "spawn" || op === "send";
	return {
		renderCall(args, context): ToolView {
			if (!composerOp) {
				return { kind: "statusRow", status: "pending", title: `vibe ${describeCall(op, args)}` };
			}
			const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
			return composerCard(
				{ kind: "statusRow", title: `vibe ${describeCall(op, args)}`, titleTone: "muted" },
				message,
				context,
				[{ text: op === "spawn" ? "booting CLI…" : "delivering…", tone: "dim" }],
				true,
			);
		},

		renderResult(result, context, args): ToolView {
			const details = normalizeVibeDetails(result.details);
			if (details === undefined || result.isError === true) {
				const text = fallbackText(result, "");
				const header: StatusRowView = {
					kind: "statusRow",
					status: result.isError === true ? "error" : "done",
					title: `vibe ${describeCall(op, args)}`,
				};
				if (text === "") return header;
				return {
					kind: "headedBlock",
					header,
					lines: [[{ text: rowText(text, TV_LINE_MAX), tone: result.isError === true ? "error" : "dim" }]],
				} satisfies HeadedBlockView;
			}

			if (composerOp) {
				const message = op === "spawn" ? (args?.prompt ?? "") : (args?.message ?? "");
				const header: StatusRowView =
					op === "spawn"
						? {
								kind: "statusRow",
								title: "vibe spawn",
								titleTone: "muted",
								description: rowText(details.spawned?.id ?? args?.name ?? "", NAME_MAX),
								descriptionTone: "accent",
								badge: { label: details.spawned?.cli ?? args?.cli ?? "?", tone: "accent" },
							}
						: {
								kind: "statusRow",
								title: "vibe send",
								titleTone: "muted",
								description: rowText(args?.session ?? "?", NAME_MAX),
								descriptionTone: "accent",
							};
				const jobNote = (jobId: string | undefined): string => (jobId === undefined ? "" : ` (job ${jobId})`);
				const footer: ViewLine =
					op === "spawn"
						? [{ text: `turn started${jobNote(details.spawned?.jobId)}`, tone: "success" }]
						: details.send?.mode === "steered"
							? [{ text: "steered into the running turn", tone: "success" }]
							: details.send?.mode === "queued"
								? [{ text: "mid-turn — queued as the next turn", tone: "warning" }]
								: [{ text: `turn started${jobNote(details.send?.jobId)}`, tone: "success" }];
				return composerCard(header, message, context, footer, false);
			}

			if (op === "kill") {
				const meta: ViewLine[] = details.killed?.cancelledTurn
					? [[{ text: "in-flight turn cancelled", tone: "warning" }]]
					: [];
				return {
					kind: "statusRow",
					status: "done",
					title: "vibe kill",
					description: rowText(details.killed?.id ?? args?.session ?? "?", NAME_MAX),
					descriptionTone: "accent",
					meta,
				};
			}

			if (details.screens.length === 0) {
				return {
					kind: "statusRow",
					status: "warning",
					title: `vibe ${op}`,
					meta: [[{ text: rowText(fallbackText(result, "no sessions"), SESSION_LIST_MAX), tone: "dim" }]],
				};
			}
			return wallCard(op, details, context);
		},
	};
}
