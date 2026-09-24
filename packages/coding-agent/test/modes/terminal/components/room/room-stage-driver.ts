/**
 * A room stage on a fake terminal: the host the stage talks to, the members it
 * shows, and a driver that advances the stage's motion clock one frame at a
 * time and records every frame it renders.
 *
 * The host fakes only what sits behind the stage's boundary (putting a
 * conversation on screen, creating and closing one); the stage, its geometry,
 * its painter and its motion clock are the production ones.
 */

import { setImmediate as nextMacrotask } from "node:timers/promises";
import {
	type RoomLayout,
	RoomStage,
	type RoomStageHost,
	type RoomStageMode,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-stage";
import type {
	RoomDraft,
	RoomFeedBlock,
	RoomStageMember,
	RoomWindowSnapshot,
	RoomWindowState,
} from "@veyyon/coding-agent/modes/terminal/components/room/room-view-model";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { MotionClock } from "@veyyon/utils/motion";
import { visibleWidth } from "@veyyon/utils/width";
import { cellText, rowCells } from "./room-frame-oracle";

/** One frame at 60Hz, the cadence the product clock ticks at. */
export const FRAME_MS = 1000 / 60;
/** Wall time the driver starts at; any fixed value works, a round one reads well in a failure. */
export const START_MS = 1_700_000_000_000;

export const KEY = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x1b[H",
	end: "\x1b[F",
	/** The key the fake host reports as the one that opened the view (ctrl+r). */
	toggle: "\x12",
} as const;

/** An SGR mouse report at 0-based `col`/`row`; `button` is the raw code (0 left, 35 motion, 64..67 wheels). */
export function sgrMouse(button: number, col: number, row: number): string {
	return `\x1b[<${button};${col + 1};${row + 1}M`;
}

export function snapshotOf(
	state: RoomWindowState,
	blocks: readonly RoomFeedBlock[] = [],
	names: { title?: string } = {},
): RoomWindowSnapshot {
	return { state, blocks, title: names.title, model: "model-x", cwd: "~/repo" };
}

export class FakeMember implements RoomStageMember {
	readonly id: string;
	readonly origin: boolean;
	waitingDialogs: number;
	draft: RoomDraft | undefined;
	#snapshot: RoomWindowSnapshot;

	constructor(
		id: string,
		snapshot: RoomWindowSnapshot,
		options: { origin?: boolean; waitingDialogs?: number; draft?: RoomDraft } = {},
	) {
		this.id = id;
		this.#snapshot = snapshot;
		this.origin = options.origin ?? false;
		this.waitingDialogs = options.waitingDialogs ?? 0;
		this.draft = options.draft;
	}

	snapshot(): RoomWindowSnapshot {
		return this.#snapshot;
	}

	set(snapshot: RoomWindowSnapshot): void {
		this.#snapshot = snapshot;
	}
}

export interface PrepareCall {
	readonly id: string;
	readonly resolve: (rows: readonly string[] | undefined) => void;
	readonly reject: (error: Error) => void;
}

/** The terminal behind the stage. Every call the stage makes is recorded. */
export class FakeRoomHost implements RoomStageHost {
	readonly roster: FakeMember[];
	height: number;
	renderRequests = 0;
	readonly prepares: PrepareCall[] = [];
	/** Each land, with how many frames the driver had rendered when it came and the failure it reported. */
	readonly lands: Array<{ readonly id: string; readonly afterFrames: number; readonly failure?: unknown }> = [];
	readonly creates: string[] = [];
	readonly closes: string[] = [];
	/** What `close` answers; undefined closes. */
	closeRefusal: string | undefined;
	/** Set by the driver so a land records where in the frame sequence it came. */
	framesRendered: () => number = () => 0;
	#nextId = 0;

	constructor(roster: FakeMember[], height: number) {
		this.roster = roster;
		this.height = height;
	}

	requestRender(): void {
		this.renderRequests++;
	}

	rows(): number {
		return this.height;
	}

	members(): readonly RoomStageMember[] {
		return this.roster;
	}

	prepare(id: string): Promise<readonly string[] | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<readonly string[] | undefined>();
		this.prepares.push({ id, resolve, reject });
		return promise;
	}

	land(id: string, failure?: unknown): void {
		this.lands.push(
			failure === undefined
				? { id, afterFrames: this.framesRendered() }
				: { id, afterFrames: this.framesRendered(), failure },
		);
	}

	async create(): Promise<string> {
		const id = `created-${++this.#nextId}`;
		this.creates.push(id);
		this.roster.push(new FakeMember(id, snapshotOf({ kind: "new" })));
		return id;
	}

	async close(id: string): Promise<string | undefined> {
		this.closes.push(id);
		if (this.closeRefusal !== undefined) return this.closeRefusal;
		const index = this.roster.findIndex(member => member.id === id);
		if (index >= 0) this.roster.splice(index, 1);
		return undefined;
	}

	isToggle(data: string): boolean {
		return data === KEY.toggle;
	}
}

export interface StageDriverOptions {
	readonly width: number;
	readonly height: number;
	readonly members: FakeMember[];
	/** Defaults to the first member. */
	readonly originId?: string;
	readonly originScreen?: readonly string[];
	readonly layout?: RoomLayout;
	readonly mode?: RoomStageMode;
	/** Defaults to true: the stage animates on the driver's clock. */
	readonly motion?: boolean;
}

/** Every stage a driver built and has not disposed; a working member keeps a real spinner interval. */
const liveStages = new Set<RoomStage>();

/** Dispose every stage a driver built. Call from `afterEach` in a suite that shows a working member. */
export function disposeStages(): void {
	for (const stage of liveStages) stage.dispose();
	liveStages.clear();
}

