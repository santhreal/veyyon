/**
 * Where every window of the room sits on one frame.
 *
 * The room view is one continuous model driven by three numbers:
 *
 * - `scroll`: the member index at the centre of the side-by-side row. Fractional
 *   while the row glides between two members.
 * - `zoom`: 1 is the centre member filling the terminal with no frame, which is
 *   exactly the screen a conversation draws; 0 is the overview.
 * - `mix`: 0 is side by side, 1 is all windows.
 *
 * Opening the room, closing it, gliding along the row, flipping layouts and the
 * quick switch are all those three numbers moving. Nothing here knows about
 * time, input or content: it maps the numbers to rectangles, ink strength and
 * draw order, so every frame of every transition is a pure function a test can
 * pin cell by cell.
 *
 * Depth is carried three ways, because a terminal cannot scale text: size (a
 * window farther from the centre is narrower and shorter, and its text rewraps),
 * vertical inset (shorter windows are centred, so the row reads as receding into
 * the screen rather than shrinking toward the top), and ink strength (farther
 * windows fade toward the terminal ground). Draw order follows depth, far first.
 */

import { clamp, clamp01 } from "@veyyon/utils/math";

/** A window's rectangle in cells. May extend past the screen; the compositor clips. */
export interface RoomRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** One window on one frame. */
export interface RoomPlacement {
	/** Slot index: a member's position in the room, or the new-conversation slot after the last member. */
	readonly slot: number;
	readonly rect: RoomRect;
	/** Ink strength in [0, 1]: 1 is full colour, 0 is not drawn. */
	readonly strength: number;
	/** Draw-order key: larger is farther and is drawn first. */
	readonly depth: number;
	/** False only while the window is (nearly) the whole terminal, which is when it draws no frame. */
	readonly framed: boolean;
}

/** Terminal size the room is laid out for. */
export interface RoomViewport {
	readonly width: number;
	readonly height: number;
}

/** Rows the chrome takes: the title row and one row of air above the windows. */
export const ROOM_CHROME_TOP_ROWS = 2;
/** Rows the chrome takes below the windows: air, the pager row, air, the key hints. */
export const ROOM_CHROME_BOTTOM_ROWS = 4;

/** Gap between two windows, in cells (the spacing scale's "between stacked rows"). */
const WINDOW_GAP = 2;
/** The narrowest a centred window gets; below it the row is one window and nothing beside it. */
const MIN_FOCUS_WIDTH = 24;
/** The widest a centred window gets. Past it the extra columns go to the neighbours. */
const MAX_FOCUS_WIDTH = 116;
/** Share of the terminal width the centred window takes before the clamps. */
const FOCUS_WIDTH_SHARE = 0.56;
/** Share of the terminal width a first neighbour takes before the clamps. */
const NEAR_WIDTH_SHARE = 0.15;
const MIN_NEAR_WIDTH = 10;
const MAX_NEAR_WIDTH = 30;
/** A second neighbour is a sliver: its frame and a three-column minimap. */
const FAR_WIDTH = 5;
/** Heights relative to the window area, per step away from the centre. */
const NEAR_HEIGHT_SHARE = 0.8;
const FAR_HEIGHT_SHARE = 0.62;
/** Ink strength per step away from the centre. */
const STRENGTH_BY_STEP = [1, 0.62, 0.34, 0] as const;
/** Ink strength of an unselected window in the all-windows grid. */
const GRID_REST_STRENGTH = 0.8;
/** How much an all-windows window shrinks around its centre as the chosen one zooms to fill the screen. */
const GRID_RECEDE_SCALE = 0.9;

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function lerpRect(a: RoomRect, b: RoomRect, t: number): RoomRect {
	if (t <= 0) return a;
	if (t >= 1) return b;
	return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) };
}

