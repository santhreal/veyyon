/**
 * The composer footline, as a value: gather the configured segments into their
 * three groups, then fit those groups to a row.
 *
 * BOTH ROWS ARE THIS FILE. `StatusLineComponent` renders the live footline
 * through it, and the launch card renders the one it paints before a session
 * exists through it. They were two renderers, and the launch one was a
 * hand-written `path · git` that had to be kept byte-identical to the real row
 * by hand: it omitted every segment added since it was written, it re-derived
 * the separator and the inset, and the handover between them was a redraw the
 * reader could see.
 *
 * Nothing here reads a session, a clock, or an animation. Every live value the
 * fitter needs — the focus badge, the run clock, the click expansion — arrives
 * as a field on {@link QuietRowInput}, so the class keeps the state and this
 * file keeps the layout. A caller with no state passes the resting value and
 * gets the resting row.
 */

import { padding } from "@veyyon/utils/padding";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { sliceWithWidth, truncateToWidth, visibleWidth } from "@veyyon/utils/width";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../../../config/settings-instance";
import { withIcon } from "../../../../theme/icon-label";
import { theme } from "../../../../theme/theme";
import { getPreset, resolvePresetSegments } from "./presets";
import { renderSegment } from "./segments";
import { segmentSeparator } from "./state-grammar";
import type {
	EffectiveStatusLineSettings,
	SegmentContext,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

/**
 * One quiet-footline part: the segment id it came from plus its rendered
 * content. Ids are StatusLineSegmentId values, or the synthetic "badges"
 * (the animated badge slot) / "location_right" (owner-pinned right content).
 *
 * `pin` is the cells at the front a front clip must keep, which the segment declares (see
 * `RenderedSegment.pin`): the path's icon says whether the row names a worktree, a scratch
 * directory or a plain folder, and the cut takes its cells out of the path instead.
 */
export type QuietPart = { id: string; content: string; pin?: number };

/**
 * Shed order for the right group, as a rank rather than a boolean. Higher survives longer;
 * everything unlisted ranks 0 and sheds first, right to left, which is the ordinary case.
 *
 * A rank rather than a flag because "protected" cannot be absolute. When every remaining part
 * was protected the shed had nothing legal to drop, fell through to truncating the joined
 * group, and a one-cell budget rendered a bare `…` — destroying all four at once, including
 * the one the oldest contract here says must be the last thing standing. The ranking makes the
 * degradation ordered instead: the weakest ranked part goes, then the next, and the persistent
 * count is alone on the line before anything clips it.
 * Why each of the six outranks a badge:
 *
 * `background` (6) counts the conversations this process is running that NO screen is showing.
 * It outranks even the persistent subagent count, which is the only thing here it could be
 * accused of crowding out: a running subagent is spending in a transcript the operator is
 * looking at, and a handed-off conversation is spending somewhere they cannot look at all. It
 * renders nothing at zero, so on the overwhelmingly common single-conversation line it costs
 * the width it is worth, and the older contract below never observes it because that fixture
 * has no background conversation.
 *
 * `subagents` (5) is the persistent running count. It is the last thing standing by an older
 * contract than any of the rest: `status-line-running-subagents.test.ts` narrows the footline
 * to exactly the chip's width and requires the number to be what survives.
 *
 * `location_right` (4) is the owner-supplied zone holding the composer's draft token readout.
 * It is pushed LAST and the shed walks from the end, so without a rank it is always the FIRST
 * casualty however important it is. That is how the always-visible approval rung silently
 * evicted the draft counter at 100 columns: nothing removed the counter, the rung widened the
 * right group by one label and the counter fell off the end. Losing the count while the
 * operator is actively typing is a worse trade than dropping a badge they can re-read.
 *
 * `mode` (3) carries the approval rung — the one place that says whether the next command will
 * ask before it runs ("safety state outranks identity").
 *
 * `model` (2) is the active session model identity. Ranking it ensures the model name is preserved
 * against wide location strings (long working directories and git branches) by shortening the location
 * before shedding the model name.
 *
 * `context_pct` (1) is how much room is left before compaction fires — the footline's one live
 * value. `#gatherQuietSegments` appends it AFTER the right group on purpose, so it reads as the
 * line's last word, and the shed walks from the end: the deliberate placement made it the first
 * thing dropped at every width that did not fit, while `session_name`, a fixed string, was kept
 * ahead of it. On the DEFAULT preset at 80 columns that meant no gauge at all, and on `full` at
 * 160 it meant a cache-hit percentage on screen while the number that says when the session
 * ends was gone. It ranks lowest of the five because it is the only one that still reads as a
 * whole thought after the others are gone.
 */
const RIGHT_PART_SHED_RANK: Record<string, number> = {
	context_pct: 1,
	model: 2,
	mode: 3,
	location_right: 4,
	subagents: 5,
	background: 6,
};

/**
 * The part the row gives up next: the lowest-ranked one, taken from the END so that equally
 * ranked parts still go right to left. Index -1 for an empty group.
 */
function weakestRightPart(parts: readonly QuietPart[]): { index: number; rank: number } {
	let index = -1;
	let rank = Number.POSITIVE_INFINITY;
	for (let i = parts.length - 1; i >= 0; i--) {
		const partRank = RIGHT_PART_SHED_RANK[parts[i]?.id ?? ""] ?? 0;
		if (partRank < rank) {
			rank = partRank;
			index = i;
		}
	}
	return { index, rank };
}

/**
 * What the location's FLOOR may be paid with, when the zone has been cut under the width at
 * which a directory or a branch still reads as itself.
 *
 * This is a different question from the shed order above, which asks what the ROW gives up to
 * fit at all, and it wants a different answer. These three are re-readable or recoverable: a
 * percentage is back on the next frame, a draft token estimate is re-derived on the next
 * keystroke, and owner-pinned right content restates itself. The model chip and the mode rungs
 * are not on that list: the chip is what this row exists to retain, and a rung says what the
 * next keystroke will DO, which is not something to spend on a wider directory.
 *
 * Neither is the persistent running-subagent count, which the row sheds LAST of all (see
 * RIGHT_PART_SHED_RANK). Paying the floor with it inverted that order twice over: a row whose
 * only remaining part was the count spent it and rendered nothing at all, and a row narrowing
 * under pressure lost the count while a mode rung it outranks stayed. A count is a small chip
 * and buys the zone almost nothing; the order it sits in is worth more than its three cells.
 * The animated badge slot is off the list for a duller reason: it is unranked, so the shed loop
 * above has already dropped it before this ladder can run.
 *
 * Without this the ladder stopped at the model chip and left the zone under its floor with
 * three spendable parts still on the row -- `…izer  ·  …g-path` beside a token estimate, two
 * fragments that each read as a name in their own right, which is the exact failure
 * MIN_LOCATION_PART exists to prevent.
 */
export const FLOOR_SPENDABLE: Record<string, true> = {
	context_pct: true,
	context_total: true,
	location_right: true,
};

/**
 * The spendable part the location's floor takes next: lowest-ranked first, from the END, so
 * the order among them matches the row's own. -1 when the row holds nothing it may spend.
 */
function weakestSpendablePart(parts: readonly QuietPart[]): number {
	let index = -1;
	let rank = Number.POSITIVE_INFINITY;
	for (let i = parts.length - 1; i >= 0; i--) {
		const id = parts[i]?.id ?? "";
		if (!FLOOR_SPENDABLE[id]) continue;
		const partRank = RIGHT_PART_SHED_RANK[id] ?? 0;
		if (partRank < rank) {
			rank = partRank;
			index = i;
		}
	}
	return index;
}

/** The one clip mark on the footline, wherever a clipper puts it. */
const ELLIPSIS = "…";

/**
 * Clip `text` to `maxWidth` by dropping cells off the FRONT.
 *
 * The location zone reads from its right end: the directory the session is in, the branch
 * checked out. Cutting the tail to fit a narrow row threw exactly that away and left the
 * project root, which every session under one project shares. Cutting the front keeps the
 * identifying end, and keeps it in the same direction `clampPathLength` cuts, so the two of
 * them cannot put an ellipsis on both ends of one path.
 *
 * `sliceWithWidth` replays the SGR state in force at the cut, so the visible tail keeps the
 * color the dropped opening set.
 *
 * THE MARK WEARS THE TEXT'S OWN COLOR. It used to be written ahead of that replayed state,
 * which left it painted in whatever the row was in before the segment -- the separator's grey
 * in front of a green branch, so the one glyph announcing a cut looked like it belonged to the
 * gap rather than to the name. It is emitted after the state instead.
 *
 * THE CUT LANDS ON A BOUNDARY WHERE ONE IS NEAR. A cut through the middle of a word leaves the
 * tail of that word reading as a name in its own right, and a cut one cell before a dash
 * leaves the dash orphaned against the mark: `…-model-retention-long-path` opens on punctuation
 * that belongs to a word the row no longer shows. Up to CLIP_SNAP cells are given up to reach
 * the next boundary, which is few enough that no row loses a name to tidiness, and never past
 * the point where the part would drop under MIN_LOCATION_PART -- tidiness does not get to spend
 * the floor. A `/` is kept, because a mark in front of a slash is how a shortened path has
 * always read; a word separator is dropped, because it has nothing left to join.
 *
 * `keepFront` is the part's pin: cells held at the FRONT, ahead of the mark, which the cut
 * steps over rather than eating (see `clipPartToWidth`).
 */
function clipStartToWidth(text: string, maxWidth: number, keepFront = 0): string {
	const total = visibleWidth(text);
	if (total <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	// One cell pays for the mark, unless the cut lands ON a mark already in the text: the
	// preset's `clampPathLength` ran at its own budget before the row was consulted, so the
	// head this cut eats is often that clamp's ellipsis with the segment icon in front of it.
	// Adding a second one painted `……orm-services/…` -- the both-ends defect again, one end
	// at a time -- so inherit that mark instead of stacking one on it.
	//
	// At a budget of one cell the mark is all there is room for, and a bare `…` is the honest
	// answer: the alternative is a fragment of a directory name that reads as a real one.
	const front = Math.max(0, keepFront);
	if (maxWidth <= front) return sliceWithWidth(text, 0, Math.min(front, maxWidth), true).text;
	const room = maxWidth - front - 1;
	const cut = snapForward(text, total - room, room, maxWidth);
	const head = front === 0 ? "" : sliceWithWidth(text, 0, front, true).text;
	const tail = sliceWithWidth(text, cut, total - cut, true).text;
	if (stripAnsi(tail).startsWith(ELLIPSIS)) return head + tail;
	// The colour the mark wears: the escapes the slice replays in front of the tail, emitted
	// once more before the mark so the mark is inside that run rather than in front of it. A
	// mark written ahead of them paints in whatever the row was in BEFORE the part -- the
	// separator's grey in front of a green branch -- which reads as belonging to the gap.
	//
	// The pin is why this takes a slice of the ORIGINAL text rather than of a head-trimmed
	// copy: a slice of a slice carries the sequences the first replay emitted, in an order that
	// need not end on the one in force, and a mark in front of an icon came out in the icon's
	// colour. One slice of the part's own content replays the state at the cut correctly.
	//
	// A budget with no room for a tail at all leaves nothing to read the state from, so it
	// comes off the last cell instead.
	const state = tail === "" ? sliceWithWidth(text, Math.max(0, total - 1), 1, true).text : tail;
	return `${head}${SGR_PREFIX.exec(state)?.[0] ?? ""}${ELLIPSIS}${tail}`;
}

/** The escape sequences a slice replays before its first visible cell. */
const SGR_PREFIX = /^(?:\x1b\[[0-9;:]*m)+/u;

/**
 * Cells a front cut may walk forward to reach a name boundary. Four, because the boundary this
 * exists for is one or two cells away -- an orphaned separator, or the tail of a short word --
 * and a wider allowance starts spending the name to buy the tidiness. Nothing is walked when
 * no boundary is that close.
 */
const CLIP_SNAP = 4;

/**
 * Boundaries a clipped name may open on, and whether the boundary itself is kept.
 *
 * BOTH separators, because only one of them is normalized away. `shortenPath` rewrites `\` to
 * `/` only for a path under the home directory, so a Windows session in `C:\work\…` reaches
 * this table with its own separator intact and no other character in it is a boundary: the
 * walk found nothing, and every clipped path on that platform opened mid-name, which is the
 * one thing this table exists to prevent.
 */
export const CLIP_BOUNDARIES: Record<string, "keep" | "drop"> = {
	"/": "keep",
	"\\": "keep",
	"-": "drop",
	_: "drop",
	".": "drop",
	"@": "drop",
	":": "drop",
};

/**
 * The column at or after `cut` a clip should open on: the nearest boundary within CLIP_SNAP
 * cells, or `cut` itself.
 *
 * The walk stops at whichever comes first: CLIP_SNAP cells, the cells the part has above
 * MIN_LOCATION_PART, or the room itself. The floor cap is the one that matters -- a part
 * fitted to thirteen cells was fitted there because twelve is the least a clipped name says,
 * and giving four of them away to open on a nicer character lands at nine.
 *
 * Only narrow cells are walked. The window's plain text is indexed as columns here, which is
 * true exactly while every grapheme in it occupies one cell; a wide or combining cell makes the
 * two disagree, and a cut placed on the wrong column would slice a cluster rather than tidy a
 * name. There is nothing to gain there anyway -- a boundary character is narrow by definition.
 */
function snapForward(text: string, cut: number, room: number, maxWidth: number): number {
	const reach = Math.min(CLIP_SNAP, room - 1, maxWidth - MIN_LOCATION_PART);
	if (reach <= 0) return cut;
	const window = stripAnsi(sliceWithWidth(text, cut, reach, true).text);
	if (window.length !== visibleWidth(window)) return cut;
	for (const [index, char] of [...window].entries()) {
		const boundary = CLIP_BOUNDARIES[char];
		if (boundary === undefined) continue;
		return boundary === "keep" ? cut + index : cut + index + 1;
	}
	return cut;
}

/**
 * Clip one location part to `width`, stepping over the cells it pinned.
 *
 * The part's pin is its icon (see `QuietPart.pin`), and the icon is the first thing a front
 * cut reaches. Eating it made the same directory render as a worktree at one width and as a
 * plain folder two columns narrower, so the glyph is kept and the mark lands after it: the
 * row reads `▫ …ingest-pipeline/normalizer`.
 *
 * Below the pin plus a mark there is no room to keep both, and the icon is what goes: a bare
 * glyph says which KIND of location the row named and no longer says which one.
 *
 * The pin is handed to the clipper rather than sliced off here, because a slice replays the
 * escape sequences the cut passed over in an order that need not end on the one in force, and
 * the mark's colour is read from the text it was given.
 */
function clipPartToWidth(part: QuietPart, width: number): string {
	const pin = part.pin ?? 0;
	return clipStartToWidth(part.content, width, width <= pin + 1 ? 0 : pin);
}

/**
 * The fewest cells a clipped location part is kept above while any WIDER part can still give
 * the room instead. Below about a dozen, a clipped tail is a fragment of one name and reads
 * as a name in its own right.
 *
 * It is also the width at or under which a part is never clipped at all: `⎇ main` is six
 * cells, and taking cells off a name that short buys the row almost nothing and costs the
 * reader the branch. A short branch stays whole at every width; only a long one pays.
 */
export const MIN_LOCATION_PART = 12;

/**
 * The fewest cells a part is worth keeping at all: the mark, plus one character of the name
 * behind it. At one cell a part is nothing but its own clip mark, and `… · …` names neither a
 * directory nor a branch -- the row is better off dropping the trailing part and spending the
 * cells on the directory.
 */
const MIN_READABLE_PART = 2;

/**
 * Fit the location parts into `budget` cells, keeping the RIGHT end of every one of them.
 *
 * NOTHING IS DROPPED while the row can hold the parts at all. Every part is clipped from its
 * own front instead, so the directory and the branch both stay on the row and both keep their
 * identifying end. Shedding a part whole was the first shape of this, and it took the branch
 * off rows where the release before it still showed the branch clipped: a short branch beside
 * a short directory is a better row than a long directory alone.
 *
 * Cutting the front of the JOIN is the other wrong answer: the tail of `path · branch` is the
 * branch, so one cut across the join eats the directory first and leaves the branch by itself.
 * The parts are therefore clipped INDIVIDUALLY.
 *
 * WHO PAYS. The widest clippable part, one cell at a time, so two long parts converge on a
 * shared width instead of one being spent whole to keep the other intact. A part at or under
 * MIN_LOCATION_PART is never asked -- `⎇ main` reads whole or not at all -- and the rest stop
 * at that floor while anything is still above it, going under it only when nothing else is
 * left to give.
 *
 * `cramped` says the zone had to go under its own floors to fit, which is the row's cue that
 * the budget is the problem: the caller sheds the context gauge and asks again rather than
 * accepting a location too short to read (see the shed loop).
 *
 * The one place a part leaves the row is a budget that cannot hold the separators and the
 * unclippable parts even at a cell each. There the trailing parts go, last first, and the
 * directory keeps the zone, because a lone `main` says nothing about where the session is.
 *
 * The slots are the painted extents of what survived, in columns of the returned text, so a
 * click resolves against the row on the screen rather than the join it was cut from.
 */
export function fitLocation(
	parts: readonly QuietPart[],
	sep: string,
	budget: number,
	favour?: string,
): { text: string; slots: QuietSegmentBounds[]; cramped: boolean } {
	const sepWidth = visibleWidth(sep);
	for (let count = parts.length; count > 1; count--) {
		const kept = parts.slice(0, count);
		const fitted = fillLocation(kept, sepWidth, budget, favour);
		if (fitted === null) continue;
		const assembled = assembleLocation(kept, fitted.contents, sep);
		return { ...assembled, cramped: fitted.cramped || count < parts.length };
	}
	const head = parts[0];
	if (head === undefined) return { text: "", slots: [], cramped: false };
	// The head alone, clipped to whatever there is. Under its readable minimum the zone says
	// nothing worth a cell: a directory whose icon has been eaten to fit the mark reads `…er`,
	// which names no directory and no longer even says whether this is a worktree. An empty
	// zone is the honest answer, and the row gives those cells to the group that can still use
	// them. This is reachable only on a terminal narrow enough that the right group alone
	// fills it.
	const width = visibleWidth(head.content);
	if (budget < readableFloor(head)) return { text: "", slots: [], cramped: true };
	const content = width <= budget ? head.content : clipPartToWidth(head, Math.max(0, budget));
	const assembled = assembleLocation([head], [content], sep);
	return { ...assembled, cramped: width > budget || parts.length > 1 };
}

/**
 * The fewest cells a part is worth painting in: its pinned cells, plus a mark, plus one cell of
 * the name the mark is standing in for.
 *
 * A pin is an icon, and the clipper drops the icon rather than the name when only one fits
 * (see `clipPartToWidth`), so without the pin in this number a two-cell icon turned into a
 * two-letter fragment of a directory name at the widths where the zone is nearly gone.
 */
function readableFloor(part: QuietPart): number {
	return (part.pin ?? 0) + MIN_READABLE_PART;
}

/**
 * Hand out the cells: the widest clippable part gives one up at a time, first down to
 * MIN_LOCATION_PART and then, only if the row still overflows, down to MIN_READABLE_PART. Null
 * when even that does not fit, which is the caller's signal to try one part fewer.
 */
function fillLocation(
	parts: readonly QuietPart[],
	sepWidth: number,
	budget: number,
	favour?: string,
): { contents: string[]; cramped: boolean } | null {
	const full = parts.map(part => visibleWidth(part.content));
	const allotted = [...full];
	let over = full.reduce((sum, width) => sum + width, 0) + sepWidth * (parts.length - 1) - budget;
	// Two passes: every clippable part down to the width a name still reads at, and only then
	// down to the fewest cells the part is worth painting at all -- which counts its pinned
	// icon, since the clipper spends the icon before the name.
	//
	// A FAVOURED part is the half a click named, and a click means "show me this one". It is
	// therefore asked last: it gives up nothing while any other part is still above the floor
	// of the pass, which is what makes the clicked half whole on a row that can hold it whole
	// at all. Without this the water-fill converged the two halves on a shared width and the
	// click widened a path that was still clipped -- the row had the cells, and spent them
	// keeping the OTHER half long.
	for (const stage of ["preferred", "readable"] as const) {
		while (over > 0) {
			let widest = -1;
			let widestFavoured = -1;
			for (const [index, width] of allotted.entries()) {
				const part = parts[index];
				if (part === undefined) continue;
				if ((full[index] ?? 0) <= MIN_LOCATION_PART) continue;
				if (width <= (stage === "preferred" ? MIN_LOCATION_PART : readableFloor(part))) continue;
				if (favour !== undefined && part.id === favour) {
					widestFavoured = index;
					continue;
				}
				// Ties go to the LATER part: the directory is the head a reader places the row
				// by, so when two parts are equally wide the branch gives up the cell.
				if (widest < 0 || width >= (allotted[widest] ?? 0)) widest = index;
			}
			if (widest < 0) widest = widestFavoured;
			if (widest < 0) break;
			allotted[widest] = (allotted[widest] ?? 0) - 1;
			over--;
		}
	}
	if (over > 0) return null;
	return {
		contents: parts.map((part, index) =>
			(allotted[index] ?? 0) < (full[index] ?? 0) ? clipPartToWidth(part, allotted[index] ?? 0) : part.content,
		),
		cramped: allotted.some((width, index) => width < Math.min(full[index] ?? 0, MIN_LOCATION_PART)),
	};
}

/** Join `contents` and record the painted extent of each part, in columns of the join. */
function assembleLocation(
	parts: readonly QuietPart[],
	contents: readonly string[],
	sep: string,
): { text: string; slots: QuietSegmentBounds[] } {
	const sepWidth = visibleWidth(sep);
	const slots: QuietSegmentBounds[] = [];
	let col = 0;
	for (const [index, part] of parts.entries()) {
		const partWidth = visibleWidth(contents[index] ?? "");
		slots.push({ id: part.id, start: col, end: col + partWidth });
		col += partWidth + sepWidth;
	}
	return { text: contents.join(sep), slots };
}
/** One segment's slot on the rendered quiet footline (0-based columns, end exclusive). */
export interface QuietSegmentBounds {
	id: string;
	start: number;
	end: number;
}

/** The three groups the footline is laid out from. */
export interface QuietGroups {
	location: QuietPart[];
	capLeft: QuietPart[];
	capRight: QuietPart[];
}

/** What a segment render needs, asked for by the gatherer once it knows which zones are live. */
export interface QuietContextRequest {
	width: number;
	options: StatusLineSegmentOptions;
	includePath: boolean;
	includeContext: boolean;
	includeGit: boolean;
	includePr: boolean;
}

export interface QuietGatherInput {
	width: number;
	effectiveSettings: EffectiveStatusLineSettings;
	/** Git segments are rendered at all. Off skips the branch, status and PR lookups. */
	gitEnabled: boolean;
	/** How far the click-to-expand trade has travelled, 0 at rest. */
	expansion: number;
	/**
	 * Build the segment context for the zones the gatherer decided are live.
	 *
	 * A callback rather than a value because the git and context lookups are
	 * expensive and the gatherer is the one that knows whether the preset asked
	 * for them: the caller cannot pre-build a context without either paying for
	 * a zone nobody renders or guessing which zones those are.
	 */
	buildContext(request: QuietContextRequest): SegmentContext;
	/** The persistent running-subagent count, always first in the right group. */
	subagentBadge: string;
	/** The animated background-job slot at its current width, or null when closed. */
	badgeSlot: string | null;
}

export interface QuietRowInput extends QuietGroups {
	width: number;
	/** The focus badge, already clamped to the row; empty when nothing is proxied. */
	badge: string;
	/**
	 * The model run readout (`0:42`, `✓ 0:21`), or empty before the model has
	 * ever started. Passed already formatted: the clock is live state the row
	 * only positions, and it degrades in two stages before any segment sheds.
	 */
	clock: string;
	expansion: number;
	expandedHalf: StatusLineSegmentId;
	locationRight?: string | null;
}

export interface QuietRow {
	/** The rendered row, or null when there is nothing to say (no empty chrome rows). */
	line: string | null;
	/** Where each surviving segment landed, for click hit-testing. */
	bounds: QuietSegmentBounds[];
}

/**
 * Merge a preset with the configured overrides into the segment lists and
 * options the row is actually laid out from.
 *
 * Shared so the launch row resolves the SAME lists the live row will: a preset
 * IS its segment list, and a card that read `statusLine.leftSegments` directly
 * would paint a segment the mounted row then removes.
 */
export function effectiveStatusLineSettings(configured: StatusLineSettings): EffectiveStatusLineSettings {
	const preset = configured.preset ?? "default";
	const presetDef = getPreset(preset);
	const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

	for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
		mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
	}

	for (const [segment, options] of Object.entries(configured.segmentOptions ?? {})) {
		const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
		mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
			...(current as Record<string, unknown>),
			...(options as Record<string, unknown>),
		};
	}

	const { left: leftSegments, right: rightSegments } = resolvePresetSegments(preset, {
		left: configured.leftSegments,
		right: configured.rightSegments,
	});

	return { ...configured, leftSegments, rightSegments, segmentOptions: mergedSegmentOptions };
}

/**
 * Gap between the location group and the run clock. Deliberately wider than the
 * standard `  ·  ` separator and dot-free, so the clock reads as its own quiet
 * zone at the end of the line rather than one more segment.
 */
const RUN_CLOCK_GAP = "      ";

/**
 * Join the location group and append the model run clock with a roomy gap.
 *
 * The clock is chrome, not a configurable segment — it rides the location line
 * whenever one renders. Dim, so it reads as a receipt rather than a state.
 */
function joinWithRunClock(location: string[], sep: string, clock: string, gap: string = RUN_CLOCK_GAP): string {
	const left = location.join(sep);
	if (!left || !clock) return left;
	return `${left}${gap}${theme.fg("dim", clock)}`;
}

/**
 * The status-line settings as configured, read from the one store.
 *
 * Shared so the launch row and the live row read the SAME keys. The live row
 * used to read them inline in its constructor, which is why the launch card
 * could not have honoured a preset even if it had tried to.
 */
export function statusLineSettingsFromConfig(): StatusLineSettings {
	return {
		preset: settings.get("statusLine.preset"),
		leftSegments: settings.get("statusLine.leftSegments"),
		rightSegments: settings.get("statusLine.rightSegments"),
		separator: settings.get("statusLine.separator"),
		showHookStatus: settings.get("statusLine.showHookStatus"),
		segmentOptions: settings.getGroup("statusLine").segmentOptions,
		sessionAccent: settings.get("statusLine.sessionAccent"),
		transparent: settings.get("statusLine.transparent"),
		compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
	};
}

/**
 * The persistent running-subagent count, which the row sheds last of
 * everything and renders at zero as readily as at three.
 */
export function subagentBadgeText(count: number): string {
	return theme.fg("statusLineSubagents", withIcon(theme.icon.agents, `${count}`));
}

/**
 * Which zones the configured segment lists ask for. The gatherer asks before it
 * builds a context, so a preset with no git segment pays for no git lookup.
 */
export function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
}

