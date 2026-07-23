import { Spacer, type TUI } from "@veyyon/tui";

/**
 * The slice of the host the home-screen anchor needs. The layout never walks
 * the session or the transcript's contents; it only needs to know whether a
 * real conversation turn exists and whether the welcome hero is up.
 */
export interface HomeAnchorPort {
	ui: TUI;
	/** Number of mounted transcript children — a non-empty transcript is what
	 * lets the anchor latch off once the viewport fills. */
	transcriptChildCount(): number;
	/** True while the startup hero is mounted; it gets a centring share of
	 * the home-screen slack as top margin. */
	hasHero(): boolean;
}

/**
 * Owns the home-screen anchor: the flexible top/bottom fills that centre the
 * welcome hero and pin the composer to the viewport bottom until a real
 * conversation scrolls in. Extracted from interactive-mode (ARCH-2, layout
 * slice) so the god-file keeps orchestration only; every fill row on screen
 * is sized here and nowhere else.
 */
export class HomeAnchorLayout {
	/** Home-screen top margin: takes a share of the slack while the welcome
	 * card is up so the hero sits vertically centred (UI-2). Collapses to zero
	 * on dismissal or the first conversation turn. */
	readonly topFill: Spacer = new Spacer(0);
	/** Flexible spacer that pushes the composer to the viewport bottom on the
	 * home screen (empty transcript). Once a conversation fills the viewport
	 * this collapses to zero and the anchor latches off for good. */
	readonly bottomFill: Spacer = new Spacer(0);
	// True until a real conversation has grown tall enough to fill the
	// viewport. Warnings and notices in the transcript do not end the home
	// screen, so the composer stays bottom-anchored until the user actually
	// starts a conversation.
	#active = true;

	constructor(private readonly port: HomeAnchorPort) {}

	/** True while the home-screen anchor still sizes the fills. */
	get active(): boolean {
		return this.#active;
	}

	/** Rows the centring top margin currently occupies (the welcome port). */
	topFillRows(width: number): number {
		return this.topFill.render(width).length;
	}

	/**
	 * Anchor the composer to the viewport bottom on the home screen by sizing
	 * {@link bottomFill} to the slack between the rendered content and the
	 * terminal height. While the welcome card is up, a share of that slack goes
	 * to {@link topFill} so the hero sits vertically centred instead of jammed
	 * into the top-left. Only fills when the transcript is empty (the
	 * launch/home screen); once a conversation scrolls in, the composer is at
	 * the natural bottom and both fills collapse to zero. Measures only
	 * side-effect-free components (welcome, status line, shortcut bar) and
	 * treats the bordered editor as its minimum height; being off by a row is
	 * harmless.
	 */
	sync(remeasure = false): void {
		// Only anchor on the launch/home screen (an empty transcript). The anchor
		// deliberately outlives the welcome card: the first keystroke dismisses
		// the card but the composer must stay at the viewport bottom until a real
		// conversation turn scrolls in.
		if (!this.#active) {
			this.topFill.setLines(0);
			this.bottomFill.setLines(0);
			return;
		}
		const ui = this.port.ui;
		const width = ui.terminal.columns;
		const rows = ui.terminal.rows;
		const currentTopFill = this.topFill.render(width).length;
		const currentFill = this.bottomFill.render(width).length;

		// Prefer the exact composed frame height (all children, wrapping included)
		// minus our own fills. `composedFrameRows` is one frame stale, which is fine
		// for the steady-state onFrameComposed correction but wrong right after a
		// content change that has not committed yet: on the very frame a submit adds
		// the user message AND the working indicator, the stale height would reserve
		// empty-home slack on top of them and overflow, jumping the message above
		// the fold. `remeasure` (and the pre-first-render seed, when no frame exists)
		// measures the true current height directly by summing every root child
		// except our own two fills — the one accurate content measurement, so the
		// composer lands on the bottom edge on this frame, not the next.
		let contentExclFill = ui.composedFrameRows - currentFill - currentTopFill;
		if (remeasure || ui.composedFrameRows <= 0) {
			let total = 0;
			for (const child of ui.children) {
				if (child === this.bottomFill || child === this.topFill) continue;
				try {
					total += child.render(width).length;
				} catch {
					total += 1;
				}
			}
			contentExclFill = total;
		}

		const slack = Math.max(0, rows - contentExclFill);
		// Latch the anchor off for good once a real conversation has grown tall
		// enough to fill the viewport. Past that point output scrolls into native
		// scrollback (composedFrameRows can then shrink again), and re-anchoring
		// would bounce the composer back up mid-stream. The home screen itself (an
		// empty transcript) never latches off, even on a terminal so short the hero
		// alone fills it — there is no conversation to scroll yet.
		if (slack <= 0 && this.port.transcriptChildCount() > 0) {
			this.#active = false;
			if (currentTopFill !== 0) this.topFill.setLines(0);
			if (currentFill !== 0) this.bottomFill.setLines(0);
			return;
		}
		// Slack routing is the whole design:
		// - Hero up: 2/5 above the hero (optically centred), the rest below so
		//   the composer sits on the viewport bottom.
		// - Empty transcript, no hero: all slack below — composer pinned to the
		//   viewport bottom while the screen is at rest.
		// - Conversation started: ALL slack ABOVE the transcript, so the
		//   conversation hugs the composer at the bottom like any chat surface.
		//   The old between-content fill painted the prompt at the top and the
		//   loader at the bottom with a void of blank rows between them; when
		//   the reply landed, those committed blank rows overflowed the screen
		//   and pushed the prompt into scrollback while the viewport was mostly
		//   empty (user screenshots, 2026-07-22).
		const conversation = this.port.transcriptChildCount() > 0;
		const top = this.port.hasHero() ? Math.floor((slack * 2) / 5) : conversation ? slack : 0;
		if (top !== currentTopFill) this.topFill.setLines(top);
		if (slack - top !== currentFill) this.bottomFill.setLines(slack - top);
	}

	/**
	 * Home-screen anchor self-correction, wired to the TUI's frame-composed
	 * hook: content mounted or resized after the fill was seeded (e.g. the
	 * async MCP status line) would otherwise leave the composer drifting off
	 * the viewport bottom until the next resize. Requests a render only when a
	 * fill actually changed, so the steady state costs nothing.
	 */
	onFrameComposed(): void {
		if (!this.#active) return;
		const width = this.port.ui.terminal.columns;
		const before = this.topFill.render(width).length + this.bottomFill.render(width).length;
		this.sync();
		const after = this.topFill.render(width).length + this.bottomFill.render(width).length;
		if (after !== before) this.port.ui.requestRender();
	}

	/**
	 * Layout half of hero dismissal (the welcome controller reports
	 * `removedRows`). The centring top margin goes with the card; the bottom
	 * anchor resizes against the removed rows so the composer stays pinned to
	 * the viewport bottom on this very frame, not the next.
	 */
	onHeroDismissed(_removedRows: number): void {
		// Direct remeasure: the hero is already unmounted, so summing the live
		// children is exact on this frame, and sync() routes the slack per the
		// current state (all-below at rest, all-above once a conversation
		// exists) instead of hardcoding the composer-pinned distribution here.
		this.topFill.setLines(0);
		this.sync(true);
		this.port.ui.requestRender();
	}
}
