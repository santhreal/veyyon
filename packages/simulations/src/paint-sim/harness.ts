/**
 * Deterministic, offline paint simulations.
 *
 * The render engine is the one subsystem that had no simulation, and it is the
 * subsystem whose defects reach the operator first: a screen that flickers, a
 * transcript that blanks, a band of blank rows where history should be. Those
 * were being chased by hand each time — a bespoke rig per investigation, each
 * one drawing the component tree slightly differently, so two investigations
 * could not be compared and none of them survived into the repo.
 *
 * This family is that rig, once, with the shape as data. It drives the real
 * engine and the real virtualized transcript:
 *
 *   TUI -> Container children (header, TranscriptContainer, HUD, pinned footer)
 *     -> compose -> commit-prefix audit -> frame classification -> emit
 *     -> VirtualTerminal (a real terminal state machine, not a spy)
 *
 * What it measures per frame is what a reader would see go wrong: whether the
 * engine took a WHOLE-SCREEN repaint, whether it ERASED native scrollback
 * (ED3), how many bytes and rows it wrote, and whether any earlier turn stopped
 * being in the terminal's buffer.
 *
 * Determinism rules this file exists to enforce:
 *  - No wall-clock sleeps. Frames advance through `settleFrames`, which drains
 *    the engine's own scheduling until it stops asking to render.
 *  - No animation clock. Motion is a repaint SOURCE, not a paint decision, and
 *    a simulation that let a 60 Hz spring run would measure the clock's rate
 *    instead of the engine's classification.
 *  - Nothing is mocked below the terminal. `VirtualTerminal` parses the escape
 *    sequences the engine actually writes, so a claim about scrollback is a
 *    claim about bytes.
 */
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

/** The screen a scenario is asking about. Every field is a shipped shape. */
export interface PaintShape {
	width: number;
	height: number;
	/**
	 * Rows of a root child mounted ABOVE the transcript. The shipped layout
	 * always has some: `home-anchor-layout` routes viewport slack into `topFill`
	 * whenever a conversation exists.
	 */
	headerRows: number;
	/**
	 * Rows of a root child mounted BELOW the transcript and above the footer —
	 * the todo and subagent HUDs, which appear and disappear mid-turn.
	 */
	hudRows: number;
	/** Pinned footer children: loader, hairline, composer, status line. */
	footerRows: number;
	/** Finalized turns written before the measurement window opens. */
	turns: number;
	/** Frames of a still-arriving answer, one row per frame, inside the window. */
	streamFrames: number;
	/** `tui.scrollbackRebuild`: whether a divergence repair is destructive. */
	scrollbackRebuild: boolean;
	/** False mounts a plain `Container`, the control that drops no rows. */
	virtualized: boolean;
	/**
	 * Mounts the real `HomeAnchorLayout` fills around the transcript and drives
	 * its frame-composed correction, which is how the shipped screen decides
	 * where viewport slack goes. False leaves them out, the control that invents
	 * no rows.
	 */
	homeAnchor: boolean;
	/**
	 * What makes the frame SHRINK after the stream, which is when a screen ends
	 * up shorter than the viewport in a session that has already scrolled. Each
	 * kind is a shipped event; see `SHRINKS`.
	 */
	shrink: ShrinkKind;
}

export interface PaintFrame {
	/** Whole-screen repaints the engine took on this frame. */
	fullRedraws: number;
	/** Native-scrollback erases (ED3) written on this frame. */
	erases: number;
	/** Bytes written on this frame. */
	bytes: number;
}

export interface PaintReport {
	/** One entry per frame of the measurement window, in order. */
	frames: PaintFrame[];
	/** Whole-screen repaints across the window. Steady state is 0. */
	fullRedraws: number;
	/** ED3 erases across the window. Steady state is 0. */
	erases: number;
	/** Bytes across the window. */
	bytes: number;
	/** Turns whose text is no longer anywhere in the terminal's buffer. */
	lostTurns: number[];
	/** Rows the engine believes it has handed to native scrollback. */
	scrollTapeRows: number;
	/**
	 * Times THIS scenario shrank the HUD, counted from the script rather than
	 * from the engine, so a test comparing repaints against it is not comparing
	 * the engine to itself. A frame that gets shorter has to move every row on
	 * screen, so it costs one in-place window rewrite; nothing else may.
	 */
	hudShrinks: number;
	/**
	 * The viewport after the shrink, ANSI stripped and right-trimmed: what a
	 * reader is looking at when the screen settles.
	 */
	viewport: string[];
	/** Longest run of consecutive blank rows in that viewport. */
	blankBand: number;
	/**
	 * Longest run of blank rows in the painted content itself (the tape plus the
	 * composed frame). The bound a blank band is judged against is derived from
	 * what was painted, so nobody can tune a constant to make a void acceptable.
	 */
	contentBlankRun: number;
	/** Rows of real conversation on screen after the shrink. */
	historyRowsOnScreen: number;
	/** Whole-screen repaints and erases charged to the shrink frame alone. */
	shrinkRedraws: number;
	shrinkErases: number;
	/** Where the anchor put the slack on the settled frame. */
	topFillRows: number;
	bottomFillRows: number;
}