export function hasGitSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("git");
}

export function hasPrSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("pr");
}

export function hasPathSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("path");
}

export function gatherQuietSegments(input: QuietGatherInput): QuietGroups {
	const { width, effectiveSettings, gitEnabled, expansion, buildContext, subagentBadge, badgeSlot } = input;
	const leftCfg = effectiveSettings.leftSegments;
	const rightCfg = effectiveSettings.rightSegments;
	const includePath = hasPathSegment(leftCfg) || hasPathSegment(rightCfg);
	const includeContext = hasContextSegment(leftCfg) || hasContextSegment(rightCfg);
	const includeGit = gitEnabled && (hasGitSegment(leftCfg) || hasGitSegment(rightCfg));
	const includePr = gitEnabled && (hasPrSegment(leftCfg) || hasPrSegment(rightCfg));
	// The footline reads at a glance, so the model-effort gap is roomy. The
	// per-kind git counts and the token-text context gauge that the other
	// options here used to switch between are gone: nothing could reach
	// them, because this is the only place a segment is ever rendered.
	//
	// `path.maxLength` was pinned to 30 here, which quietly overrode every
	// preset's own budget (40 on `default`, 60 on `nerd`) AND any
	// `statusLine.segmentOptions.path.maxLength` the operator set — picking
	// `nerd` for its long paths changed nothing on screen. The preset wins
	// now; 30 is only the fallback for a preset that names no budget.
	//
	// EXPANDED PATH. A click on the path toggles `#pathExpanded`: the location zone
	// gives up its clamp and takes the room the model chip vacates, so a path too long
	// for the footline can be read without resizing the terminal. The shed loop below
	// still clips the location to the row, so this widens the budget rather than
	// promising the whole path.
	//
	// The clamp travels between the two budgets rather than switching between them, so
	// the path grows a cell at a time out of the room the chip is giving back. Both ends
	// of the trade are driven by ONE progress value, so the row can never be mid-way
	// through widening while the chip is already gone.
	const collapsedPathBudget = effectiveSettings.segmentOptions?.path?.maxLength ?? 30;
	// A row narrower than the clamp has nothing to widen INTO, and interpolating toward it
	// would make the click cut the path shorter than the clamp already had it.
	const expandedPathBudget = Math.max(collapsedPathBudget, width);
	const pathBudget = Math.round(collapsedPathBudget + (expandedPathBudget - collapsedPathBudget) * expansion);
	const quietOptions = {
		...effectiveSettings.segmentOptions,
		path: {
			...effectiveSettings.segmentOptions?.path,
			maxLength: pathBudget,
		},
		model: { ...effectiveSettings.segmentOptions?.model, roomy: true },
	};
	const ctx = buildContext({ width, options: quietOptions, includePath, includeContext, includeGit, includePr });
	const LOCATION_IDS: Record<string, true> = { path: true, git: true, pr: true };
	const CONTEXT_IDS: Record<string, true> = { context_pct: true, context_total: true };
	const location: QuietPart[] = [];
	const capLeft: QuietPart[] = [];
	const capRight: QuietPart[] = [];
	const push = (id: StatusLineSegmentId, out: QuietPart[]) => {
		if (id === "subagents") return;
		const rendered = renderSegment(id, ctx);
		if (!rendered.visible || !rendered.content) return;
		out.push({ id, content: rendered.content, pin: rendered.pin });
	};
	// The context gauge is the footline's one LIVE value; everything else on the
	// right is standing state. A gauge configured on the left still belongs in the
	// right group (it is a capability reading, not a location), but pushing it there
	// during this first loop put it AHEAD of every right-configured segment, so the
	// default preset read `model · gauge · session-name`: the number that changes
	// every turn sandwiched between two that do not. Nobody chose that order; it
	// fell out of which loop ran first. Held aside and appended after the right
	// group instead, so the live value is the line's last word. A gauge the user
	// configured on the RIGHT keeps the position they gave it.
	const contextFromLeft: QuietPart[] = [];
	for (const id of leftCfg) {
		if (LOCATION_IDS[id]) push(id, location);
		else if (CONTEXT_IDS[id]) push(id, contextFromLeft);
		else push(id, capLeft);
	}
	for (const id of rightCfg) {
		if (LOCATION_IDS[id]) push(id, location);
		else push(id, capRight);
	}
	capRight.push(...contextFromLeft);
	if (badgeSlot !== null) capRight.unshift({ id: "badges", content: badgeSlot });
	capRight.unshift({ id: "subagents", content: subagentBadge });
	return { location, capLeft, capRight };
}

