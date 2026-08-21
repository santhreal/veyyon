/**
 * The subagent HUD, drawn as lanes.
 *
 * WHY this is not a tree. `renderTreeList` is right for the todo board and got
 * copied here because the two blocks sit next to each other above the composer —
 * the old renderer's own comment said it "mirrors the Todos HUD exactly". But a
 * todo board is an ORDERED, finite list of steps, which is what a tree draws,
 * while running agents are CONCURRENT and unbounded, and the question a
 * concurrency display answers is how its rows compare to each other right now.
 * `├─`/`└─` defeats exactly that: every row's content starts at a different
 * effective column, so nothing lines up down the block and each row has to be
 * read on its own. Lanes give one fixed column per fact, so a glance down the
 * block compares the agents instead of describing each one.
 *
 * WHY these columns. {@link AgentProgress} carries `currentTool`,
 * `currentToolArgs` and `retryState`, and the old row printed none of them: it
 * printed the id, the spawn description and the model badge, all three constant
 * for the agent's whole life. Three agents — one four seconds in, one ninety
 * seconds into a single grep, one asleep on a rate limit — rendered
 * byte-identical. Every column below is a fact that CHANGES.
 *
 * WHY activity, description and recovery share one column. While a tool is in
 * flight the middle column says what the agent is DOING; with nothing in flight
 * it falls back to what the agent is FOR; and while a recovery is sleeping it
 * says neither, because "blocked on a 429 for another thirty-eight seconds" is
 * not a kind of working and outranks both. Printing all three means printing the
 * description forever to say nothing, and at 100 columns it is the description
 * that pushes the live facts off the end of the row.
 *
 * WHY nothing sits on the right but the model. A clock, a context gauge and a
 * badge in three text columns read as a table, and every attempt to make that
 * right side interesting made it worse: a pip gauge per lane turned the block
 * into a monitoring dashboard for a question nobody asks of a subagent (its
 * remaining window is a SESSION fact, and its parent decides nothing with it), a
 * histogram of recent step durations read as noise, and a travelling wave whose
 * height encoded step age spent seven columns per lane, forever, on one scalar
 * with a doubling law no reader can decode without a legend. The question all
 * three were reached for is "is this one stuck", and `retryState` answers it as a
 * FACT in the column that already exists.
 *
 * WHY the header carries no count. `Subagents` is the whole header. The number of
 * running agents is not news next to the rows that are the agents: the one place
 * a count says something the lanes cannot is when the block stopped drawing some
 * of them, so it lives in the overflow row, which exists only when it is true.
 *
 * WHY the one animated thing is the rail. Light travelling down `block.rail` is
 * how every live block in this product says it is working, it is owned in one
 * place ({@link paintRailMotion}), and its invariants are already pinned: the row
 * count cannot change inside a pass and the last frame is byte-identical to the
 * static render. The sweep here is gated per lane — the head travels the full
 * height and lights only the lanes that are inside a tool — so the motion says
 * which agents are working rather than only that the block exists. An earlier cut
 * of this file put a lava crawl on the tool NAME instead, which is the house
 * treatment for "the one live thing" and was two motions competing in one block
 * for a fact the rail was already carrying.
 *
 * The rail's SHAPE never changes: one constant glyph, because its width is what
 * makes the lanes line up, and animating that width made three rows of ragged
 * left edge. State is in its colour — accent inside a tool, dim waiting on the
 * model, warning sleeping on a recovery, error once one gave up.
 */

import { visibleWidth } from "@veyyon/tui";
import { formatTaskId } from "../../task/render";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../utils/session-color";
import { formatRetryLine } from "../retry-display";
import type { ObservableSession } from "../session-observer-registry";
import { type ThemeColor, theme } from "../theme/theme";
import { modelBadgeFromSelector } from "./agent-model-badge";

/** Lanes drawn before the block stops and counts the rest. */
export const SUBAGENT_LANE_VISIBLE_LIMIT = 8;
/** Widest id column, so one long CamelCase name cannot eat the row. */
const LANE_ID_MAX = 22;
/** Narrowest the middle column may be squeezed before a column is dropped instead. */
const LANE_MIDDLE_MIN = 18;
/** Gap between lane columns. Two cells: one reads as a word break, three as a table. */
const LANE_GAP = 2;
/** Cap on the model badge, matching the inline task widget's own cap. */
const LANE_BADGE_MAX = 30;

/** One agent's row, before any of it is styled or fitted. */
interface Lane {
	id: string;
	/** That agent's stable session accent, so its lane and its todo row match. */
	accentHex: string;
	/** What the agent is doing now, when a tool is in flight. */
	tool?: string;
	/** The in-flight tool's own argument summary. */
	toolArgs?: string;
	/** What the agent is for, shown when nothing is in flight. */
	description?: string;
	/** A sleeping or exhausted recovery, which outranks both of the above. */
	recovery?: { text: string; color: ThemeColor };
	badge: string;
	/** The rail's colour for this lane's state. */
	railColor: ThemeColor;
	/** A tool is in flight: the sweep may light this lane. */
	live: boolean;
}

