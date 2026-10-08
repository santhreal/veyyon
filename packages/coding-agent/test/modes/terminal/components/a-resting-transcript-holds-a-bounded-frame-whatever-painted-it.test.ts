/**
 * A transcript at rest holds a frame of about two screens, whatever paint put its rows in native
 * scrollback, and the frame that drops them draws no block and asks for no other.
 *
 * THE DEFECT. The transcript drops committed rows only while it renders, reading the commit claim
 * the previous frame published. The paint that commits the rows is the last frame of a session that
 * goes quiet (a resumed session at rest, the end of a turn, a resize or a display reset), so the
 * rows it committed stayed in the frame with every block that drew them until something rendered
 * again. A resumed 600-turn session kept all 31,627 of its rows in the engine's frame. The engine
 * now follows a paint that grew the commit past a screen with a frame that names no block, in which
 * the transcript drops those rows.
 *
 * A frame the alternate-screen transport paints recorded no geometry, so after a resize every later
 * frame read the resize again and replayed the whole history: every keystroke redrew every block,
 * and the replay's compaction frame replayed it again, a loop that never went quiet.
 *
 * THE CLASS. Every paint that commits rows: the first paint of a transcript that already exists,
 * the replay a resize, a display reset, a session replace or a forced repaint takes, the incremental
 * update that scrolls a growing transcript, the scroll-isolation tape and the alternate-screen
 * transport, including the replay a resize or a session replace takes there, and a session replace
 * that lands before the frame that drops what the last paint committed, on either screen. After each
 * one settles:
 * the frame holds at most the screen, the screen kept for a shrink and the block the drop stops at;
 * only the blocks inside that frame keep the rows they drew; the frame that drops rows re-derives no
 * block; and the engine goes quiet. After a resize on the alternate screen, the next ordinary frame
 * draws only the blocks inside it. The converse: a paint that commits no more than a screen, or a
 * root that does not drop rows, is followed by no frame. Each case also asserts the engine took the
 * path it names, so a gesture that stops reaching its path fails here rather than passing on another.
 *
 * WHAT IT DOES NOT CATCH. A multiplexer pane (`TMUX`, `STY`, `ZELLIJ`) and a ConPTY host, which
 * the engine detects from the process environment: the first repaints a resize in place, the second
 * defers every frame after a full paint by a settle window. A block that reports itself live.
 * History preservation across those paints: `a-virtualized-transcript-never-loses-history-to-a-rebuild`.
 */