/** Snap a fractional rectangle to cells without letting the far edge drift independently of the near one. */
function snapRect(r: RoomRect): RoomRect {
	const x = Math.round(r.x);
	const y = Math.round(r.y);
	const right = Math.round(r.x + r.w);
	const bottom = Math.round(r.y + r.h);
	return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

/** Rows the windows may occupy between the chrome bands. */
export function roomCardArea(viewport: RoomViewport): { top: number; height: number } {
	const height = Math.max(3, viewport.height - ROOM_CHROME_TOP_ROWS - ROOM_CHROME_BOTTOM_ROWS);
	return { top: ROOM_CHROME_TOP_ROWS, height };
}

interface CarouselStep {
	/** Distance of the window centre from the screen centre, in cells. */
	readonly offset: number;
	readonly width: number;
	readonly height: number;
	readonly strength: number;
}

/**
 * The window size, offset and strength at whole steps 0..3 from the centre. Step
 * 3 is past the last visible sliver: its window sits off the edge at no strength,
 * which is where a member enters from while the row glides.
 */
function carouselSteps(viewport: RoomViewport): readonly CarouselStep[] {
	const area = roomCardArea(viewport);
	const width = viewport.width;
	const focusWidth = clamp(
		Math.round(width * FOCUS_WIDTH_SHARE),
		Math.min(MIN_FOCUS_WIDTH, width),
		Math.max(Math.min(MIN_FOCUS_WIDTH, width), Math.min(MAX_FOCUS_WIDTH, width - 2)),
	);
	const nearWidth = clamp(Math.round(width * NEAR_WIDTH_SHARE), MIN_NEAR_WIDTH, MAX_NEAR_WIDTH);
	const near = focusWidth / 2 + WINDOW_GAP + nearWidth / 2;
	const far = near + nearWidth / 2 + WINDOW_GAP + FAR_WIDTH / 2;
	const beyond = far + FAR_WIDTH + WINDOW_GAP;
	return [
		{ offset: 0, width: focusWidth, height: area.height, strength: STRENGTH_BY_STEP[0] },
		{
			offset: near,
			width: nearWidth,
			height: Math.round(area.height * NEAR_HEIGHT_SHARE),
			strength: STRENGTH_BY_STEP[1],
		},
		{
			offset: far,
			width: FAR_WIDTH,
			height: Math.round(area.height * FAR_HEIGHT_SHARE),
			strength: STRENGTH_BY_STEP[2],
		},
		{
			offset: beyond,
			width: FAR_WIDTH,
			height: Math.round(area.height * FAR_HEIGHT_SHARE),
			strength: STRENGTH_BY_STEP[3],
		},
	];
}

/** Interpolate the step table at a fractional distance; past step 3 the offset keeps growing. */
function carouselAt(steps: readonly CarouselStep[], distance: number): CarouselStep {
	const last = steps.length - 1;
	if (distance >= last) {
		const tail = steps[last]!;
		const pitch = tail.width + WINDOW_GAP;
		return { ...tail, offset: tail.offset + (distance - last) * pitch };
	}
	const lower = Math.floor(distance);
	const t = distance - lower;
	const a = steps[lower]!;
	const b = steps[lower + 1]!;
	return {
		offset: lerp(a.offset, b.offset, t),
		width: lerp(a.width, b.width, t),
		height: lerp(a.height, b.height, t),
		strength: lerp(a.strength, b.strength, t),
	};
}

/** Side-by-side overview rectangle, strength and depth of `slot` with `scroll` at the centre. */
function carouselOverview(
	viewport: RoomViewport,
	steps: readonly CarouselStep[],
	slot: number,
	scroll: number,
): { rect: RoomRect; strength: number; depth: number } {
	const area = roomCardArea(viewport);
	const signed = slot - scroll;
	const distance = Math.abs(signed);
	const step = carouselAt(steps, distance);
	const centre = viewport.width / 2 + Math.sign(signed) * step.offset;
	return {
		rect: {
			x: centre - step.width / 2,
			y: area.top + (area.height - step.height) / 2,
			w: step.width,
			h: step.height,
		},
		strength: step.strength,
		depth: distance,
	};
}

/**
 * The full-screen arrangement a zoom of 1 lands on: every window the size of the
 * terminal, laid edge to edge with one gap between, the one at `scroll` covering
 * the screen. A fractional `scroll` at zoom 1 is the quick switch's slide.
 */
function fullScreen(
	viewport: RoomViewport,
	slot: number,
	scroll: number,
): { rect: RoomRect; strength: number; depth: number } {
	const signed = slot - scroll;
	return {
		rect: { x: signed * (viewport.width + WINDOW_GAP), y: 0, w: viewport.width, h: viewport.height },
		strength: clamp01(1 - Math.abs(signed)),
		depth: Math.abs(signed),
	};
}

/** Columns and rows of the all-windows grid for `count` windows. */
export function roomGridShape(viewport: RoomViewport, count: number): { columns: number; rows: number } {
	if (count <= 0) return { columns: 1, rows: 1 };
	const area = roomCardArea(viewport);
	// A terminal cell is about twice as tall as it is wide, so a window that
	// reads as a 16:10 rectangle is about 3.2 cells across per cell down. Pick
	// the column count whose windows land nearest that shape without going
	// narrower than a readable line or shorter than a frame and three rows.
	const target = 3.2;
	let best = { columns: 1, rows: count, score: Number.POSITIVE_INFINITY };
	for (let columns = 1; columns <= count; columns++) {
		const rows = Math.ceil(count / columns);
		const w = (viewport.width - 2 * WINDOW_GAP - (columns - 1) * WINDOW_GAP) / columns;
		const h = (area.height - (rows - 1)) / rows;
		if (w < 14 || h < 5) continue;
		const score = Math.abs(Math.log(w / h / target));
		if (score < best.score) best = { columns, rows, score };
	}
	if (best.score === Number.POSITIVE_INFINITY) {
		// Nothing fits the minimums: one column, as many rows as fit.
		return { columns: 1, rows: count };
	}
	return { columns: best.columns, rows: best.rows };
}

/** All-windows rectangle of `slot`. The last row is centred when it is short. */
function gridRect(viewport: RoomViewport, slot: number, count: number): RoomRect {
	const area = roomCardArea(viewport);
	const { columns, rows } = roomGridShape(viewport, count);
	const w = (viewport.width - 2 * WINDOW_GAP - (columns - 1) * WINDOW_GAP) / columns;
	const h = Math.max(3, (area.height - (rows - 1)) / rows);
	const row = Math.floor(slot / columns);
	const column = slot % columns;
	const inRow = row === rows - 1 ? count - row * columns : columns;
	const rowWidth = inRow * w + (inRow - 1) * WINDOW_GAP;
	const left = (viewport.width - rowWidth) / 2;
	return { x: left + column * (w + WINDOW_GAP), y: area.top + row * (h + 1), w, h };
}

/** Scale a rectangle around its own centre. */
function scaleAround(r: RoomRect, factor: number): RoomRect {
	const w = r.w * factor;
	const h = r.h * factor;
	return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** The inputs one frame of the room is drawn from. */
export interface RoomFrameState {
	/** Windows in the room, the new-conversation slot included when it is shown. */
	readonly count: number;
	/** Centre of the side-by-side row, in slots. */
	readonly scroll: number;
	/** Selected slot in the all-windows grid. */
	readonly selected: number;
	/** 1 is the centre window filling the screen; 0 is the overview. */
	readonly zoom: number;
	/** 0 is side by side; 1 is all windows. */
	readonly mix: number;
}

/**
 * Every window's placement on one frame, far windows first so a painter that
 * draws in order leaves the nearest window on top. A window with no strength
 * or no area on screen is left out.
 */
export function placeRoomWindows(viewport: RoomViewport, state: RoomFrameState): RoomPlacement[] {
	const zoom = clamp01(state.zoom);
	const mix = clamp01(state.mix);
	const steps = carouselSteps(viewport);
	const out: RoomPlacement[] = [];
	for (let slot = 0; slot < state.count; slot++) {
		const side = carouselOverview(viewport, steps, slot, state.scroll);
		const sideFull = fullScreen(viewport, slot, state.scroll);
		const sideRect = lerpRect(side.rect, sideFull.rect, zoom);
		const sideStrength = lerp(side.strength, sideFull.strength, zoom);

		const chosen = slot === state.selected;
		const grid = gridRect(viewport, slot, state.count);
		const gridFull: RoomRect = chosen
			? { x: 0, y: 0, w: viewport.width, h: viewport.height }
			: scaleAround(grid, GRID_RECEDE_SCALE);
		const gridRestStrength = chosen ? 1 : GRID_REST_STRENGTH;
		const gridRectNow = lerpRect(grid, gridFull, zoom);
		const gridStrength = lerp(gridRestStrength, chosen ? 1 : 0, zoom);

		const rect = snapRect(lerpRect(sideRect, gridRectNow, mix));
		const strength = clamp01(lerp(sideStrength, gridStrength, mix));
		const depth = lerp(lerp(side.depth, sideFull.depth, zoom), chosen ? 0 : 1, mix);
		if (strength <= 0.001 || rect.w <= 0 || rect.h <= 0) continue;
		if (rect.x >= viewport.width || rect.x + rect.w <= 0 || rect.y >= viewport.height || rect.y + rect.h <= 0) {
			continue;
		}
		const framed = rect.w <= viewport.width - 2 || rect.h <= viewport.height - 2;
		out.push({ slot, rect, strength, depth, framed });
	}
	out.sort((a, b) => b.depth - a.depth || a.slot - b.slot);
	return out;
}

/**
 * How strongly the chrome (title row, pager, key hints) is drawn at `zoom`. It
 * holds back until the windows have mostly pulled away from the screen edges,
 * so the first frames of an open are the conversation shrinking, not text
 * appearing over it.
 */
export function roomChromeStrength(zoom: number): number {
	return clamp01((1 - clamp01(zoom) - 0.3) / 0.7);
}

/**
 * The slot a grid arrow key lands on. `←`/`→` walk the reading order and wrap
 * at the ends; `↑`/`↓` move a row and keep the column, clamping into a short
 * last row.
 */
export function moveGridSelection(
	viewport: RoomViewport,
	count: number,
	selected: number,
	direction: "left" | "right" | "up" | "down",
): number {
	if (count <= 0) return 0;
	const { columns } = roomGridShape(viewport, count);
	switch (direction) {
		case "left":
			return (selected - 1 + count) % count;
		case "right":
			return (selected + 1) % count;
		case "up": {
			const next = selected - columns;
			return next >= 0 ? next : selected;
		}
		case "down": {
			const next = selected + columns;
			if (next < count) return next;
			const lastRowStart = Math.floor((count - 1) / columns) * columns;
			return Math.floor(selected / columns) * columns < lastRowStart ? count - 1 : selected;
		}
	}
}

/** The slot under a screen cell, nearest window first, or undefined when the cell is bare ground. */
export function roomSlotAt(placements: readonly RoomPlacement[], col: number, row: number): number | undefined {
	for (let i = placements.length - 1; i >= 0; i--) {
		const { rect, slot } = placements[i]!;
		if (col >= rect.x && col < rect.x + rect.w && row >= rect.y && row < rect.y + rect.h) return slot;
	}
	return undefined;
}