/**
 * The same groups laid out as TWO whisper lines instead of one: location above,
 * capability split left/right below. The selector renders the row this way
 * where it has the vertical room the composer does not.
 *
 * Beside {@link composeQuietRow} rather than inside the component for the same
 * reason: the row has one owner for what it drops and in what order, and the
 * location here falls back to the SAME fitter, so the branch goes before the
 * directory on both shapes.
 */
export function composeQuietLines(input: QuietRowInput): {
	locationLine: string | null;
	capabilityLine: string | null;
} {
	const { width, location, capLeft, capRight, clock, locationRight } = input;
	const sep = segmentSeparator();
	// One cell of right margin, always — nothing kisses the terminal edge.
	const budget = Math.max(1, width - 1);
	let locationLine: string | null = null;
	if (location.length > 0) {
		const left = joinWithRunClock(
			location.map(part => part.content),
			sep,
			clock,
		);
		const right = locationRight ?? null;
		if (right && visibleWidth(left) + visibleWidth(right) + 2 <= budget) {
			locationLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
		} else if (visibleWidth(left) <= budget) {
			locationLine = left;
		} else {
			// Same fitter as the one-line row: the branch goes before the directory does.
			// The run clock is dropped with it, since it is chrome and this row is full.
			locationLine = fitLocation(location, sep, budget).text;
		}
	}
	let capabilityLine: string | null = null;
	if (capLeft.length > 0 || capRight.length > 0) {
		const left = capLeft.map(part => part.content).join(sep);
		const rightParts = capRight.map(part => part.content);
		let right = rightParts.join(sep);
		// Free space between the groups is the design; on narrow terminals the
		// right group sheds parts before the gap closes below breathing room.
		while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + 2 > budget) {
			rightParts.pop();
			right = rightParts.join(sep);
		}
		if (left && right) {
			capabilityLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
		} else {
			capabilityLine = truncateToWidth(left || right, budget);
		}
	}
	return { locationLine, capabilityLine };
}

