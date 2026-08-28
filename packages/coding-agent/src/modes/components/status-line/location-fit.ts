import { sliceWithWidth, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

/** One quiet-footline part: the segment id it came from plus its rendered content. Ids are StatusLineSegmentId values, or the synthetic "badges" */
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

/** Cells a front cut may walk forward to reach a name boundary. Four, because the boundary this exists for is one or two cells away -- an orphaned separator, or the tail of a short word -- */
const CLIP_SNAP = 4;

/** Boundaries a clipped name may open on, and whether the boundary itself is kept. BOTH separators, because only one of them is normalized away. `shortenPath` rewrites `\` to */
export const CLIP_BOUNDARIES: Record<string, "keep" | "drop"> = {
	"/": "keep",
	"\\": "keep",
	"-": "drop",
	_: "drop",
	".": "drop",
	"@": "drop",
	":": "drop",
};

/** The fewest cells a clipped location part is kept above while any WIDER part can still give the room instead. Below about a dozen, a clipped tail is a fragment of one name and reads */
export const MIN_LOCATION_PART = 12;

/** The fewest cells a part is worth keeping at all: the mark, plus one character of the name behind it. At one cell a part is nothing but its own clip mark, and `… · …` names neither a */
export const MIN_READABLE_PART = 2;

const FILL_STAGES = ["preferred", "readable"] as const;

/** Clip `text` to `maxWidth` by dropping cells off the FRONT. The location zone reads from its right end: the directory the session is in, the branch */
function clipStartToWidth(text: string, maxWidth: number, keepFront = 0): string {
	const total = visibleWidth(text);
	if (total <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	// One cell pays for the mark, unless the cut lands ON a mark already in the text: the preset's `clampPathLength` ran at its own budget before the row was consulted, so the
	const front = Math.max(0, keepFront);
	if (maxWidth <= front) return sliceWithWidth(text, 0, Math.min(front, maxWidth), true).text;
	const room = maxWidth - front - 1;
	const cut = snapForward(text, total - room, room, maxWidth);
	const head = front === 0 ? "" : sliceWithWidth(text, 0, front, true).text;
	const tail = sliceWithWidth(text, cut, total - cut, true).text;
	if (stripAnsi(tail).startsWith(ELLIPSIS)) return head + tail;
	// The colour the mark wears: the escapes the slice replays in front of the tail, emitted once more before the mark so the mark is inside that run rather than in front of it. A
	const state = tail === "" ? sliceWithWidth(text, Math.max(0, total - 1), 1, true).text : tail;
	return `${head}${SGR_PREFIX.exec(state)?.[0] ?? ""}${ELLIPSIS}${tail}`;
}

/** The column at or after `cut` a clip should open on: the nearest boundary within CLIP_SNAP cells, or `cut` itself. */
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

/** Clip one location part to `width`, stepping over the cells it pinned. The part's pin is its icon (see `QuietPart.pin`), and the icon is the first thing a front */
function clipPartToWidth(part: QuietPart, width: number): string {
	const pin = part.pin ?? 0;
	return clipStartToWidth(part.content, width, width <= pin + 1 ? 0 : pin);
}

/** The fewest cells a part is worth painting in: its pinned cells, plus a mark, plus one cell of the name the mark is standing in for. */
function readableFloor(part: QuietPart): number {
	return (part.pin ?? 0) + MIN_READABLE_PART;
}

/** Fit the location parts into `budget` cells, keeping the RIGHT end of every one of them. NOTHING IS DROPPED while the row can hold the parts at all. Every part is clipped from its */
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
	// The head alone, clipped to whatever there is. Under its readable minimum the zone says nothing worth a cell: a directory whose icon has been eaten to fit the mark reads `…er`,
	const width = visibleWidth(head.content);
	if (budget < readableFloor(head)) return { text: "", slots: [], cramped: true };
	const content = width <= budget ? head.content : clipPartToWidth(head, Math.max(0, budget));
	const assembled = assembleLocation([head], [content], sep);
	return { ...assembled, cramped: width > budget || parts.length > 1 };
}

/** Hand out the cells: the widest clippable part gives one up at a time, first down to MIN_LOCATION_PART and then, only if the row still overflows, down to MIN_READABLE_PART. Null */
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
	// Two passes: every clippable part down to the width a name still reads at, and only then down to the fewest cells the part is worth painting at all -- which counts its pinned
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
