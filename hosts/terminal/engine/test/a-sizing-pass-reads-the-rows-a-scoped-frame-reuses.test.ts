/**
 * A sizing pass reads the rows a component-scoped frame reuses instead of rendering for them.
 *
 * WHY. `TUI.onBeforeCompose` sizes a layout from its siblings' heights before the frame renders
 * them. A component-scoped frame reuses the previous rows of every root child outside the
 * requested subtrees, so a sizing pass that measured those children by rendering them did work
 * the compose then skipped: every streamed chunk rendered the whole composer zone once for a
 * height the engine already held. `TUI.reusedRows` answers with the rows the compose keeps.
 *
 * THE INVARIANT, checked on every composed frame of every arm: `reusedRows(child)` is defined
 * exactly when the compose that follows does not render `child`, and then equals the rows `child`
 * holds in that frame. A defined answer for a child the compose renders is a height the frame may
 * not have; an undefined answer for a child it reuses is the render this exists to skip. Each arm
 * also pins which root children its first frame reuses, so an engine that answered undefined
 * everywhere passes nothing.
 *
 * WHAT IT DOES NOT CATCH. The resize paths (the multiplexer debounce and the drag viewport fast
 * path) run on a real settle timer and are not driven here; `#canReuseComposedLayout` sends both
 * to a full compose through the width and height checks this suite does not reach. Nor a root
 * child that changes its rows without requesting a render, which breaks the compositor's own
 * reuse in the same way.
 */