import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { type Component, Text, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../../../hosts/terminal/engine/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";

const WIDTH = 80;
const ROWS = 20;
const ROWS_PER_BLOCK = 5;
const BLOCKS = 120;
/** The engine's resize settle window, after which a resize replays history. */
const RESIZE_SETTLE_MS = 300;
/** Quiet time after a settle in which a terminating engine composes nothing. */
const IDLE_MS = 150;

/** Rows a resting frame may hold: the screen, the screen kept for a shrink, and the block the drop stops at. */
function frameBound(screenRows: number): number {
	return 2 * screenRows + ROWS_PER_BLOCK + 1;
}

/** Blocks whose rows fit in `rows`, plus the one the drop stops at. */
function blocksWithin(rows: number): number {
	return Math.ceil(rows / ROWS_PER_BLOCK) + 1;
}

/** A finalized transcript block that records its renders and whether it still holds its rows. */
class Block implements Component {
	readonly #rows: readonly string[];
	#held: readonly string[] | undefined;
	renders = 0;

	constructor(index: number) {
		this.#rows = Array.from({ length: ROWS_PER_BLOCK }, (_, row) => `block ${index} row ${row}`);
	}

	get held(): boolean {
		return this.#held !== undefined;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	render(): readonly string[] {
		this.renders++;
		this.#held ??= this.#rows.slice();
		return this.#held;
	}

	releaseRenderCache(): void {
		this.#held = undefined;
	}

	invalidate(): void {
		this.#held = undefined;
	}
}

/** The production transcript, counting the frames that render it and those that composed every block. */
class CountedTranscript extends TranscriptContainer {
	renders = 0;
	wholeFrames = 0;
	#race: (() => void) | undefined;

	constructor(race?: () => void) {
		super();
		this.#race = race;
	}

	override render(width: number): readonly string[] {
		this.renders++;
		const race = this.#race;
		this.#race = undefined;
		// Runs once the frame returns: after the engine published the rows it committed, before the
		// frame that drops them.
		if (race !== undefined) queueMicrotask(race);
		const rows = super.render(width);
		if (rows.length >= this.children.length * ROWS_PER_BLOCK) this.wholeFrames++;
		return rows;
	}
}

interface Scene {
	readonly term: VirtualTerminal;
	readonly tui: TUI;
	readonly chat: CountedTranscript;
	readonly blocks: Block[];
}

function append(scene: Scene, count: number): void {
	for (let i = 0; i < count; i++) {
		const block = new Block(scene.blocks.length);
		scene.blocks.push(block);
		scene.chat.addChild(block);
	}
}

async function open(blocks: number, transport?: "mouse" | "alt-arrows", race?: (tui: TUI) => void): Promise<Scene> {
	const term = new VirtualTerminal(WIDTH, ROWS, BLOCKS * ROWS_PER_BLOCK * 3);
	const tui = new TUI(term);
	if (transport !== undefined) {
		tui.setScrollTransport(transport);
		tui.setScrollIsolation(true);
	}
	const chat = new CountedTranscript(race === undefined ? undefined : () => race(tui));
	const scene: Scene = { term, tui, chat, blocks: [] };
	append(scene, blocks);
	tui.addChild(scene.chat);
	tui.start();
	await settleFrames(term, tui);
	return scene;
}

/** Resize, then wait out the settle window after which the engine replays history. */
async function resize(scene: Scene, columns: number, rows: number): Promise<void> {
	scene.term.resize(columns, rows);
	await settleFrames(scene.term, scene.tui);
	await Bun.sleep(RESIZE_SETTLE_MS);
}

/** Grow the transcript over several frames, the last of which commits many screens at once. */
async function grow(scene: Scene): Promise<void> {
	for (let batch = 0; batch < 6; batch++) {
		append(scene, 10);
		scene.tui.requestRender();
		await settleFrames(scene.term, scene.tui);
	}
	append(scene, 40);
	scene.tui.requestRender();
}

interface Gesture {
	/** Transcript blocks present at the first paint. */
	readonly blocks: number;
	readonly transport?: "mouse" | "alt-arrows";
	/** The gesture, applied once the first paint settled; none measures the first paint itself. */
	readonly act?: (scene: Scene) => Promise<void> | void;
	/** A replay requested as the first paint returns, before the frame that drops what it committed. */
	readonly race?: (tui: TUI) => void;
	/** Whether every block renders at most once from the gesture on: a single paint draws each once. */
	readonly singlePaint: boolean;
	/**
	 * What the engine counts when it takes the path the gesture names. A replay draws every block
	 * again; a raced replay composes the whole transcript a second time.
	 */
	readonly path: "firstPaint" | "fullRedraw" | "resizeViewport" | "update" | "replay" | "racedReplay";
}

const GESTURES: Readonly<Record<string, Gesture>> = {
	"the first paint of a resumed transcript": { blocks: BLOCKS, singlePaint: true, path: "firstPaint" },
	"a resize to a narrower terminal": {
		blocks: BLOCKS,
		act: scene => resize(scene, WIDTH - 10, ROWS),
		singlePaint: false,
		path: "resizeViewport",
	},
	"a resize to a shorter terminal": {
		blocks: BLOCKS,
		act: scene => resize(scene, WIDTH, ROWS - 6),
		singlePaint: false,
		path: "resizeViewport",
	},
	"a resize to a taller terminal": {
		blocks: BLOCKS,
		act: scene => resize(scene, WIDTH, ROWS + 6),
		singlePaint: false,
		path: "resizeViewport",
	},
	"a display reset": {
		blocks: BLOCKS,
		act: scene => scene.tui.resetDisplay(),
		singlePaint: true,
		path: "fullRedraw",
	},
	"a session replace": {
		blocks: BLOCKS,
		act: scene => scene.tui.requestRender(true, { clearScrollback: true }),
		singlePaint: true,
		path: "fullRedraw",
	},
	"a forced repaint": {
		blocks: BLOCKS,
		act: scene => scene.tui.requestRender(true),
		singlePaint: true,
		path: "fullRedraw",
	},
	"a transcript that grows and goes quiet": { blocks: 2, act: grow, singlePaint: false, path: "update" },
	"the first paint under scroll isolation": {
		blocks: BLOCKS,
		transport: "mouse",
		singlePaint: true,
		path: "firstPaint",
	},
	"the first paint on the alternate screen": {
		blocks: BLOCKS,
		transport: "alt-arrows",
		singlePaint: true,
		path: "firstPaint",
	},
	"a transcript that grows on the alternate screen": {
		blocks: 2,
		transport: "alt-arrows",
		act: grow,
		singlePaint: false,
		path: "update",
	},
	"a resize on the alternate screen": {
		blocks: BLOCKS,
		transport: "alt-arrows",
		act: scene => resize(scene, WIDTH - 10, ROWS),
		singlePaint: false,
		path: "replay",
	},
	"a resize to a shorter terminal on the alternate screen": {
		blocks: BLOCKS,
		transport: "alt-arrows",
		act: scene => resize(scene, WIDTH, ROWS - 6),
		singlePaint: false,
		path: "replay",
	},
	"a session replace on the alternate screen": {
		blocks: BLOCKS,
		transport: "alt-arrows",
		act: scene => scene.tui.requestRender(true, { clearScrollback: true }),
		singlePaint: true,
		path: "replay",
	},
	"a session replace before the frame that drops rows": {
		blocks: BLOCKS,
		race: tui => tui.requestRender(true, { clearScrollback: true }),
		singlePaint: true,
		path: "racedReplay",
	},
	"a session replace before the frame that drops rows on the alternate screen": {
		blocks: BLOCKS,
		transport: "alt-arrows",
		race: tui => tui.requestRender(true, { clearScrollback: true }),
		singlePaint: true,
		path: "racedReplay",
	},
};

interface Rest {
	readonly screenRows: number;
	readonly framedRows: number;
	readonly heldBlocks: number;
	readonly redrawnBlocks: number;
	readonly pathTaken: boolean;
	readonly idleFrames: number;
	readonly renderPending: boolean;
}

async function rest(gesture: Gesture): Promise<Rest> {
	const scene = await open(gesture.blocks, gesture.transport, gesture.race);
	try {
		const fullRedraws = scene.tui.fullRedraws;
		const viewportPaints = scene.tui.resizeViewportPaints;
		const committed = scene.tui.committedRows;
		for (const block of scene.blocks) block.renders = 0;
		const firstBlocks = scene.blocks.length;
		await gesture.act?.(scene);
		await settleFrames(scene.term, scene.tui);
		const pathTaken = {
			firstPaint: committed > 0,
			fullRedraw: scene.tui.fullRedraws > fullRedraws,
			resizeViewport: scene.tui.resizeViewportPaints > viewportPaints && scene.tui.fullRedraws > fullRedraws,
			update: scene.blocks.length > firstBlocks,
			replay: scene.blocks.every(block => block.renders > 0),
			racedReplay: scene.chat.wholeFrames >= 2,
		}[gesture.path];
		const settled = scene.chat.renders;
		await Bun.sleep(IDLE_MS);
		const idleFrames = scene.chat.renders - settled;
		// A single paint draws each block once; the frame that drops rows draws none. A first paint
		// counts from the paint itself, so its blocks were reset after it: none may render again.
		const limit = gesture.act === undefined ? 0 : 1;
		return {
			screenRows: scene.term.rows,
			framedRows: scene.tui.composedFrameRows,
			heldBlocks: scene.blocks.filter(block => block.held).length,
			redrawnBlocks: gesture.singlePaint ? scene.blocks.filter(block => block.renders > limit).length : 0,
			pathTaken,
			idleFrames,
			renderPending: scene.tui.renderPending,
		};
	} finally {
		scene.tui.stop();
	}
}

describe("a transcript at rest after a paint that committed its history", () => {
	for (const [name, gesture] of Object.entries(GESTURES)) {
		it(`holds about two screens after ${name}`, async () => {
			const result = await rest(gesture);
			const bound = frameBound(result.screenRows);
			expect({
				pathTaken: result.pathTaken,
				framed: result.framedRows <= bound,
				held: result.heldBlocks <= blocksWithin(bound),
				redrawnBlocks: result.redrawnBlocks,
				idleFrames: result.idleFrames,
				renderPending: result.renderPending,
			}).toEqual({
				pathTaken: true,
				framed: true,
				held: true,
				redrawnBlocks: 0,
				idleFrames: 0,
				renderPending: false,
			});
		});
	}
});

describe("a paint with nothing to drop", () => {
	/** A transcript of `n` blocks composes `n * ROW_STRIDE - 1` rows: a separator row follows every block but the last. */
	const ROW_STRIDE = ROWS_PER_BLOCK + 1;
	/** The most blocks whose first paint commits no more than a screen: `n * ROW_STRIDE - 1 - ROWS <= ROWS`. */
	const MOST_BLOCKS_WITHIN_A_SCREEN = Math.floor((2 * ROWS + 1) / ROW_STRIDE);

	it("is followed by no frame when it commits no more than a screen", async () => {
		const scene = await open(MOST_BLOCKS_WITHIN_A_SCREEN);
		try {
			const committed = scene.tui.committedRows;
			expect({ committed: committed > 0 && committed <= ROWS, frames: scene.chat.renders }).toEqual({
				committed: true,
				frames: 1,
			});
		} finally {
			scene.tui.stop();
		}
	});

	it("is followed by the frame that drops rows once one more block commits past a screen", async () => {
		const scene = await open(MOST_BLOCKS_WITHIN_A_SCREEN + 1);
		try {
			const committed = scene.tui.committedRows;
			expect({ committed: committed > ROWS, frames: scene.chat.renders }).toEqual({ committed: true, frames: 2 });
		} finally {
			scene.tui.stop();
		}
	});

	it("is followed by no frame when its root does not drop rows", async () => {
		const term = new VirtualTerminal(WIDTH, ROWS, BLOCKS * ROWS_PER_BLOCK * 3);
		const tui = new TUI(term);
		let renders = 0;
		const text = new Text(Array.from({ length: BLOCKS * ROWS_PER_BLOCK }, (_, row) => `plain row ${row}`).join("\n"));
		const counted: Component = {
			render: width => {
				renders++;
				return text.render(width);
			},
			invalidate: () => text.invalidate(),
		};
		tui.addChild(counted);
		tui.start();
		try {
			await settleFrames(term, tui);
			expect({ committed: tui.committedRows > ROWS, frames: renders }).toEqual({ committed: true, frames: 1 });
		} finally {
			tui.stop();
		}
	});
});

describe("the alternate screen after a resize", () => {
	it("draws only the blocks inside the frame for the next ordinary frame", async () => {
		const scene = await open(BLOCKS, "alt-arrows");
		try {
			await resize(scene, WIDTH - 10, ROWS);
			await settleFrames(scene.term, scene.tui);
			for (const block of scene.blocks) block.renders = 0;
			const old = scene.blocks.slice();
			append(scene, 1);
			scene.tui.requestRender();
			await settleFrames(scene.term, scene.tui);
			const redrawn = old.filter(block => block.renders > 0).length;
			expect({
				redrawn: redrawn > 0 && redrawn <= blocksWithin(frameBound(scene.term.rows)),
				renderPending: scene.tui.renderPending,
			}).toEqual({ redrawn: true, renderPending: false });
		} finally {
			scene.tui.stop();
		}
	});
});