/**
 * The shipped ways a settled screen ends up SHORTER than the viewport partway
 * through a session that has already scrolled. Every one of them is an ordinary
 * end-of-turn event, which is why the blank band they used to leave was a screen
 * the operator saw rather than an edge case:
 *
 *  - `answer-collapse`: the tall streaming answer finishes and its final render
 *    is a few rows (a fence, a rule) instead of the dozens it streamed.
 *  - `hud-collapse`: the todo board or the subagent tree finishes and unmounts.
 *
 * `none` is the control: the same session with nothing shrinking.
 *
 * A window dragged TALLER shrinks the frame the same way and is deliberately not
 * here: the resize path paints the viewport at once and defers the authoritative
 * replay past a 120 ms settle window of real wall-clock time, and a family whose
 * first rule is "no wall-clock sleeps" cannot ask that question without measuring
 * the timer instead of the engine. It is asked where resize already lives, with
 * the sleep those suites use.
 */
export type ShrinkKind = "none" | "answer-collapse" | "hud-collapse";

export const SHRINKS: readonly ShrinkKind[] = ["none", "answer-collapse", "hud-collapse"];

/** Longest run of consecutive blank rows in `rows`. */
export function blankRun(rows: readonly string[]): number {
	let run = 0;
	let longest = 0;
	for (const row of rows) {
		run = row.trim().length === 0 ? run + 1 : 0;
		if (run > longest) longest = run;
	}
	return longest;
}

/** A finalized block: plain components are final, so their rows commit. */
class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/**
 * An answer still arriving. It grows a row a frame and declares itself
 * unfinalized while it does, which is what the shipped streaming block does and
 * what keeps its still-changing rows out of native scrollback: a block that
 * declares nothing counts as final (see `isBlockFinalized`), so its streamed
 * rows commit and rewriting them later reads as history diverging.
 */
