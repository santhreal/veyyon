/**
 * A finalized block whose rows are committed leaves the transcript's frame on the first frame after
 * the one that drew its final state, whatever shape that frame has.
 *
 * THE DEFECT. The container marked a block droppable only in a frame that walked it: the walk of the
 * block's first render, or of the render in which it finalized or changed version, left it
 * undroppable, and a component-scoped frame carries every block above the one it names without
 * walking it again. A resumed session paints once, and the only frame after that paint names no
 * block, so every block that reports a version stayed in the frame for as long as the session sat at
 * rest: a resumed 600-turn transcript kept all 31,627 of its rows in the engine's frame.
 *
 * THE CLASS. Every way a block reaches its final render (present at the first frame, finalizing in a
 * frame of its own, changing version after it finalized), with and without a version, crossed with
 * every frame that can follow the commit: a full frame, a scoped frame naming a later block, and a
 * scoped frame naming none. And the other side of the same rule: a block whose state moved since the
 * render a frame carries (a new version, a finalized flag that flipped either way) stays in the frame
 * until a frame draws that state, and a block that changed version in the frame being drawn stays in
 * that frame, so the engine reads the rows it now draws against the rows the terminal holds.
 *
 * WHAT IT DOES NOT CATCH. Real block kinds: `a-block-in-scrollback-keeps-none-of-the-rows-it-drew`
 * paints each one through the engine the way a resumed session does. A displaceable snapshot, which
 * the seal pass finalizes before the walk.
 */
import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import type { Component } from "@veyyon/tui";

const WIDTH = 40;
const HEAD = ["head row one", "head row two", "head row three"];
const HEAD_FINAL = ["head row one", "head row two, final"];
const TAIL = ["tail row"];

/** A transcript block speaking the container's finality and version protocol. */
class Block implements Component {
	#lines: string[];
	#finalized: boolean;
	#version: number | undefined;

	constructor(lines: string[], options: { finalized: boolean; versioned: boolean }) {
		this.#lines = lines;
		this.#finalized = options.finalized;
		this.#version = options.versioned ? 0 : undefined;
	}

	get lines(): readonly string[] {
		return this.#lines;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	getTranscriptBlockVersion(): number | undefined {
		return this.#version;
	}

	/** Finalize with new rows, as a streamed reply does at its end. */
	finalize(lines: string[]): void {
		this.#lines = lines;
		this.#finalized = true;
		if (this.#version !== undefined) this.#version++;
	}

	/** Change rows after finalizing, as a restored inline error or a late image does. */
	mutate(lines: string[]): void {
		if (this.#version === undefined) throw new Error("an unversioned block cannot change after it finalized");
		this.#lines = lines;
		this.#version++;
	}

	reopen(): void {
		this.#finalized = false;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.#lines;
	}
}

type Frame = "full" | "scoped naming a later block" | "scoped naming none";

const FRAMES: readonly Frame[] = ["full", "scoped naming a later block", "scoped naming none"];

function draw(container: TranscriptContainer, frame: Frame, tail: Component): readonly string[] {
	if (frame === "scoped naming a later block") container.setComponentScopedRenderChildren(new Set([tail]));
	else if (frame === "scoped naming none") container.setComponentScopedRenderChildren(new Set());
	return [...container.render(WIDTH)];
}

function drawNaming(container: TranscriptContainer, block: Component): readonly string[] {
	container.setComponentScopedRenderChildren(new Set([block]));
	return [...container.render(WIDTH)];
}

interface Transcript {
	container: TranscriptContainer;
	head: Block;
	tail: Block;
}

function transcript(head: Block): Transcript {
	const container = new TranscriptContainer();
	container.setNativeScrollbackRetainRows(0);
	const tail = new Block(TAIL, { finalized: true, versioned: false });
	container.addChild(head);
	container.addChild(tail);
	return { container, head, tail };
}

/** Tell the container the head's rows and the separator under them are in native scrollback. */
function commitHead({ container, head }: Transcript): void {
	container.setNativeScrollbackCommittedRows(head.lines.length + 1);
}

/** Ways the head reaches the render of its final state; each ends on that render. */
const ARRIVALS: Record<string, { versioned: boolean[]; arrive: (t: Transcript) => void }> = {
	"present at the first frame": {
		versioned: [false, true],
		arrive: t => {
			t.container.render(WIDTH);
		},
	},
	"finalizing in a frame of its own": {
		versioned: [false, true],
		arrive: t => {
			t.head.reopen();
			t.container.render(WIDTH);
			t.head.finalize(HEAD_FINAL);
			drawNaming(t.container, t.head);
		},
	},
	"changing version after it finalized": {
		versioned: [true],
		arrive: t => {
			t.container.render(WIDTH);
			t.container.render(WIDTH);
			t.head.mutate(HEAD_FINAL);
			drawNaming(t.container, t.head);
		},
	},
};

describe("a committed block whose final state was drawn", () => {
	for (const [arrival, { versioned, arrive }] of Object.entries(ARRIVALS)) {
		for (const withVersion of versioned) {
			for (const frame of FRAMES) {
				it(`leaves the frame (${arrival}, ${withVersion ? "versioned" : "unversioned"}, then ${frame})`, () => {
					const t = transcript(new Block(HEAD, { finalized: true, versioned: withVersion }));
					arrive(t);
					commitHead(t);
					expect(draw(t.container, frame, t.tail)).toEqual(TAIL);
				});
			}
		}
	}
});

describe("a committed block whose state moved since the render a frame carries", () => {
	for (const frame of FRAMES.filter(frame => frame !== "full")) {
		it(`stays for its new version until a frame draws it (then ${frame})`, () => {
			const t = transcript(new Block(HEAD, { finalized: true, versioned: true }));
			t.container.render(WIDTH);
			commitHead(t);
			t.head.mutate(HEAD_FINAL);
			expect(draw(t.container, frame, t.tail)).toEqual([...HEAD, "", ...TAIL]);

			t.container.setNativeScrollbackCommittedRows(HEAD.length + 1);
			expect(draw(t.container, "full", t.tail)).toEqual([...HEAD_FINAL, "", ...TAIL]);
			t.container.setNativeScrollbackCommittedRows(HEAD_FINAL.length + 1);
			expect(draw(t.container, frame, t.tail)).toEqual(TAIL);
		});

		it(`stays while it reports itself live again (then ${frame})`, () => {
			const t = transcript(new Block(HEAD, { finalized: true, versioned: true }));
			t.container.render(WIDTH);
			commitHead(t);
			t.head.reopen();
			expect(draw(t.container, frame, t.tail)).toEqual([...HEAD, "", ...TAIL]);
		});
		for (const versioned of [false, true]) {
			it(`stays when it finalized after the live render a frame carries (${versioned ? "versioned" : "unversioned"}, then ${frame})`, () => {
				const t = transcript(new Block(HEAD, { finalized: false, versioned }));
				t.container.render(WIDTH);
				commitHead(t);
				t.head.finalize(HEAD);
				expect(draw(t.container, frame, t.tail)).toEqual([...HEAD, "", ...TAIL]);
			});
		}
	}

	it("stays in the frame that draws its new version", () => {
		const t = transcript(new Block(HEAD, { finalized: true, versioned: true }));
		t.container.render(WIDTH);
		commitHead(t);
		t.head.mutate(HEAD_FINAL);
		expect(draw(t.container, "full", t.tail)).toEqual([...HEAD_FINAL, "", ...TAIL]);
	});
});