import { describe, expect, it } from "bun:test";
import { type Component, Container, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

interface Counted extends Component {
	readonly name: string;
	renders: number;
}

class Lines implements Counted {
	renders = 0;
	readonly name: string;
	lines: string[];

	constructor(name: string, lines: string[]) {
		this.name = name;
		this.lines = lines;
	}

	invalidate(): void {}

	render(): readonly string[] {
		this.renders++;
		return this.lines;
	}
}

class Transcript extends Container implements Counted {
	readonly name = "transcript";
	renders = 0;

	override render(width: number): readonly string[] {
		this.renders++;
		return super.render(width);
	}
}

/** One composed frame: the sizing pass's answer per root child, and what the compose rendered. */
interface Frame {
	reused: Record<string, number | undefined>;
	rendered: string[];
	rows: Record<string, number>;
}

interface Harness {
	term: VirtualTerminal;
	scheduler: StressRenderScheduler;
	tui: TUI;
	answer: Lines;
	status: Lines;
	composer: Lines;
	frames: Frame[];
	/** Runs at the top of the next sizing pass, before the answers are read. */
	duringSizing?: () => void;
}

const WIDTH = 40;

async function start(): Promise<Harness> {
	const term = new VirtualTerminal(WIDTH, 12, 1_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const transcript = new Transcript();
	const answer = new Lines("answer", ["a-0"]);
	transcript.addChild(answer);
	const status = new Lines("status", ["working"]);
	const composer = new Lines("composer", ["> ", "hint"]);
	tui.addChild(transcript);
	tui.addChild(status);
	tui.addChild(composer);

	const harness: Harness = { term, scheduler, tui, answer, status, composer, frames: [] };
	const roots = () => tui.children as Counted[];
	let reused: Record<string, number | undefined> = {};
	let before = new Map<Counted, number>();
	tui.onBeforeCompose = () => {
		harness.duringSizing?.();
		reused = {};
		for (const child of roots()) reused[child.name] = tui.reusedRows(child);
		before = new Map(roots().map(child => [child, child.renders]));
	};
	tui.onFrameComposed = () => {
		const rendered = roots()
			.filter(child => child.renders !== before.get(child))
			.map(child => child.name);
		const rows = Object.fromEntries(roots().map(child => [child.name, child.render(WIDTH).length]));
		harness.frames.push({ reused, rendered, rows });
	};
	tui.start();
	await scheduler.drain(term);
	return harness;
}

/** Every root child whose answer breaks the invariant, with the frame's view of it. */
function violations(frames: Frame[]) {
	return frames.flatMap((frame, index) =>
		Object.entries(frame.reused)
			.filter(([name, rows]) =>
				rows === undefined
					? !frame.rendered.includes(name)
					: frame.rendered.includes(name) || rows !== frame.rows[name],
			)
			.map(([name, rows]) => ({ frame: index, name, reused: rows, rendered: frame.rendered.includes(name) })),
	);
}

/** A streamed chunk: the answer grows a row and requests a repaint of itself alone. */
function chunk(h: Harness): void {
	h.answer.lines = [...h.answer.lines, `a-${h.answer.lines.length}`];
	h.tui.requestComponentRender(h.answer);
}

interface Arm {
	setup?: (h: Harness) => void;
	act: (h: Harness) => void;
	/** Root children the first frame after `act` reuses, sorted. */
	reused: string[];
}

const ARMS: Record<string, Arm> = {
	"a streamed chunk": { act: chunk, reused: ["composer", "status"] },
	"a streamed chunk and a status tick": {
		act: h => {
			chunk(h);
			h.status.lines = ["working."];
			h.tui.requestComponentRender(h.status);
		},
		reused: ["composer"],
	},
	"a streamed chunk beside a full request": {
		act: h => {
			chunk(h);
			h.tui.requestRender();
		},
		reused: [],
	},
	"a streamed chunk while an overlay is up": {
		setup: h => {
			h.tui.showOverlay(new Lines("modal", ["modal"]), { width: 10 });
		},
		act: chunk,
		reused: [],
	},
	"a streamed chunk after a root child mounted": {
		act: h => {
			chunk(h);
			h.tui.addChild(new Lines("late", ["late"]));
		},
		reused: [],
	},
	"a streamed chunk beside a layout-sized sibling": {
		setup: h => h.tui.markLayoutSized(h.composer),
		act: chunk,
		reused: ["status"],
	},
	"a full request made after the sizing pass first asked": {
		act: h => {
			chunk(h);
			h.duringSizing = () => {
				h.duringSizing = undefined;
				h.tui.reusedRows(h.composer);
				h.tui.requestRender();
			};
		},
		reused: [],
	},
	"a status tick requested after the sizing pass first asked": {
		act: h => {
			chunk(h);
			h.duringSizing = () => {
				h.duringSizing = undefined;
				h.tui.reusedRows(h.composer);
				h.status.lines = ["working."];
				h.tui.requestComponentRender(h.status);
			};
		},
		reused: ["composer"],
	},
};

describe("TUI.reusedRows", () => {
	for (const [name, arm] of Object.entries(ARMS)) {
		it(`answers for exactly the root children the frame reuses: ${name}`, async () => {
			const h = await start();
			try {
				arm.setup?.(h);
				await h.scheduler.drain(h.term);
				const seeded = h.frames.length;
				arm.act(h);
				await h.scheduler.drain(h.term);

				const first = h.frames[seeded];
				const reused = Object.entries(first?.reused ?? {})
					.filter(([, rows]) => rows !== undefined)
					.map(([child]) => child)
					.sort();
				expect({ composed: first !== undefined, reused }).toEqual({ composed: true, reused: arm.reused });
				expect(violations(h.frames)).toEqual([]);
			} finally {
				h.tui.stop();
				await h.term.flush();
			}
		});
	}

	it("answers nothing outside the sizing pass", async () => {
		const h = await start();
		try {
			chunk(h);
			await h.scheduler.drain(h.term);
			expect(h.frames.at(-1)?.reused.status).toBe(1);
			// A chunk is pending, so a frame that composed now would reuse the status row; the
			// question is answered for the frame being sized, and none is.
			chunk(h);
			expect(h.tui.reusedRows(h.status)).toBeUndefined();
			await h.scheduler.drain(h.term);
			expect(h.frames.at(-1)?.reused.status).toBe(1);
		} finally {
			h.tui.stop();
			await h.term.flush();
		}
	});
});