class LiveBlock implements Component {
	#rows: string[] = ["  reply: still arriving"];
	#settled = false;
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  row ${this.#rows.length} of the answer`];
	}
	/**
	 * The turn ends and the answer's final render is short: a closing fence and a
	 * rule, which is what the streamed rows collapse to once the markdown settles.
	 */
	settle(): void {
		this.#rows = ["```", "—"];
		this.#settled = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.#settled;
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return [...this.#rows];
	}
}

/** A HUD that changes height while a turn runs, the way the todo list does. */
class Hud implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	setRows(rows: number): void {
		this.#rows = rows;
	}
	render(): string[] {
		return Array.from({ length: this.#rows }, (_, row) => `  hud row ${row}`);
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

class FooterRow implements Component {
	constructor(private readonly text: string) {}
	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
}

let themeReady: Promise<void> | undefined;
/** The theme is process-global and idempotent; every scenario shares one init. */
function theme(): Promise<void> {
	themeReady ??= initTheme(false, "unicode", false, "titanium", "dark").then(() => undefined);
	return themeReady;
}

const turnText = (turn: number): string[] => [
	`> turn ${turn}: what changed?`,
	"",
	`  reply ${turn}: the engine committed these rows and the transcript dropped them.`,
	"",
];

/**
 * Drive one shape and report what the engine wrote.
 *
 * The measurement window opens AFTER the lead turns, so a scenario is asking
 * about steady state rather than about the first paint: the startup repaint is
 * legitimate and is never counted.
 */
export async function paintSim(shape: PaintShape): Promise<PaintReport> {
	await theme();
	const term = new VirtualTerminal(shape.width, shape.height, 20_000);
	let erases = 0;
	let bytes = 0;
	const write = term.write.bind(term);
	term.write = (data: string) => {
		if (data.includes("\x1b[3J")) erases++;
		bytes += data.length;
		write(data);
	};
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(shape.scrollbackRebuild);

	if (shape.headerRows > 0) {
		tui.addChild(new Block(Array.from({ length: shape.headerRows }, (_, row) => `header ${row}`)));
	}
	const transcript = shape.virtualized ? new TranscriptContainer() : new Container();
	// Shipped root order: the centring fill, the transcript, the HUD band, the
	// bottom fill, then the pinned footer (interactive-mode mounts them in
	// exactly this order).
	const anchor = shape.homeAnchor
		? new HomeAnchorLayout({
				ui: tui,
				transcriptChildCount: () => transcript.children.length,
				hasHero: () => false,
			})
		: undefined;
	if (anchor) tui.addChild(anchor.topFill);
	tui.addChild(transcript);
	const hud = new Hud(shape.hudRows);
	if (shape.hudRows > 0) tui.addChild(hud);
	if (anchor) tui.addChild(anchor.bottomFill);
	// The footer is built from the bottom up the way the composer zone is: a
	// status row, a composer that owns the cursor, and filler rows above it.
	for (let row = shape.footerRows; row > 1; row--) tui.addChild(new FooterRow(`footer ${row}`));
	if (shape.footerRows > 0) tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(Math.max(0, shape.footerRows));
	if (anchor) tui.onFrameComposed = () => anchor.onFrameComposed();
	tui.start();
	await settleFrames(term, tui);

	for (let turn = 0; turn < shape.turns; turn++) {
		transcript.addChild(new Block(turnText(turn)));
		tui.requestRender();
		await settleFrames(term, tui);
	}

	// The window opens here: everything above is the session getting long.
	const redrawsAtOpen = tui.fullRedraws;
	const erasesAtOpen = erases;
	const bytesAtOpen = bytes;
	const frames: PaintFrame[] = [];
	let hudShrinks = 0;
	const live = new LiveBlock();
	if (shape.streamFrames > 0) transcript.addChild(live);
	for (let frame = 0; frame < shape.streamFrames; frame++) {
		const before = { redraws: tui.fullRedraws, erases, bytes };
		live.grow();
		// A HUD that appears and disappears is the other thing that moves every
		// row under it, and it is what a running job or a todo list does.
		if (shape.hudRows > 0 && frame % 7 === 6) {
			const gone = frame % 14 === 6;
			hud.setRows(gone ? 0 : shape.hudRows);
			if (gone) hudShrinks++;
		}
		tui.requestRender();
		await settleFrames(term, tui);
		frames.push({
			fullRedraws: tui.fullRedraws - before.redraws,
			erases: erases - before.erases,
			bytes: bytes - before.bytes,
		});
	}

	// The turn ends. Whatever the shape names shrinks the frame, and the screen is
	// then measured where a reader looks: the viewport.
	const beforeShrink = { redraws: tui.fullRedraws, erases };
	switch (shape.shrink) {
		case "answer-collapse":
			live.settle();
			break;
		case "hud-collapse":
			hud.setRows(0);
			break;
		case "none":
			break;
	}
	tui.requestRender();
	await settleFrames(term, tui);
	// A second settle: the anchor corrects on the frame-composed hook, so its
	// answer only reaches the screen on the following frame.
	tui.requestRender();
	await settleFrames(term, tui);

	const viewport = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	// History that has already scrolled off: rows the engine painted while the
	// frame still filled the screen. Its own blank runs (block separators) are the
	// only blank runs the transcript legitimately produces, so they are the bound
	// a blank band on screen is judged against — measured, never chosen.
	const scrolledOff = buffer.slice(0, Math.max(0, buffer.length - viewport.length));
	const historyRowsOnScreen = viewport.filter(row => /turn \d+:|reply \d+:|row \d+ of the answer/.test(row)).length;

	const history = buffer.filter(row => row.length > 0);
	const lostTurns: number[] = [];
	for (let turn = 0; turn < shape.turns; turn++) {
		if (!history.some(row => row.includes(`turn ${turn}:`))) lostTurns.push(turn);
	}

	return {
		frames,
		fullRedraws: tui.fullRedraws - redrawsAtOpen,
		erases: erases - erasesAtOpen,
		bytes: bytes - bytesAtOpen,
		lostTurns,
		scrollTapeRows: tui.scrollTapeRows,
		hudShrinks,
		viewport,
		blankBand: blankRun(viewport),
		contentBlankRun: blankRun(scrolledOff),
		historyRowsOnScreen,
		shrinkRedraws: tui.fullRedraws - beforeShrink.redraws,
		shrinkErases: erases - beforeShrink.erases,
		topFillRows: anchor ? anchor.topFill.render(shape.width).length : 0,
		bottomFillRows: anchor ? anchor.bottomFill.render(shape.width).length : 0,
	};
}

/** Every combination of the fields a scenario sweeps, as a flat list. */
export function shapes(base: PaintShape, sweep: Partial<Record<keyof PaintShape, readonly number[]>>): PaintShape[] {
	let out: PaintShape[] = [base];
	for (const [field, values] of Object.entries(sweep) as Array<[keyof PaintShape, readonly number[]]>) {
		out = out.flatMap(shape => values.map(value => ({ ...shape, [field]: value })));
	}
	return out;
}

/** A one-line shape label, for a failure message that names the arm. */
export function label(shape: PaintShape): string {
	return `${shape.width}x${shape.height} header=${shape.headerRows} hud=${shape.hudRows} footer=${shape.footerRows} turns=${shape.turns} stream=${shape.streamFrames} rebuild=${shape.scrollbackRebuild} virtualized=${shape.virtualized} anchor=${shape.homeAnchor} shrink=${shape.shrink}`;
}