/** The block, plus which of its railed rows the sweep is allowed to light. */
export interface SubagentLaneBlock {
	lines: string[];
	/** One entry per railed row, in render order, for {@link RailMotionOptions.lit}. */
	lit: boolean[];
}

export interface SubagentLaneOptions {
	columns: number;
	/** `subagent.showResolvedModelBadge`, read by the caller so this stays pure. */
	showModelBadge: boolean;
	/** Wall clock, for the countdown on a sleeping recovery. */
	nowMs: number;
}

function laneOf(session: ObservableSession, options: SubagentLaneOptions): Lane {
	const progress = session.progress;
	const resolved = progress?.resolvedModel;
	let badge =
		options.showModelBadge && resolved
			? truncateToWidth(modelBadgeFromSelector(resolved, theme), LANE_BADGE_MAX)
			: "";
	// A dim arrow when this is not the model the agent started on: the badge alone
	// says what it runs on and cannot say that it is not what you picked.
	if (badge !== "" && progress?.fellBackFrom) badge = `${theme.fg("dim", "↓")}${badge}`;
	const tool = progress?.currentTool?.trim() || undefined;

	// A recovery outranks the activity column and takes the rail out of the sweep:
	// an agent asleep on a 429 is not working, and the whole reason this state is
	// drawn is that it used to render as `waiting` — byte-identical to an agent
	// thinking, which is the one other thing it could have been.
	let recovery: Lane["recovery"];
	let railColor: ThemeColor = tool ? "accent" : "dim";
	const retry = progress?.retryState;
	const failure = progress?.retryFailure;
	if (retry) {
		recovery = {
			text: formatRetryLine({
				attempt: retry.attempt,
				maxAttempts: retry.maxAttempts,
				delayMs: Math.max(0, retry.startedAtMs + retry.delayMs - options.nowMs),
				errorMessage: retry.errorMessage,
				mode: retry.mode,
			}),
			color: "warning",
		};
		railColor = "warning";
	} else if (failure) {
		// The same phrasing the inline task row uses, which names the recovery that
		// gave up and never a cause: `retryFailure` is set from any unsuccessful
		// recovery, and a quota window is one possibility out of several.
		recovery = {
			text: failure.mode === "continue" ? "continuation gave up" : "retries gave up",
			color: "error",
		};
		railColor = "error";
	}

	return {
		id: formatTaskId(session.id),
		accentHex: getSessionAccentHex(session.id, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
		tool,
		toolArgs: tool ? progress?.currentToolArgs?.trim() || undefined : undefined,
		description: session.description?.trim() || progress?.description?.trim() || progress?.task?.trim() || undefined,
		recovery,
		badge,
		railColor,
		live: tool !== undefined && recovery === undefined,
	};
}

/**
 * The middle column: what the agent is blocked on, doing, or for, in that order.
 *
 * The argument absorbs the whole squeeze: `read` with no path still says what
 * kind of work is in flight, while a truncated `rea` says nothing at all, so the
 * name never truncates while there is a name to draw. Nothing here moves — the
 * rail is the block's one motion, and a second one competing with it in the same
 * row is how an animation ends up saying less than a still.
 */
function middleColumn(lane: Lane, width: number): string {
	if (lane.recovery) return theme.fg(lane.recovery.color, truncateToWidth(lane.recovery.text, width));
	if (lane.tool) {
		const name = replaceTabs(lane.tool);
		const args = lane.toolArgs ? replaceTabs(lane.toolArgs) : "";
		const room = width - visibleWidth(name) - 1;
		if (args === "" || room < 4) return theme.fg("borderAccent", truncateToWidth(name, width));
		return `${theme.fg("borderAccent", name)} ${theme.fg("muted", truncateToWidth(args, room))}`;
	}
	if (lane.description) return theme.fg("dim", truncateToWidth(replaceTabs(lane.description), width));
	return theme.fg("dim", truncateToWidth("waiting", width));
}

/**
 * Build the anchored subagent HUD block: a header, then one lane per detached
 * background spawn.
 *
 * Only detached spawns are listed. A synchronous `task` call blocks the parent
 * turn and its inline tool block already renders progress live, and eval
 * `agent()` spawns are rendered by their own eval cell tree. Returns no lines
 * when nothing is running, so the container clears itself.
 */
export function renderSubagentLaneLines(
	sessions: readonly ObservableSession[],
	options: SubagentLaneOptions,
): SubagentLaneBlock {
	const empty: SubagentLaneBlock = { lines: [], lit: [] };
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return empty;

	const visible = running.slice(0, SUBAGENT_LANE_VISIBLE_LIMIT);
	const hidden = running.length - visible.length;
	const lanes = visible.map(session => laneOf(session, options));
	const rail = theme.symbol("block.rail");

	// The last column is left clear: a row that fills it arms the terminal's
	// pending wrap, and a wrapped row in an anchored region does not scroll away,
	// it makes the region taller on every rebuild.
	//
	// EVERY width below is a CLAMP against what is actually left, and never a
	// minimum. That is the one rule this block has, and breaking it three separate
	// ways is what the width sweep in `test/subagent-hud-render.test.ts` caught: a
	// floor of 24 here, a floor of 40 on the middle column, and a floor of 8 on the
	// id each put rows past the viewport on some terminal, and each was invisible
	// at the width it was written at. A readable minimum is a wish; the viewport is
	// a fact. When there is not enough room, columns come off and the rest shrink
	// to nothing — a block that draws a rail and three letters of an id is honest,
	// and a block that wraps is not.
	const usable = Math.max(1, options.columns - 1);
	// Row chrome: the one-space shift every line below the header carries, the
	// rail, and the space after it.
	const chrome = 1 + visibleWidth(rail) + 1;
	const forColumns = Math.max(0, usable - chrome);
	// Not one cell for a rail, a space and a letter of an id. There is no honest
	// lane at this width, and the empty block is how this says so — the same path
	// it takes when nothing is running, so the container clears rather than
	// drawing chrome that cannot fit.
	if (forColumns < 1) return empty;

	const badgeWidth = Math.max(0, ...lanes.map(lane => visibleWidth(lane.badge)));

	// The badge is charged before the flexible middle column and dropped when the
	// middle column would be squeezed past reading: it is a name that does not
	// change for the agent's whole run, and what the agent is DOING is the reason
	// the block exists.
	let showBadge = badgeWidth > 0;
	const fixed = (): number => (showBadge ? LANE_GAP + badgeWidth : 0);
	// The id wants its natural width and takes less when less is there.
	const idWanted = Math.min(LANE_ID_MAX, Math.max(...lanes.map(lane => visibleWidth(lane.id))));
	const middleFor = (): number => forColumns - idWanted - LANE_GAP - fixed();
	if (middleFor() < LANE_MIDDLE_MIN && showBadge) showBadge = false;
	// Nothing else is left to drop, so the id and the middle share what remains.
	// The id keeps at most two thirds of it, so a long name cannot leave the
	// activity column with nothing at all.
	const spare = forColumns - LANE_GAP - fixed();
	const idWidth = Math.max(
		0,
		Math.min(idWanted, spare < idWanted + LANE_MIDDLE_MIN ? Math.floor(spare * 0.66) : spare),
	);
	const middleWidth = Math.max(0, spare - idWidth);

	const pad = (text: string, width: number): string => {
		const short = width - visibleWidth(text);
		return short > 0 ? text + " ".repeat(short) : text;
	};
	const gap = " ".repeat(LANE_GAP);

	// `dim` for a waiting lane and not `borderMuted`, which is what a tool block's
	// settled rail uses: titanium's `borderMuted` is `#202329` and the ground it
	// renders on is `#1e2127`, so a waiting lane lost its left edge entirely on
	// grey and kept it only on black. A rail that disappears takes the lane's
	// column structure with it, which is the one thing this layout is for.
	const rows = lanes.map(lane => {
		// The id is painted in the agent's own session accent rather than the one
		// shared silver: it is what lets a delegated todo row point at a worker
		// without printing anything, and it is the same hue the status line already
		// gives that session's name.
		const accent = getSessionAccentAnsi(lane.accentHex);
		const idText = truncateToWidth(lane.id, idWidth);
		const idCell = accent ? `${accent}${theme.bold(idText)}\x1b[39m` : theme.bold(theme.fg("accent", idText));
		// Only columns that have a cell to show are joined. `trimEnd` cannot do this
		// job: a zero-width column still emits its colour escapes, so the padding
		// before them is no longer TRAILING whitespace and survives the trim — which
		// is how a 5-column terminal drew a 5-cell row against a 4-cell bound. The
		// widths are block-wide, so a dropped column is dropped on every lane and
		// the block stays aligned.
		const cells = [pad(idCell, idWidth), pad(middleColumn(lane, middleWidth), middleWidth)];
		if (showBadge) cells.push(lane.badge);
		const shown = cells.filter(cell => visibleWidth(cell) > 0);
		return `${theme.fg(lane.railColor, rail)}${shown.length > 0 ? ` ${shown.join(gap)}` : ""}`.trimEnd();
	});

	const lines = [theme.bold(theme.fg("accent", truncateToWidth("Subagents", usable)))];
	const lit = lanes.map(lane => lane.live);
	lines.push(...rows.map(line => ` ${line}`));
	if (hidden > 0) {
		// The count lives here and nowhere else: it is news only when the block
		// stopped drawing agents, and this row exists only then.
		lines.push(
			` ${theme.fg("dim", truncateToWidth(`… ${hidden} more running — /agents for the full roster`, forColumns + 2))}`,
		);
	}
	return { lines: ["", ...lines], lit };
}
