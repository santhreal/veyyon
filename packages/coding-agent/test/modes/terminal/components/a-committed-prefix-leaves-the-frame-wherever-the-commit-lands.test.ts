/**
 * The committed prefix of a transcript leaves the engine's frame wherever the commit boundary lands,
 * and what stays is the uncompacted frame's own suffix, opening on content.
 *
 * THE DEFECT. A frame keeps a screen of committed rows (the retain window) and drops the committed
 * blocks above it. The first block the frame keeps gives up the separator above it, because a block
 * placed at row 0 derives none. When the drop ceiling stood on a block boundary, that separator sat at
 * the ceiling itself, and the container abandoned the whole drop instead of keeping one block more.
 * An idle session draws frames at a fixed commit, so the ceiling stood there for as long as it sat at
 * rest: a resumed 600-turn transcript held 31,545 committed rows in the frame. Two smaller faults sat
 * on the same boundary: a trimmed block's start row was left one row above the frame, so the next frame
 * rendered a block whose rows were all committed, and the separator check read the first kept segment
 * rather than the first that holds rows, so a kept empty block let the frame open on a separator a
 * later re-derivation at row 0 does not draw.
 *
 * THE CLASS. Every commit count up to the live region, every retain window, transcript shapes with
 * empty, tall and live blocks, versioned and unversioned blocks, and both frames a compaction runs in
 * (a full frame, a scoped frame naming none). Each case asserts: the frame is a suffix of the
 * uncompacted frame; the drop takes no row at or past its ceiling; the frame opens on content; the
 * drop is the most those two rules allow; the next frame drops nothing more, draws the same rows and
 * renders no block whose rows are all committed; and a frame re-derived from source draws the same
 * rows.
 *
 * WHAT IT DOES NOT CATCH. Blocks whose rows open or close on a plain blank row, which the container
 * strips; a separator of more than one row, which no placement produces; the engine's own commit
 * bookkeeping, which `a-block-in-scrollback-keeps-none-of-the-rows-it-drew` drives end to end.
 */
import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import type { Component } from "@veyyon/tui";

const WIDTH = 40;

/** A transcript block that counts its renders and speaks the finality and version protocol. */
class Block implements Component {
	readonly #lines: string[];
	readonly #finalized: boolean;
	readonly #version: number | undefined;
	renders = 0;

	constructor(lines: string[], finalized: boolean, versioned: boolean) {
		this.#lines = lines;
		this.#finalized = finalized;
		this.#version = versioned ? 0 : undefined;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	getTranscriptBlockVersion(): number | undefined {
		return this.#version;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		this.renders++;
		return this.#lines;
	}
}

/** A block by its row count; `live` marks one still mutating. */
interface BlockSpec {
	rows: number;
	live?: boolean;
}

const SHAPES: Record<string, readonly BlockSpec[]> = {
	"uniform blocks": [{ rows: 2 }, { rows: 2 }, { rows: 2 }, { rows: 2 }, { rows: 2 }, { rows: 2 }],
	"varied blocks with an empty one": [{ rows: 1 }, { rows: 3 }, { rows: 0 }, { rows: 2 }, { rows: 1 }, { rows: 4 }],
	"a live empty block between committed ones": [
		{ rows: 2 },
		{ rows: 1 },
		{ rows: 3 },
		{ rows: 0, live: true },
		{ rows: 2 },
		{ rows: 1 },
	],
	"tall blocks around a short one": [{ rows: 5 }, { rows: 1 }, { rows: 5 }, { rows: 2 }],
};

const RETAIN_WINDOWS = [0, 1, 2, 4];

type CompactingFrame = "full" | "scoped naming none";

const COMPACTING_FRAMES: readonly CompactingFrame[] = ["full", "scoped naming none"];

/** Where a block's rows sit in the uncompacted frame: its separator row first, when it has one. */
interface Placement {
	start: number;
	sep: number;
	end: number;
	holdsRows: boolean;
	live: boolean;
}

/** One blank row between blocks that hold rows, none above the first. */
function layout(shape: readonly BlockSpec[]): Placement[] {
	let row = 0;
	return shape.map(({ rows, live = false }) => {
		const sep = rows > 0 && row > 0 ? 1 : 0;
		const placement = { start: row, sep, end: row + sep + rows, holdsRows: rows > 0, live };
		row = placement.end;
		return placement;
	});
}

interface Case {
	container: TranscriptContainer;
	blocks: Block[];
	placements: Placement[];
	full: string[];
}

function build(shape: readonly BlockSpec[], retain: number, versioned: boolean): Case {
	const container = new TranscriptContainer();
	container.setNativeScrollbackRetainRows(retain);
	const blocks = shape.map(
		({ rows, live = false }, b) =>
			new Block(
				Array.from({ length: rows }, (_, r) => `block ${b} row ${r}`),
				!live,
				versioned,
			),
	);
	for (const block of blocks) container.addChild(block);
	const full = [...container.render(WIDTH)];
	return { container, blocks, placements: layout(shape), full };
}