export function composeQuietRow(input: QuietRowInput): QuietRow {
	const { width, badge, location, capLeft, capRight, clock, expansion, expandedHalf, locationRight } = input;
	// The focus badge rides the footline while the view is proxied onto an
	// agent. It was built for `getTopBorder`, but the borderless composer
	// never asks for a top border: the editor's border is hidden and this
	// quiet footline is the one persistent status surface, so an agent view
	// announced itself nowhere. Prefixed the same way `getTopBorder` does it:
	// the line is built into what the badge leaves, so no width pressure can
	// shed the one line of text that says whose session this is and that Esc
	// leaves it.
	// The badge is prefixed verbatim, so it has to be clamped to the row exactly as
	// `renderFocusBadge` clamps it: an agent id long enough to outrun the terminal wrapped the
	// footline and pushed the composer up a row on every render.
	const badgeWidth = visibleWidth(badge);
	const sep = segmentSeparator();
	// One cell of right margin, always — nothing kisses the terminal edge. Floored at ZERO, not
	// at one: a badge that already fills the row leaves no room to compete for, and clamping to
	// one cell is what let a 28-cell badge plus a segment render onto an 8-cell row.
	const budget = Math.max(0, width - 1 - badgeWidth);
	if (budget === 0) {
		return { line: badge === "" ? null : badge, bounds: [] };
	}
	const locationContents = location.map(part => part.content);
	let left = joinWithRunClock(locationContents, sep, clock);
	const rightParts = [...capLeft, ...capRight];
	if (locationRight) rightParts.push({ id: "location_right", content: locationRight });
	let right = rightParts.map(part => part.content).join(sep);
	// The run clock is comfort chrome; the capability segments (context
	// gauge, mode, badges) are operating data. On a tight width the clock
	// degrades FIRST — its roomy gap shrinks to two cells, then the clock
	// drops entirely — so it can never squeeze a segment off the line.
	let clockStage = 0;
	let locationShortened = false;
	// Painted extents of the location parts once the fitter has had them, or null while
	// the location is still whole and its parts sit where the join put them.
	let locationSlots: QuietSegmentBounds[] | null = null;
	// Whether the fitter had to cut the location below its own floors to fit it.
	let locationCramped = false;
	// Fit the location into the room the CURRENT right group leaves, for the caller to take.
	// Asked again every time the group loses a part on the zone's behalf, because the room a
	// shed frees belongs to the location: fitting once and latching a flag is what put an
	// empty zone on a row with twenty-one cells of slack. The zone was fitted to the budget
	// left by a right group that still held the session name and the context gauge -- a
	// budget of ZERO -- and when those two left a moment later nothing asked the fitter
	// again, so the row rendered the directory and the branch as nothing at all.
	const favour = expansion > 0 ? expandedHalf : undefined;
	const fitToTheRoomLeft = () =>
		fitLocation(location, sep, Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0)), favour);
	while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + (left && right ? 2 : 0) > budget) {
		if (clockStage === 0) {
			clockStage = 1;
			left = joinWithRunClock(locationContents, sep, clock, "  ");
			continue;
		}
		if (clockStage === 1) {
			clockStage = 2;
			left = locationContents.join(sep);
			continue;
		}
		// Shed the LOWEST-RANKED remaining part, walking from the end so equally
		// ranked parts still go right-to-left. Everything unlisted ranks 0 and goes
		// first; see RIGHT_PART_SHED_RANK for why the four ranked ids outrank it.
		//
		// Every unranked part goes before the location is touched at all, so nothing here
		// has to be re-fitted: the zone is still whole.
		const weakest = weakestRightPart(rightParts);
		const dropIndex = weakest.index;
		const dropRank = weakest.rank;
		if (dropRank === 0 && dropIndex >= 0) {
			rightParts.splice(dropIndex, 1);
			right = rightParts.map(part => part.content).join(sep);
			continue;
		}
		// Only ranked parts are left. Shorten the location before touching any of
		// them: a clipped path still says where you are, and these do not degrade.
		if (!locationShortened) {
			locationShortened = true;
			const fitted = fitToTheRoomLeft();
			left = fitted.text;
			locationSlots = fitted.slots;
			locationCramped = fitted.cramped;
			continue;
		}
		// The ranked parts still do not fit, so the ranking has to resolve. Shedding the
		// weakest is the whole point of having one: the alternative is what shipped before
		// it existed, where the return below truncated the joined group and a budget of one
		// cell rendered a bare `…` — every ranked part destroyed at once, including the
		// persistent subagent count that outranks all of them.
		//
		// The zone is not re-fitted inside this branch: a shed that does not end the overflow
		// is followed by another, so there is nothing settled to fit against yet. The shed
		// that DOES end it is accounted for below, once the group has stopped moving.
		if (rightParts.length > 1 && dropIndex >= 0) {
			rightParts.splice(dropIndex, 1);
			right = rightParts.map(part => part.content).join(sep);
			continue;
		}
		break;
	}
	// The group has stopped shedding, so the room it leaves is final -- and the shed that
	// ended the loop above freed cells nobody has handed over yet. The zone was fitted
	// against the group as it stood BEFORE that shed, which on a narrow row is two parts
	// wider, so it kept a width the row had already outgrown: the same latch as the reported
	// defect, one shed later. At 40 columns it left the zone blank with the model chip and a
	// mode rung standing in the middle of the row.
	if (locationShortened) {
		const settled = fitToTheRoomLeft();
		left = settled.text;
		locationSlots = settled.slots;
		locationCramped = settled.cramped;
	}
	// A location squeezed under its floors is a zone that no longer reads: `…izer  ·  …g-path`
	// says neither where the session is nor what it is on. At that point the budget is what
	// has to move, so the row pays the zone out of what it can re-read on the next frame --
	// the context gauge, the draft token estimate, owner-pinned right content (see
	// FLOOR_SPENDABLE) -- and asks the fitter again after each one. It never pays with the
	// model chip, which is what this row exists to retain, never with a mode rung, which says
	// what the next keystroke does, and never with the running-subagent count, which the row
	// sheds last of everything.
	while (locationCramped && locationShortened && rightParts.length > 0) {
		const index = weakestSpendablePart(rightParts);
		if (index < 0) break;
		rightParts.splice(index, 1);
		right = rightParts.map(part => part.content).join(sep);
		const fitted = fitToTheRoomLeft();
		left = fitted.text;
		locationSlots = fitted.slots;
		locationCramped = fitted.cramped;
	}
	// THE CLICK'S TRADE, settled last.
	//
	// A click says "show me this half". So the row shows it WHOLE, and it may spend the rest
	// of the bar to do it: the model chip first, then whatever is weakest, until the clicked
	// half is whole or the bar has nothing left to give. Only a half longer than the entire
	// row is still clipped. The second click returns every cell and every part.
	//
	// Settled AFTER the ladders above, and that ordering is the trade. The ladders decide
	// what the row holds while the right group is still standing at full width, so they
	// reach the same decisions the collapsed row reached, and the cells freed here have
	// nowhere to go but the location. Retracting first is what shipped, and at 78 columns it
	// moved the zone by ONE cell: the collapsed row had shed the context gauge under
	// pressure, the narrower chip took that pressure off, and the gauge came back and ate
	// all twenty cells. On screen the click flashed a gauge in and a chip out and left the
	// directory exactly where it was. Nothing the collapsed row gave up may return because
	// the click freed room -- the room is the location's.
	//
	// The spend TRAVELS with the progress value instead of switching on it. Whole parts
	// leaving the row the instant a click lands is the other way this reads as a flash: the
	// cells have to slide out of the group and into the zone across the same frames, so each
	// part in turn narrows and only then goes.
	if (expansion > 0 && rightParts.length > 0) {
		// What the row is short of showing the CLICKED half whole, with the other half at the
		// width a name still reads at. Targeting both halves whole is the greedier answer and
		// the wrong one: it spent the mode rungs to lengthen a branch nobody pointed at. The
		// fitter hands any cells left over back to the other half afterwards, so this is a
		// floor on what it keeps, not a cap.
		const sepWidth = visibleWidth(sep);
		const wanted =
			location.reduce(
				(sum, part) =>
					sum +
					(part.id === favour
						? visibleWidth(part.content)
						: Math.min(visibleWidth(part.content), MIN_LOCATION_PART)),
				0,
			) +
			sepWidth * Math.max(0, location.length - 1);
		const held = budget - visibleWidth(right) - (right ? 2 : 0);
		// The chip goes first: it is the biggest single readout and the one the reader is
		// trading away knowingly. After that the row gives up its weakest, which is the same
		// order it uses under width pressure.
		const order: number[] = [];
		const chip = rightParts.findIndex(part => part.id === "model");
		if (chip >= 0) order.push(chip);
		const remaining = rightParts.map((_, index) => index).filter(index => index !== chip);
		remaining.sort((a, b) => {
			const rankA = RIGHT_PART_SHED_RANK[rightParts[a]?.id ?? ""] ?? 0;
			const rankB = RIGHT_PART_SHED_RANK[rightParts[b]?.id ?? ""] ?? 0;
			return rankA === rankB ? b - a : rankA - rankB;
		});
		order.push(...remaining);
		const onOffer = order.reduce((sum, index) => sum + visibleWidth(rightParts[index]?.content ?? "") + sepWidth, 0);
		// NOT scaled by the progress a second time. `wanted` is measured from the location's
		// CURRENT text, and that text is already on the curve -- the path's own clamp travels
		// from the preset budget out to the row. Scaling here as well put two interpolations
		// of one progress value in a race, and the text won it: the clamp lengthened the path
		// four cells before any room had been freed for it, so the ladders clipped the zone
		// and its right edge stepped BACKWARD at the start of every expansion. The room now
		// covers exactly what the text is asking for, frame by frame, which is one motion.
		const spend = Math.min(Math.max(0, wanted - held), onOffer);
		if (spend > 0) {
			let owed = spend;
			const spent: number[] = [];
			for (const index of order) {
				if (owed <= 0) break;
				const part = rightParts[index];
				if (part === undefined) continue;
				const width = visibleWidth(part.content);
				// A part is narrowed cell by cell while the row is travelling, because that is
				// the motion: the readout is visibly standing down. Where it lands is a
				// different question -- `clau…` is not a model name, and a row that RESTS on a
				// fragment has not stood the readout down, it has broken it. So at rest a part
				// that cannot keep the width a name reads at goes instead, and every cell it
				// was holding goes to the location.
				const floor = expansion >= 1 ? MIN_LOCATION_PART : MIN_READABLE_PART;
				if (owed >= width - floor) {
					spent.push(index);
					owed -= width + sepWidth;
					continue;
				}
				rightParts[index] = { ...part, content: truncateToWidth(part.content, width - owed) };
				owed = 0;
			}
			// Descending, so an earlier removal cannot shift a later index.
			for (const index of spent.sort((a, b) => b - a)) rightParts.splice(index, 1);
			right = rightParts.map(part => part.content).join(sep);
			const widened = fitToTheRoomLeft();
			left = widened.text;
			locationSlots = widened.slots;
			locationCramped = widened.cramped;
		}
	}
	if (!left && !right) {
		return { line: badge === "" ? null : badge, bounds: [] };
	}
	// Record where each surviving segment landed, in 0-based columns of the
	// returned line, so a footer click can be resolved back to a segment id
	// (see quietSegmentAt). The math mirrors the assembly exactly: location
	// parts start at column 0 and are sep-joined; the right group is
	// right-aligned at the budget when a left group exists, else it renders
	// from column 0 and truncates.
	const sepWidth = visibleWidth(sep);
	const bounds: QuietSegmentBounds[] = [];
	if (left) {
		// Once the fitter has run it is the authority on where the parts landed: it is
		// what dropped a part and what clipped the head, so it knows the painted columns
		// and this loop would only be guessing at them. Otherwise the location is whole
		// and each part sits where the join put it.
		if (locationSlots !== null) {
			bounds.push(...locationSlots);
		} else {
			let col = 0;
			const leftWidth = visibleWidth(left);
			for (const part of location) {
				const partWidth = visibleWidth(part.content);
				if (col >= leftWidth) break;
				bounds.push({ id: part.id, start: col, end: Math.min(col + partWidth, leftWidth) });
				col += partWidth + sepWidth;
			}
		}
	}
	// The right group is anchored to the right edge whether or not a location shares the
	// row with it. Anchoring it only when a location survived is what left a row of state
	// hanging off the LEFT margin at the widths where the zone could not fit: the model
	// chip, the rungs and the counters all jumped a screen-width left, and the eye that
	// had learnt where to find them on every other row had to hunt for them on this one.
	const rightStart = right ? Math.max(0, budget - visibleWidth(right)) : 0;
	if (right) {
		let col = rightStart;
		for (const part of rightParts) {
			const partWidth = visibleWidth(part.content);
			bounds.push({ id: part.id, start: col, end: col + partWidth });
			col += partWidth + sepWidth;
		}
	}
	// Single-group lines truncate to the budget: clamp bounds the same way.
	// The badge shifts every segment right by its width; the recorded bounds
	// answer in columns of the RETURNED line (quietSegmentAt hit-testing), so
	// they shift with it.
	const painted = bounds
		.filter(entry => entry.start < budget)
		.map(entry => ({
			...entry,
			start: entry.start + badgeWidth,
			end: Math.min(entry.end, budget) + badgeWidth,
		}));
	if (left && right) {
		return {
			line: badge + left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right,
			bounds: painted,
		};
	}
	// A location alone on the row is what a click on a name longer than the whole bar comes
	// to: the reader asked for that name, and the row spent every readout it had to show as
	// much of it as fits. Before the click could spend the last part this was unreachable --
	// the subagent badge is appended to `capRight` unconditionally, so `right` was never
	// empty -- and the lone-group return below dropped the location on the floor, painting
	// an empty row on the one click that most needed to answer.
	if (left) return { line: badge + truncateToWidth(left, budget), bounds: painted };
	// A lone right group has no head worth keeping, so it loses its tail -- and it keeps the
	// right edge, so the state it carries sits where the eye already looks for it.
	return { line: badge + padding(rightStart) + truncateToWidth(right, budget), bounds: painted };
}
