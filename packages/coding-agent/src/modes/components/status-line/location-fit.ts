import { sliceWithWidth, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

/**
 * One quiet-footline part: the segment id it came from plus its rendered
 * content. Ids are StatusLineSegmentId values, or the synthetic "badges"
 * and "location_right" ids the footline assembler invents for chrome that
 * has no segment behind it.
 *
 * `pin` is the count of cells at the FRONT of the content that a front cut
 * steps over rather than eating — the segment's icon, so a clipped path
 * keeps its glyph and reads `▫ …ingest-pipeline/normalizer` instead of
 * losing the icon to the mark.
 */
export type QuietPart = { id: string; content: string; pin?: number };

/** One segment's slot on the rendered quiet footline (0-based columns, end exclusive). */
export interface QuietSegmentBounds {
	id: string;
	start: number;
	end: number;
}

/** The one clip mark on the footline, wherever a clipper puts it. */
const ELLIPSIS = "…";

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

const FILL_STAGES = ["preferred", "readable"] as const;

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
	const len = parts.length;
	const full = new Array<number>(len);
	const allotted = new Array<number>(len);
	let sum = 0;
	for (let i = 0; i < len; i++) {
		const w = visibleWidth(parts[i]!.content);
		full[i] = w;
		allotted[i] = w;
		sum += w;
	}
	let over = sum + sepWidth * (len - 1) - budget;
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
	for (const stage of FILL_STAGES) {
		while (over > 0) {
			let widest = -1;
			let widestFavoured = -1;
			for (let index = 0; index < len; index++) {
				const part = parts[index]!;
				if ((full[index] ?? 0) <= MIN_LOCATION_PART) continue;
				if ((allotted[index] ?? 0) <= (stage === "preferred" ? MIN_LOCATION_PART : readableFloor(part))) continue;
				if (favour !== undefined && part.id === favour) {
					widestFavoured = index;
					continue;
				}
				// Ties go to the LATER part: the directory is the head a reader places the row
				// by, so when two parts are equally wide the branch gives up the cell.
				if (widest < 0 || (allotted[index] ?? 0) >= (allotted[widest] ?? 0)) widest = index;
			}
			if (widest < 0) widest = widestFavoured;
			if (widest < 0) break;
			allotted[widest] = (allotted[widest] ?? 0) - 1;
			over--;
		}
	}
	if (over > 0) return null;
	const contents = new Array<string>(len);
	let cramped = false;
	for (let i = 0; i < len; i++) {
		const a = allotted[i] ?? 0;
		const f = full[i] ?? 0;
		contents[i] = a < f ? clipPartToWidth(parts[i]!, a) : parts[i]!.content;
		if (a < Math.min(f, MIN_LOCATION_PART)) cramped = true;
	}
	return { contents, cramped };
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
	for (let index = 0; index < parts.length; index++) {
		const partWidth = visibleWidth(contents[index] ?? "");
		slots.push({ id: parts[index]!.id, start: col, end: col + partWidth });
		col += partWidth + sepWidth;
	}
	return { text: contents.join(sep), slots };
}
