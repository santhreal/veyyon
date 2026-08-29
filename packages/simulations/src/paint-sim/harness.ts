import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { countDestructivePaints } from "../../../tui/test/helpers/destructive-paints";
import { settleFrames } from "../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import type { PaintFrame, PaintReport, PaintShape } from "./harness-helpers";
import { blankRun } from "./harness-helpers";

export type { ShrinkKind } from "./harness-helpers";
export { SHRINKS } from "./harness-helpers";
export type { PaintShape };

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

class LiveBlock implements Component {
	#rows: string[] = ["  reply: still arriving"];
	#settled = false;
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  row ${this.#rows.length} of the answer`];
	}
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

/** Drive one shape and report what the engine wrote. */
export async function paintSim(shape: PaintShape): Promise<PaintReport> {
	await theme();
	const term = new VirtualTerminal(shape.width, shape.height, 20_000);
	const paints = countDestructivePaints(term);
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(shape.scrollbackRebuild);

	if (shape.headerRows > 0) {
		tui.addChild(new Block(Array.from({ length: shape.headerRows }, (_, row) => `header ${row}`)));
	}
	const transcript = shape.virtualized ? new TranscriptContainer() : new Container();
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
	for (let row = shape.footerRows; row > 1; row--) tui.addChild(new FooterRow(`footer ${row}`));
	if (shape.footerRows > 0) tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(Math.max(0, shape.footerRows));
	if (anchor) {
		tui.onBeforeCompose = () => anchor.sync();
		tui.onFrameComposed = () => anchor.onFrameComposed();
	}
	tui.start();
	await settleFrames(term, tui);

	for (let turn = 0; turn < shape.turns; turn++) {
		transcript.addChild(new Block(turnText(turn)));
		tui.requestRender();
		await settleFrames(term, tui);
	}

	const redrawsAtOpen = tui.fullRedraws;
	const erasesAtOpen = paints.erases();
	const bytesAtOpen = paints.bytes();
	const frames: PaintFrame[] = [];
	let hudShrinks = 0;
	const live = new LiveBlock();
	if (shape.streamFrames > 0) transcript.addChild(live);
	for (let frame = 0; frame < shape.streamFrames; frame++) {
		const before = { redraws: tui.fullRedraws, erases: paints.erases(), bytes: paints.bytes() };
		live.grow();
		if (shape.hudRows > 0 && frame % 7 === 6) {
			const gone = frame % 14 === 6;
			hud.setRows(gone ? 0 : shape.hudRows);
			if (gone) hudShrinks++;
		}
		tui.requestRender();
		await settleFrames(term, tui);
		frames.push({
			fullRedraws: tui.fullRedraws - before.redraws,
			erases: paints.erases() - before.erases,
			bytes: paints.bytes() - before.bytes,
		});
	}

	const beforeShrink = { redraws: tui.fullRedraws, erases: paints.erases() };
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
	tui.requestRender();
	await settleFrames(term, tui);

	const viewport = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
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
		erases: paints.erases() - erasesAtOpen,
		bytes: paints.bytes() - bytesAtOpen,
		lostTurns,
		scrollTapeRows: tui.scrollTapeRows,
		hudShrinks,
		viewport,
		blankBand: blankRun(viewport),
		contentBlankRun: blankRun(scrolledOff),
		historyRowsOnScreen,
		shrinkRedraws: tui.fullRedraws - beforeShrink.redraws,
		shrinkErases: paints.erases() - beforeShrink.erases,
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