function drawFrame(container: TranscriptContainer, frame: CompactingFrame): string[] {
	if (frame === "scoped naming none") container.setComponentScopedRenderChildren(new Set());
	return [...container.render(WIDTH)];
}

/** Rows of the uncompacted frame the engine may commit: everything above the first live block. */
function commitLimit({ placements, full }: Case): number {
	return placements.find(p => p.live)?.start ?? full.length;
}

/**
 * The most rows a drop may take below `ceiling`: whole finalized blocks above the first live one,
 * ending where the frame opens on a block's content. That is past the separator of the first block
 * kept when the separator lies below the ceiling, else past the separator of the last block dropped
 * whole that holds rows, which the frame then keeps.
 */
function maximalDrop(placements: readonly Placement[], ceiling: number): number {
	let last = -1;
	for (let b = 0; b < placements.length; b++) {
		const placement = placements[b]!;
		if (placement.live || placement.end > ceiling) break;
		if (placement.holdsRows) last = b;
	}
	if (last < 0) return 0;
	const dropped = placements[last]!;
	const kept = placements.slice(last + 1).find(p => p.holdsRows);
	if (kept === undefined) return dropped.end;
	return kept.start + kept.sep <= ceiling ? kept.start + kept.sep : dropped.start + dropped.sep;
}

describe("the uncompacted frame", () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		it(`places one blank row between blocks that hold rows (${name})`, () => {
			const { full, placements } = build(shape, 0, false);
			expect(full.length).toBe(placements.at(-1)!.end);
			for (const placement of placements) {
				if (placement.sep > 0) expect(full[placement.start]).toBe("");
				if (placement.holdsRows) expect(full[placement.start + placement.sep]).not.toBe("");
			}
		});
	}
});

describe("a committed prefix leaves the frame wherever the commit lands", () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		for (const versioned of [false, true]) {
			for (const frame of COMPACTING_FRAMES) {
				for (const retain of RETAIN_WINDOWS) {
					const label = `${name}, ${versioned ? "versioned" : "unversioned"}, retaining ${retain}, in a ${frame} frame`;
					it(`drops up to its ceiling and keeps the frame's own suffix (${label})`, () => {
						const limit = commitLimit(build(shape, retain, versioned));
						for (let committed = 0; committed <= limit; committed++) {
							const at = `at ${committed} committed rows`;
							const c = build(shape, retain, versioned);
							c.container.setNativeScrollbackCommittedRows(committed);
							const compacted = drawFrame(c.container, frame);
							const dropped = c.container.takeNativeScrollbackDroppedRows();
							const ceiling = Math.max(0, committed - retain);

							expect(compacted, at).toEqual(c.full.slice(dropped));
							expect(dropped, at).toBeLessThanOrEqual(ceiling);
							expect(dropped, `${at}: the drop is maximal`).toBe(maximalDrop(c.placements, ceiling));
							if (compacted.length > 0) expect(compacted[0], `${at}: the frame opens on content`).not.toBe("");

							// The engine moves its commit index with the drop and draws the next frame.
							const rendersBefore = c.blocks.map(block => block.renders);
							c.container.setNativeScrollbackCommittedRows(committed - dropped);
							expect(drawFrame(c.container, "full"), `${at}: the next frame`).toEqual(compacted);
							expect(c.container.takeNativeScrollbackDroppedRows(), `${at}: the next frame's drop`).toBe(0);
							c.placements.forEach((placement, b) => {
								if (placement.live || placement.end > committed) return;
								expect(c.blocks[b]!.renders, `${at}: block ${b}, all rows committed, renders again`).toBe(
									rendersBefore[b],
								);
							});

							// A frame derived again from source, as a theme change draws it.
							c.container.invalidate();
							expect(drawFrame(c.container, "full"), `${at}: the re-derived frame`).toEqual(compacted);
						}
					});
				}
			}
		}
	}
});

describe("an idle frame whose ceiling stands on a block boundary", () => {
	it("keeps one block above the ceiling, not the whole committed prefix", () => {
		const blocks = Array.from({ length: 200 }, () => ({ rows: 3 }));
		const c = build(blocks, 10, false);
		// Block 150 ends at row 150 * 4 + 3 = 603; the next block's separator is row 603.
		const boundary = c.placements[150]!.end;
		c.container.setNativeScrollbackCommittedRows(boundary + 10);
		drawFrame(c.container, "full");
		const dropped = c.container.takeNativeScrollbackDroppedRows();
		expect(dropped).toBe(c.placements[150]!.start + 1);

		// Every later idle frame at the same commit leaves the frame as it is.
		c.container.setNativeScrollbackCommittedRows(boundary + 10 - dropped);
		for (let frame = 0; frame < 3; frame++) {
			drawFrame(c.container, "scoped naming none");
			expect(c.container.takeNativeScrollbackDroppedRows()).toBe(0);
		}
		expect(drawFrame(c.container, "full")).toEqual(c.full.slice(dropped));
	});
});
