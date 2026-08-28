import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { sliceWithWidth, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import type { AgentSession } from "../../../session/agent-session";
import type { ActiveRepoContext } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import type { StatusLineSegmentId } from "./types";

export const SESSION_CLOCK_GAP = "      ";

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
export const RIGHT_PART_SHED_RANK: Record<string, number> = {
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
export function weakestRightPart(parts: readonly QuietPart[]): { index: number; rank: number } {
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
export function weakestSpendablePart(parts: readonly QuietPart[]): number {
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
export const ELLIPSIS = "…";

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
export function clipStartToWidth(text: string, maxWidth: number, keepFront = 0): string {
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
export const SGR_PREFIX = /^(?:\x1b\[[0-9;:]*m)+/u;

/**
 * Cells a front cut may walk forward to reach a name boundary. Four, because the boundary this
 * exists for is one or two cells away -- an orphaned separator, or the tail of a short word --
 * and a wider allowance starts spending the name to buy the tidiness. Nothing is walked when
 * no boundary is that close.
 */
export const CLIP_SNAP = 4;

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
export function snapForward(text: string, cut: number, room: number, maxWidth: number): number {
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
export function clipPartToWidth(part: QuietPart, width: number): string {
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
export const MIN_READABLE_PART = 2;

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
export function readableFloor(part: QuietPart): number {
	return (part.pin ?? 0) + MIN_READABLE_PART;
}

/**
 * Hand out the cells: the widest clippable part gives one up at a time, first down to
 * MIN_LOCATION_PART and then, only if the row still overflows, down to MIN_READABLE_PART. Null
 * when even that does not fit, which is the caller's signal to try one part fewer.
 */
export function fillLocation(
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
export function assembleLocation(
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

// ═══════════════════════════════════════════════════════════════════════════
// Context-usage memo
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Allocation-free structural size of a tool call's arguments: the sum of every
 * nested string length plus a fixed weight per primitive and per key. Tool-call
 * arguments come from JSON (acyclic), so a plain recursive walk is safe. This
 * replaces a per-redraw `JSON.stringify` of the full arguments object — a
 * streaming Write with a 100KB file body was re-serialized on every render
 * tick just to detect in-place growth of the tail.
 */
export function structuralTextSize(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean" || value === null || value === undefined) return 1;
	if (Array.isArray(value)) {
		let sum = 2;
		for (const item of value) sum += 1 + structuralTextSize(item);
		return sum;
	}
	if (typeof value === "object") {
		let sum = 2;
		for (const key in value as Record<string, unknown>) {
			sum += key.length + 1 + structuralTextSize((value as Record<string, unknown>)[key]);
		}
		return sum;
	}
	return 1;
}

/**
 * Cheap structural fingerprint of a message's tokenizable content. O(blocks) —
 * only reads string `.length` and primitives, never copies or serializes.
 * Detects in-place growth of the streaming tail (and other in-place mutations)
 * so the cached `getContextUsage()` result is recomputed when — and only when —
 * the numbers it depends on change. Exported for its dedicated test suite.
 */
export function messageFingerprint(msg: AgentMessage): string {
	const role = (msg as { role?: string }).role ?? "";
	const ts = (msg as { timestamp?: number }).timestamp ?? 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (role === "bashExecution") {
		const b = msg as { command?: unknown; output?: unknown };
		if (typeof b.command === "string") textLen += b.command.length;
		if (typeof b.output === "string") textLen += b.output.length;
	} else if (role === "user") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") textLen += block.text.length;
			}
		}
	} else if (role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const usageExt = assistantMsg.usage as unknown as { promptTokensDetails?: unknown };
		const usageTotal = assistantMsg.usage?.totalTokens ?? 0;
		const promptBuckets = usageExt?.promptTokensDetails ? 1 : 0;
		const stopReason = assistantMsg.stopReason ?? "";

		let signatureLen = 0;
		let redactedLen = 0;
		const msgExt = assistantMsg as unknown as {
			thinkingSignature?: string;
			textSignature?: string;
			thoughtSignature?: string;
			redactedThinking?: { data?: string };
		};
		const thinkingSignature = msgExt.thinkingSignature;
		if (typeof thinkingSignature === "string") {
			signatureLen += thinkingSignature.length;
		}
		const textSignature = msgExt.textSignature;
		if (typeof textSignature === "string") {
			signatureLen += textSignature.length;
		}
		const thoughtSignature = msgExt.thoughtSignature;
		if (typeof thoughtSignature === "string") {
			signatureLen += thoughtSignature.length;
		}
		const redactedData = msgExt.redactedThinking?.data;
		if (typeof redactedData === "string") {
			redactedLen += redactedData.length;
		}

		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as {
					type?: string;
					text?: string;
					thinking?: string;
					thinkingSignature?: string;
					signature?: string;
					textSignature?: string;
					thoughtSignature?: string;
					data?: string;
					name?: string;
					arguments?: unknown;
				};
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "thinking") {
					if (typeof b.thinking === "string") textLen += b.thinking.length;
					if (typeof b.thinkingSignature === "string") signatureLen += b.thinkingSignature.length;
					if (typeof b.signature === "string") signatureLen += b.signature.length;
					if (typeof b.textSignature === "string") signatureLen += b.textSignature.length;
					if (typeof b.thoughtSignature === "string") signatureLen += b.thoughtSignature.length;
				} else if (b.type === "redactedThinking" && typeof b.data === "string") {
					redactedLen += b.data.length;
				} else if (b.type === "toolCall") {
					if (typeof b.name === "string") textLen += b.name.length;
					if (b.arguments !== undefined) {
						textLen += structuralTextSize(b.arguments);
					}
				}
			}
		}
		return `${role}:${ts}:${textLen}:${blocks}:${images}:${signatureLen}:${redactedLen}:${usageTotal}:${promptBuckets}:${stopReason}`;
	} else if (role === "toolResult" || role === "hookMessage") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "image") images++;
			}
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		const s = (msg as { summary?: unknown }).summary;
		if (typeof s === "string") textLen += s.length;
	}
	return `${role}:${ts}:${textLen}:${blocks}:${images}`;
}

export interface ContextUsageMemo {
	messagesRef: readonly AgentMessage[];
	length: number;
	lastFingerprint: string | undefined;
	modelContextWindow: number;
	contextUsageRevision: number;
	usedTokens: number | null;
	contextWindow: number;
	systemPromptRef: readonly string[] | undefined;
	toolsRef: readonly any[] | undefined;
	skillsRef: readonly any[] | undefined;
}

export interface ActiveRepoCache {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	/** Project + worktree dir name when `projectDir` is a linked worktree, else null. */
	worktree: WorktreeContext | null;
}

export interface WorktreeContext {
	/** Primary-checkout (project) name shown by the path segment. */
	projectName: string;
	/** Worktree directory name — suppressed from the path when it equals the branch. */
	worktreeName: string;
}

/**
 * Project + worktree-dir names when `cwd` is a linked git worktree, else null.
 * The project name comes from the shared primary checkout; bare-repo worktrees
 * resolve to the shared `foo.git` dir, so a trailing `.git` is stripped.
 */
export function resolveWorktreeContext(cwd: string): WorktreeContext | null {
	const worktree = git.repo.linkedWorktreeSync(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

/**
 * Per-{@link AgentSession} active-processing meter for the `time_spent`
 * segment. `activeMs` is the union of every completed `agent_start`→
 * `agent_end` window; `activeStartedAt` is the start timestamp of the
 * currently-running window, or `null` when idle.
 *
 * `sessionFile` snapshots the loaded session-file path at meter-creation
 * time. `AgentSession.switchSession` (/resume, /move, ACP fork, RPC
 * `switch_session`, extension `switchSession`) mutates the loaded file
 * under the same {@link AgentSession} ref, so the WeakMap key alone
 * cannot tell two conversations apart. `#meter()` compares this snapshot
 * against the live `session.sessionFile`, and a real-to-real change
 * starts the meter fresh instead of crediting the new conversation with
 * the previous one's accumulated active time. The undefined → real
 * first-save transition does not reset, since the session identity has
 * not changed.
 */
export interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
	/** Duration of the most recently COMPLETED run window — what the location
	 * line's stopped clock (`✓ 0:21`) shows once the agent yields. */
	lastRunMs: number;
	sessionFile: string | undefined;
}

export const EMPTY_MESSAGES: readonly AgentMessage[] = [];
export const STATUS_USAGE_START_DELAY_MS = 0;
export const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;

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

export function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

/** How the host paints the footline's motion. */
