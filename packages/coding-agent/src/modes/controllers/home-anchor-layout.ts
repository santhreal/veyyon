import { Spacer, type TUI } from "@veyyon/tui";

export interface HomeAnchorPort {
	ui: TUI;
	transcriptChildCount(): number;
	hasHero(): boolean;
}

export class HomeAnchorLayout {
	readonly topFill: Spacer = new Spacer(0);
	readonly bottomFill: Spacer = new Spacer(0);

	constructor(private readonly port: HomeAnchorPort) {}

	topFillRows(width: number): number {
		return this.topFill.render(width).length;
	}

	sync(remeasure = false): void {
		const ui = this.port.ui;
		const width = ui.terminal.columns;
		const rows = ui.terminal.rows;
		const currentTopFill = this.topFill.render(width).length;
		const currentFill = this.bottomFill.render(width).length;

		let contentExclFill = ui.composedFrameRows - currentFill - currentTopFill;
		if (remeasure || ui.composedFrameRows <= 0) {
			contentExclFill = this.#measureContent(width);
		} else if (contentExclFill < rows) {
			contentExclFill = Math.max(contentExclFill, this.#measureContent(width));
		}

		const slack = Math.max(0, rows - contentExclFill);
		const conversation = this.port.transcriptChildCount() > 0;
		const top = this.port.hasHero() ? Math.floor((slack * 2) / 5) : conversation ? slack : 0;
		if (top !== currentTopFill) this.topFill.setLines(top);
		if (slack - top !== currentFill) this.bottomFill.setLines(slack - top);
	}

	#measureContent(width: number): number {
		let total = 0;
		for (const child of this.port.ui.children) {
			if (child === this.bottomFill || child === this.topFill) continue;
			try {
				total += child.render(width).length;
			} catch {
				total += 1;
			}
		}
		return total;
	}

	seedAfterMount(): void {
		this.sync(true);
	}

	onFrameComposed(): void {
		const width = this.port.ui.terminal.columns;
		const beforeTop = this.topFill.render(width).length;
		const beforeBottom = this.bottomFill.render(width).length;
		this.sync();
		const changed =
			this.topFill.render(width).length !== beforeTop || this.bottomFill.render(width).length !== beforeBottom;
		if (changed) this.port.ui.requestRender();
	}

	onHeroDismissed(_removedRows: number): void {
		this.topFill.setLines(0);
		this.sync(true);
		this.port.ui.requestRender();
	}
}
