import { sliceWithWidth, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";

export type QuietPart = { id: string; content: string; pin?: number };

export interface QuietSegmentBounds {
	id: string;
	start: number;
	end: number;
}

const ELLIPSIS = "…";

const SGR_PREFIX = /^(?:\x1b\[[0-9;:]*m)+/u;

const CLIP_SNAP = 4;

export const CLIP_BOUNDARIES: Record<string, "keep" | "drop"> = {
	"/": "keep",
	"\\": "keep",
	"-": "drop",
	_: "drop",
	".": "drop",
	"@": "drop",
	":": "drop",
};

export const MIN_LOCATION_PART = 12;

export const MIN_READABLE_PART = 2;

const FILL_STAGES = ["preferred", "readable"] as const;

function clipStartToWidth(text: string, maxWidth: number, keepFront = 0): string {
	const total = visibleWidth(text);
	if (total <= maxWidth) return text;
	if (maxWidth <= 0) return "";
	const front = Math.max(0, keepFront);
	if (maxWidth <= front) return sliceWithWidth(text, 0, Math.min(front, maxWidth), true).text;
	const room = maxWidth - front - 1;
	const cut = snapForward(text, total - room, room, maxWidth);
	const head = front === 0 ? "" : sliceWithWidth(text, 0, front, true).text;
	const tail = sliceWithWidth(text, cut, total - cut, true).text;
	if (stripAnsi(tail).startsWith(ELLIPSIS)) return head + tail;
	const state = tail === "" ? sliceWithWidth(text, Math.max(0, total - 1), 1, true).text : tail;
	return `${head}${SGR_PREFIX.exec(state)?.[0] ?? ""}${ELLIPSIS}${tail}`;
}

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

function clipPartToWidth(part: QuietPart, width: number): string {
	const pin = part.pin ?? 0;
	return clipStartToWidth(part.content, width, width <= pin + 1 ? 0 : pin);
}

function readableFloor(part: QuietPart): number {
	return (part.pin ?? 0) + MIN_READABLE_PART;
}

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
	const width = visibleWidth(head.content);
	if (budget < readableFloor(head)) return { text: "", slots: [], cramped: true };
	const content = width <= budget ? head.content : clipPartToWidth(head, Math.max(0, budget));
	const assembled = assembleLocation([head], [content], sep);
	return { ...assembled, cramped: width > budget || parts.length > 1 };
}

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
