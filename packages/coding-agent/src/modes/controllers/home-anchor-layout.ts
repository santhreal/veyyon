import { Spacer, type TUI } from "@veyyon/tui";

/** The slice of the host the home-screen anchor needs. The layout never walks the session or the transcript's contents; it only needs to know whether a */
export interface HomeAnchorPort {
	ui: TUI;
	/** Number of mounted transcript children — a non-empty transcript is what
	 * lets the anchor latch off once the viewport fills. */
	transcriptChildCount(): number;
	/** True while the startup hero is mounted; it gets a centring share of
	 * the home-screen slack as top margin. */
	hasHero(): boolean;
}

/** Owns the home-screen anchor: the flexible top/bottom fills that centre the welcome hero and pin the composer to the viewport bottom until a real */
export class HomeAnchorLayout {
	/** Home-screen top margin: takes a share of the slack while the welcome
	 * card is up so the hero sits vertically centred (UI-2). Collapses to zero
	 * on dismissal or the first conversation turn. */
	readonly topFill: Spacer = new Spacer(0);
	/** Flexible spacer between the transcript and the composer on the home screen (empty transcript), pinning the composer to the viewport bottom */
	readonly bottomFill: Spacer = new Spacer(0);

	constructor(private readonly port: HomeAnchorPort) {}

	/** Rows the centring top margin currently occupies (the welcome port). */
	topFillRows(width: number): number {
		return this.topFill.render(width).length;
	}

	/** Anchor the composer to the viewport bottom on the home screen by sizing {@link bottomFill} to the slack between the rendered content and the */
	sync(remeasure = false): void {
		// The anchor deliberately outlives the welcome card: the first keystroke
		// dismisses the card but the composer must stay at the viewport bottom
		// in every conversation state, so the fills are recomputed every frame.
		const ui = this.port.ui;
		const width = ui.terminal.columns;
		const rows = ui.terminal.rows;
		const currentTopFill = this.topFill.render(width).length;
		const currentFill = this.bottomFill.render(width).length;

		// Prefer the exact composed frame height (all children, wrapping included) minus our own fills. `composedFrameRows` is one frame stale, which is fine
		let contentExclFill = ui.composedFrameRows - currentFill - currentTopFill;
		if (remeasure || ui.composedFrameRows <= 0) {
			contentExclFill = this.#measureContent(width);
		} else if (contentExclFill < rows) {
			// The composed frame is one frame old. While it still accounts for more content than the viewport holds, slack is zero either way and
			contentExclFill = Math.max(contentExclFill, this.#measureContent(width));
		}

		const slack = Math.max(0, rows - contentExclFill);
		// Slack is empty room, and it is only ever empty room because the frame is never shorter than the window once history exists: the transcript keeps a
		const conversation = this.port.transcriptChildCount() > 0;
		const top = this.port.hasHero() ? Math.floor((slack * 2) / 5) : conversation ? slack : 0;
		if (top !== currentTopFill) this.topFill.setLines(top);
		if (slack - top !== currentFill) this.bottomFill.setLines(slack - top);
	}

	/** Content height from the live children, excluding this layout's own fills. Approximate where the composed frame is exact — it does not account for */
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

	/** Seed the anchor on the frame the composer zone mounts. Always remeasures, and the mount path must go through here rather than a */
	seedAfterMount(): void {
		this.sync(true);
	}

	/** Home-screen anchor self-correction, wired to the TUI's frame-composed hook: content mounted or resized after the fill was seeded (e.g. the */
	onFrameComposed(): void {
		const width = this.port.ui.terminal.columns;
		const beforeTop = this.topFill.render(width).length;
		const beforeBottom = this.bottomFill.render(width).length;
		this.sync();
		// Both fills are compared, not their sum: the frame a conversation
		// starts on moves the whole slack from the bottom fill to the top one,
		// which leaves the sum identical and the screen completely rearranged.
		const changed =
			this.topFill.render(width).length !== beforeTop || this.bottomFill.render(width).length !== beforeBottom;
		if (changed) this.port.ui.requestRender();
	}

	/** Layout half of hero dismissal (the welcome controller reports `removedRows`). The centring top margin goes with the card; the bottom */
	onHeroDismissed(_removedRows: number): void {
		// Direct remeasure: the hero is already unmounted, so summing the live children is exact on this frame, and sync() routes the slack per the
		this.topFill.setLines(0);
		this.sync(true);
		this.port.ui.requestRender();
	}
}
