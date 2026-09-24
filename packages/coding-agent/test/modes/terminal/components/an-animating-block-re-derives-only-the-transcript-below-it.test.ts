/**
 * A block that animates re-derives only the transcript from itself down.
 *
 * THE DEFECT. A spinner or rail tick inside one transcript block asks the engine for
 * a component-scoped frame. The engine reused every other root child, but the
 * transcript is one root child, so it walked every block it held: each tick asked
 * every block whether it had finalized, compared its segment, and rebuilt the segment
 * list. A resumed session of 116k blocks spent 37-69 ms per tick and a whole core
 * while idle.
 *
 * THE CLASS. A component-scoped frame names the transcript's children that contain a
 * requester (`ComponentScopedRender`). Every block above the earliest one named is
 * unchanged since the last render, so the frame must not render it, and it must paint
 * what the same frame requested in full paints. The sweep checks that on every step,
 * including the steps where the previous render no longer stands (a child added or
 * removed, an invalidation) and the transcript must walk everything again.
 *
 * THE ORACLES. With nothing committed, a second TUI composing the same blocks cold is
 * the definition of the frame. Once rows commit, the terminal's history depends on
 * every frame before this one, so the sweep runs a control arm: the same blocks and
 * the same steps with every request a full one. The scoped arm is correct when its
 * viewport and its scrollback are byte-identical to the control's after every step.
 *
 * WHAT IT DOES NOT CATCH. A block that changes without asking for a render: the
 * scoped frame trusts the render request contract, as the engine does for its root
 * children. It does not measure time; the render counts are the bound.
 */