/** A stage on a manual clock. Every frame goes through {@link StageDriver.render} and is kept. */
export class StageDriver {
	readonly clock = new MotionClock();
	readonly host: FakeRoomHost;
	readonly stage: RoomStage;
	readonly width: number;
	readonly frames: string[][] = [];
	/** Wall time the stage reads through its `now` option. */
	now = START_MS;
	#clockTime = 0;

	constructor(options: StageDriverOptions) {
		this.width = options.width;
		this.host = new FakeRoomHost(options.members, options.height);
		this.host.framesRendered = () => this.frames.length;
		this.stage = new RoomStage(this.host, {
			originId: options.originId ?? options.members[0]!.id,
			originScreen: options.originScreen,
			layout: options.layout ?? "side-by-side",
			mode: options.mode ?? { kind: "overview" },
			clock: this.clock,
			motion: options.motion ?? true,
			now: () => this.now,
		});
		liveStages.add(this.stage);
	}

	get height(): number {
		return this.host.height;
	}

	get lastFrame(): readonly string[] {
		const last = this.frames.at(-1);
		if (!last) throw new Error("no frame rendered yet");
		return last;
	}

	render(): readonly string[] {
		const rows = this.stage.render(this.width);
		this.frames.push([...rows]);
		return rows;
	}

	/** Advance the clock and the wall by `ms`, without rendering. */
	tick(ms: number = FRAME_MS): void {
		this.#clockTime += ms;
		this.now += ms;
		this.clock.tick(this.#clockTime);
	}

	/** Run every microtask and the macrotask turn after it: a promise the host settled lands here. */
	async flush(): Promise<void> {
		await nextMacrotask();
	}

	/** One frame as the product paints it: the clock ticks, the stage renders, then the turn's microtasks run. */
	async step(ms: number = FRAME_MS): Promise<readonly string[]> {
		this.tick(ms);
		const rows = this.render();
		await this.flush();
		return rows;
	}

	/**
	 * Step frames until no animation is live, then render the resting frame.
	 * Returns how many frames it took; fails past `maxFrames`, so a motion that
	 * never settles is a failure rather than a hang.
	 */
	async settle(maxFrames = 600, ms: number = FRAME_MS): Promise<number> {
		let frames = 0;
		await this.flush();
		while (this.clock.liveCount > 0) {
			if (++frames > maxFrames) throw new Error(`stage still moving after ${maxFrames} frames`);
			await this.step(ms);
		}
		this.render();
		return frames;
	}

	async press(data: string): Promise<void> {
		this.stage.handleInput(data);
		await this.flush();
	}
}

/**
 * The slot the pager row lights (it is the one drawn bold), or undefined when
 * the row shows no pager: `+` reads as the slot after the last member.
 */
export function pagerSelection(rows: readonly string[], memberCount: number): number | undefined {
	const row = rows[rows.length - 3];
	if (row === undefined) return undefined;
	const lit = cellText(rowCells(row).filter(cell => cell.style.includes("bold="))).trim();
	if (lit === "") return undefined;
	if (lit.startsWith("+")) return memberCount;
	const ordinal = Number.parseInt(lit, 10);
	return Number.isNaN(ordinal) ? undefined : ordinal - 1;
}

/**
 * Where the selected window sits on a frame: the top edge that carries the
 * selection cursor ahead of `ordinal`, from its `╭` to its `╮`. Undefined when
 * no such edge is on the frame, which is the case once a window is the whole
 * unframed screen.
 */
export function selectedWindowEdge(
	rows: readonly string[],
	ordinal: number,
): { x: number; y: number; w: number } | undefined {
	const box = theme.boxRound;
	const marker = `${theme.nav.cursor} ${ordinal}`;
	for (let y = 0; y < rows.length; y++) {
		const cells = rowCells(rows[y]!);
		const at = cellText(cells).indexOf(marker);
		if (at < 0) continue;
		// Map the string index back to a cell index; the right half of a wide glyph is no text.
		let column = 0;
		for (let consumed = 0; consumed < at; column++) consumed += cells[column]!.text.length;
		let left = column;
		while (left >= 0 && cells[left]!.text !== box.topLeft) left--;
		let right = column;
		while (right < cells.length && cells[right]!.text !== box.topRight) right++;
		if (left < 0 || right >= cells.length) continue;
		return { x: left, y, w: right - left + 1 };
	}
	return undefined;
}

/**
 * A conversation's screen at `width`×`height`: styled prose, wide glyphs at
 * shifting offsets, and a bold run left open at the row's end, every row
 * exactly `width` cells, the shape `TUI.composeViewport` hands back.
 */
export function screenRows(width: number, height: number, label: string): string[] {
	const pieces = [
		`\x1b[38;2;120;200;255m${label}\x1b[39m `,
		"漢字かな ",
		"plain text ",
		"\x1b[3mitalic\x1b[23m ",
		"🙂 ",
		"\x1b[1mweight ",
	];
	const rows: string[] = [];
	for (let r = 0; r < height; r++) {
		if (width < 1) {
			rows.push("");
			continue;
		}
		let row = `\x1b[38;2;${(r * 37) % 256};180;90m${r % 10}\x1b[39m`;
		let used = 1;
		for (let k = r % pieces.length; ; k++) {
			const piece = pieces[k % pieces.length]!;
			const pieceWidth = visibleWidth(piece);
			if (used + pieceWidth > width) break;
			row += piece;
			used += pieceWidth;
		}
		rows.push(row + " ".repeat(width - used));
	}
	return rows;
}