import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { type Component, Container, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "../../../../../../hosts/terminal/engine/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";

const COLUMNS = 48;

/**
 * A block whose rows the test replaces, returning a new array per change as the render
 * contract requires. Its rows carry the invalidation count, the way a theme change
 * restyles every block, and a displaceable one stays live until its rows reach the
 * tape and the transcript seals it.
 */
class Block implements Component {
	renders = 0;
	sealed = false;
	#lines: readonly string[];
	#painted: readonly string[] | undefined;
	#theme = 0;
	readonly #displaceable: boolean;

	constructor(lines: readonly string[], displaceable: boolean) {
		this.#lines = lines;
		this.#displaceable = displaceable;
	}

	set(lines: readonly string[]): void {
		this.#lines = lines;
		this.#painted = undefined;
	}

	invalidate(): void {
		this.#theme++;
		this.#painted = undefined;
	}

	isTranscriptBlockFinalized(): boolean {
		return !this.#displaceable || this.sealed;
	}

	isDisplaceableBlock(): boolean {
		return this.#displaceable && !this.sealed;
	}

	seal(): void {
		this.sealed = true;
		this.#painted = undefined;
	}

	render(_width: number): readonly string[] {
		this.renders++;
		const mark = ` t${this.#theme}${this.sealed ? " sealed" : ""}`;
		this.#painted ??= this.#lines.map(line => line + mark);
		return this.#painted;
	}
}

/** One transcript child: a bare block, or a block inside a wrapper, the shape a tool card has. */
interface Entry {
	child: Component;
	block: Block;
}

function entry(label: string, rows: number, wrapped: boolean, displaceable = false): Entry {
	const block = new Block(rowsOf(label, rows), displaceable);
	if (!wrapped) return { child: block, block };
	const wrapper = new Container();
	wrapper.addChild(block);
	return { child: wrapper, block };
}

function rowsOf(label: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${label} row ${i + 1}`);
}

function strip(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

/** Deterministic PRNG so a failing step replays exactly. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Harness {
	term: VirtualTerminal;
	scheduler: StressRenderScheduler;
	tui: TUI;
	transcript: TranscriptContainer;
}

async function mount(rows: number, children: readonly Component[]): Promise<Harness> {
	const term = new VirtualTerminal(COLUMNS, rows, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const transcript = new TranscriptContainer();
	for (const child of children) transcript.addChild(child);
	tui.addChild(transcript);
	tui.start();
	await scheduler.drain(term);
	tui.requestRender();
	await scheduler.drain(term);
	return { term, scheduler, tui, transcript };
}

async function unmount(harness: Harness): Promise<void> {
	harness.tui.stop();
	await harness.term.flush();
}

/** What one full frame of these children paints. */
async function coldViewport(rows: number, children: readonly Component[]): Promise<string[]> {
	const cold = await mount(rows, children);
	try {
		return strip(cold.term.getViewport());
	} finally {
		await unmount(cold);
	}
}

describe("an animating block re-derives only the transcript below it", () => {
	it("renders no block above the requester and paints what a cold compose paints", async () => {
		// Tall enough that nothing commits, so a full frame renders every block and
		// the render counts tell a scoped frame from a full one.
		const rows = 400;
		const entries = Array.from({ length: 60 }, (_, i) => entry(`b${i}`, 1 + (i % 3), i % 2 === 0));
		const harness = await mount(
			rows,
			entries.map(e => e.child),
		);
		try {
			const requester = entries[50]!;
			const rendersAbove = () => entries.slice(0, 50).reduce((sum, e) => sum + e.block.renders, 0);

			// Non-vacuity: a full frame at this height renders the blocks above.
			const beforeFull = rendersAbove();
			harness.tui.requestRender();
			await harness.scheduler.drain(harness.term);
			expect(rendersAbove() - beforeFull).toBe(50);

			const beforeScoped = rendersAbove();
			const requesterRenders = requester.block.renders;
			requester.block.set(rowsOf("b50 grown", 4));
			harness.tui.requestComponentRender(requester.block);
			await harness.scheduler.drain(harness.term);

			expect({
				renderedAbove: rendersAbove() - beforeScoped,
				renderedRequester: requester.block.renders - requesterRenders,
			}).toEqual({ renderedAbove: 0, renderedRequester: 1 });
			expect(strip(harness.term.getViewport())).toEqual(
				await coldViewport(
					rows,
					entries.map(e => e.child),
				),
			);
		} finally {
			await unmount(harness);
		}
	});

	it("seals a displaceable block above the requester once its rows reach the tape", async () => {
		// A short terminal: the requester below the snapshot grows one row per frame
		// until the snapshot scrolls off. Every frame is scoped to the requester, so
		// only the seal pass resuming where the last one stopped can reach the
		// snapshot, and the seam it pinned must open in the frame that seals it.
		const rows = 12;
		const head = Array.from({ length: 20 }, (_, i) => entry(`h${i}`, 2, i % 2 === 0));
		const snapshot = entry("snap", 1, false, true);
		const requester = entry("tail", 1, true);
		const entries = [...head, snapshot, requester];
		const harness = await mount(
			rows,
			entries.map(e => e.child),
		);
		try {
			expect(snapshot.block.sealed).toBe(false);
			const aboveBefore = head.map(e => e.block.renders);
			let grown = 1;
			while (grown <= rows * 2 && !snapshot.block.sealed) {
				grown++;
				requester.block.set(rowsOf("tail", grown));
				harness.tui.requestComponentRender(requester.block);
				await harness.scheduler.drain(harness.term);
			}
			expect({
				sealed: snapshot.block.sealed,
				// Bound: the snapshot leaves the window once the requester fills it,
				// and seals on the frame after.
				withinBound: grown <= rows + 1,
				renderedAbove: head.some((e, i) => e.block.renders !== aboveBefore[i]),
				seam: harness.transcript.getNativeScrollbackLiveRegionStart(),
			}).toEqual({ sealed: true, withinBound: true, renderedAbove: false, seam: undefined });
		} finally {
			await unmount(harness);
		}
	});

	type Op = "reshape" | "two" | "remove" | "append" | "swap" | "full" | "invalidate";
	const OPS: readonly Op[] = ["reshape", "two", "remove", "append", "swap", "full", "invalidate"];

	/** One step's choices, drawn once and replayed on both arms. */
	interface Step {
		op: Op;
		slot: number;
		rows: number;
		otherSlot: number;
		otherRows: number;
		victim: number;
		addedRows: number;
		addedWrapped: boolean;
	}

	function script(seed: number, steps: number): Step[] {
		const random = mulberry32(seed);
		const int = (bound: number) => Math.floor(random() * bound);
		return Array.from({ length: steps }, (_, step) => ({
			op: OPS[step % OPS.length]!,
			slot: int(3),
			rows: 1 + int(4),
			otherSlot: int(3),
			otherRows: 1 + int(3),
			victim: random(),
			addedRows: 1 + int(3),
			addedWrapped: random() < 0.5,
		}));
	}

	interface Arm {
		harness: Harness;
		entries: Entry[];
		next: number;
	}

	async function arm(rows: number): Promise<Arm> {
		// Block 36 is a displaceable snapshot just above the tail: it keeps the seam
		// open until the tail pushes its rows onto the tape, where a scoped frame
		// must still seal it.
		const entries = Array.from({ length: 40 }, (_, i) =>
			entry(`b${i}`, 1 + (i % 3), i % 2 === 1 && i !== 36, i === 36),
		);
		const harness = await mount(
			rows,
			entries.map(e => e.child),
		);
		return { harness, entries, next: entries.length };
	}

	/** Apply one step; `scoped` picks the request kind. Returns whether no block above the requester rendered. */
	async function apply(target: Arm, step: Step, index: number, scoped: boolean): Promise<boolean> {
		const { harness, entries } = target;
		// Requesters come from the tail, where an animating block sits.
		const tail = entries.slice(-3);
		const requester = tail[step.slot % tail.length]!;
		const above = entries.slice(0, entries.indexOf(requester));
		const aboveBefore = above.map(e => e.block.renders);
		requester.block.set(rowsOf(`b-step${index}`, step.rows));
		const request = (block: Block) =>
			scoped ? harness.tui.requestComponentRender(block) : harness.tui.requestRender();

		if (step.op === "two") {
			const other = tail[step.otherSlot % tail.length]!;
			other.block.set(rowsOf(`o-step${index}`, step.otherRows));
			request(other.block);
		} else if (step.op === "remove" || step.op === "swap") {
			const victim = entries.splice(Math.floor(step.victim * (entries.length - 4)), 1)[0]!;
			harness.transcript.removeChild(victim.child);
		}
		if (step.op === "append" || step.op === "swap") {
			// A swap leaves the child count where it was, so the count alone cannot
			// show that the rows above the requester moved.
			const added = entry(`b${target.next++}`, step.addedRows, step.addedWrapped);
			entries.push(added);
			harness.transcript.addChild(added.child);
		} else if (step.op === "invalidate") {
			harness.transcript.invalidate();
		}
		if (step.op === "full") harness.tui.requestRender();
		else request(requester.block);
		await harness.scheduler.drain(harness.term);
		return above.length > 0 && above.every((e, i) => e.block.renders === aboveBefore[i]);
	}

	function painted(target: Arm): { viewport: string[]; history: string[]; sealed: boolean[]; seam?: number } {
		return {
			viewport: strip(target.harness.term.getViewport()),
			history: strip(target.harness.term.getScrollBuffer()),
			sealed: target.entries.map(e => e.block.sealed),
			// The row the engine treats as the start of the still-mutating region.
			seam: target.harness.transcript.getNativeScrollbackLiveRegionStart(),
		};
	}

	for (const rows of [12, 400]) {
		it(`paints what full frames paint after every step of a seeded sweep at ${rows} rows`, async () => {
			const steps = script(0x5eed + rows, 49);
			const scopedArm = await arm(rows);
			const controlArm = await arm(rows);
			const divergences: Array<{ step: number; op: Op; scoped: object; control: object }> = [];
			let scopedFrames = 0;
			try {
				for (let index = 0; index < steps.length; index++) {
					const step = steps[index]!;
					if ((await apply(scopedArm, step, index, true)) && step.op === "reshape") scopedFrames++;
					await apply(controlArm, step, index, false);
					const scoped = painted(scopedArm);
					const control = painted(controlArm);
					if (JSON.stringify(scoped) !== JSON.stringify(control)) {
						divergences.push({ step: index, op: step.op, scoped, control });
					}
				}
				if (rows === 400) {
					// Nothing committed: the cold compose defines the final frame too.
					expect(painted(scopedArm).viewport).toEqual(
						await coldViewport(
							rows,
							scopedArm.entries.map(e => e.child),
						),
					);
				}
			} finally {
				await unmount(scopedArm.harness);
				await unmount(controlArm.harness);
			}

			expect(divergences).toEqual([]);
			expect(new Set(steps.map(s => s.op))).toEqual(new Set(OPS));
			// At 400 rows nothing commits, so a full frame renders every block: a reshape
			// that rendered none above its requester took the scoped path.
			if (rows === 400) expect(scopedFrames).toBe(steps.filter(s => s.op === "reshape").length);
		});
	}
});
