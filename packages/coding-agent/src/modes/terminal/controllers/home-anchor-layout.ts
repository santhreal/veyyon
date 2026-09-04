import { Spacer } from "@veyyon/tui/components/spacer";
import type { TUI } from "@veyyon/tui/tui";

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
 * A child that reports the height of its bottom `maxRows` rows without
 * advancing the render protocol the engine drives against it — the shape
 * `TranscriptContainer.renderViewportTail` implements. Probed structurally, the
 * way the engine probes the native-scrollback protocol, so the anchor stays
 * ignorant of what the transcript is.
 */
interface BoundedMeasure {
	renderViewportTail(width: number, maxRows: number): readonly string[];
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
	/** Flexible spacer between the transcript and the composer on the home
	 * screen (empty transcript), pinning the composer to the viewport bottom
	 * while the screen is at rest. Collapses to zero once a conversation
	 * routes the slack above the transcript. */
	readonly bottomFill: Spacer = new Spacer(0);

	constructor(private readonly port: HomeAnchorPort) {
		// Both fills are sized by the pass at the top of the frame that renders
		// them (`TUI.onBeforeCompose`), and neither ever requests a repaint of
		// itself. A component-scoped frame — every streamed chunk, which
		// repaints its own chat block alone — must therefore be told to render
		// them rather than reuse the rows the previous frame's content called
		// for, or the frame composes past the viewport and the engine moves the
		// window to fit.
		port.ui.markLayoutSized(this.topFill);
		port.ui.markLayoutSized(this.bottomFill);
	}

	/** Rows the centring top margin currently occupies (the welcome port). */
	topFillRows(width: number): number {
		return this.topFill.render(width).length;
	}

	/**
	 * Size the fills to the slack between the content and the terminal height,
	 * then route that slack per the current state (hero centring, at-rest bottom
	 * pin, conversation hug). Wired to {@link TUI.onBeforeCompose}, so every
	 * child it measures is a child the frame about to compose will render.
	 *
	 * The live children are the only authority. `ui.composedFrameRows` describes
	 * the PREVIOUS frame, so routing from it is wrong by however much the content
	 * moved since, in whichever direction it moved: a turn that grew (every
	 * streamed chunk) gets slack sized for rows the content has already taken and
	 * composes past the viewport, and a turn that collapsed (a tool preview
	 * closing, the working indicator retiring) gets slack sized for rows that are
	 * gone and seats the composer above the bottom edge. Both used to be repaired
	 * after the fact, by repainting the frame a second time to put the same rows
	 * in a different place — which is the shake the correction existed to fix,
	 * once per row of the answer.
	 */
	sync(): void {
		// The anchor deliberately outlives the welcome card: the first keystroke
		// dismisses the card but the composer must stay at the viewport bottom
		// in every conversation state, so the fills are recomputed every frame.
		const ui = this.port.ui;
		const width = ui.terminal.columns;
		const rows = ui.terminal.rows;
		const currentTopFill = this.topFill.render(width).length;
		const currentFill = this.bottomFill.render(width).length;
		const contentExclFill = this.#measureContent(width);

		const slack = Math.max(0, rows - contentExclFill);
		// Slack is empty room, and it is only ever empty room because the frame is
		// never shorter than the window once history exists: the transcript keeps a
		// viewport's worth of committed rows in the frame for the engine's shrink
		// repair (`NativeScrollbackCompaction.setNativeScrollbackRetainRows`). Break
		// that contract and this measurement is reading a short frame for a long
		// session, which is what wrote up to 23 blank rows over 82 rows of live
		// history when a tall streaming answer settled to a two-row tail. Guarding
		// here instead (route nothing once anything has scrolled) fixes nothing and
		// costs the hug: measured on the same session, the band simply moves below
		// the composer and strands it 18 rows off the bottom edge. The frame length
		// is the invariant; this routing is downstream of it.
		//
		// Slack routing is the whole design:
		// - Hero up: 2/5 above the hero (optically centred), the rest below so
		//   the composer sits on the viewport bottom.
		// - Empty transcript, no hero: all slack below — composer pinned to the
		//   viewport bottom while the screen is at rest.
		// - Conversation started: ALL slack ABOVE the transcript, so the
		//   conversation hugs the composer at the bottom like any chat surface.
		//
		// No latch: the routing is recomputed every frame, so a transient tall
		// frame (a streaming preview spike) followed by a collapse can never
		// strand the composer mid-screen — hug-bottom puts the composer on the
		// bottom edge whether slack is positive (fill pushes it there) or zero
		// (the frame reaches it naturally). The old between-content fill
		// painted the prompt at the top and the loader at the bottom with a
		// void of blank rows between them; when the reply landed, those
		// committed blank rows overflowed the screen and pushed the prompt
		// into scrollback while the viewport was mostly empty.
		const conversation = this.port.transcriptChildCount() > 0;
		const top = this.port.hasHero() ? Math.floor((slack * 2) / 5) : conversation ? slack : 0;
		if (top !== currentTopFill) this.topFill.setLines(top);
		if (slack - top !== currentFill) this.bottomFill.setLines(slack - top);
	}

	/**
	 * Content height from the live children, excluding this layout's own fills,
	 * saturating at the terminal height: slack is `rows - content`, so a content
	 * height past `rows` carries no more information than "the screen is full".
	 *
	 * Exact wherever a fill exists, which is the only place it is read: it is the
	 * same `render(width)` call, at the same width, over the same children the
	 * compositor concatenates, so it counts wrapping the same way.
	 *
	 * A child that offers a bounded tail measurement is measured through that
	 * instead, because its `render()` is not a pure read: `TranscriptContainer`
	 * hands the engine's committed prefix to native scrollback there, and the
	 * engine authorizes exactly one such drop per frame — the count it feeds
	 * before rendering, and reads back after. A sizing pass that called
	 * `render()` would spend that authorization on a frame of its own, and the
	 * compose render that follows would drop a second prefix against the same
	 * count, taking rows out of the screenful the frame keeps for the engine's
	 * shrink repair. Measured on the scrolled 24-row arm of the blank-band
	 * simulation: the transcript's frame went to zero rows and the conversation
	 * left the screen. `renderViewportTail` is state-isolated by contract, and
	 * equals the bottom of a full render for every block it includes — it
	 * diverges by at most the topmost separator row once the walk stops early,
	 * which is past `rows`, where the measurement has already saturated.
	 */
	#measureContent(width: number): number {
		const rows = this.port.ui.terminal.rows;
		let total = 0;
		for (const child of this.port.ui.children) {
			if (child === this.bottomFill || child === this.topFill) continue;
			try {
				const bounded = (child as Partial<BoundedMeasure>).renderViewportTail;
				total +=
					typeof bounded === "function"
						? bounded.call(child, width, Math.max(0, rows - total)).length
						: child.render(width).length;
			} catch {
				total += 1;
			}
			if (total >= rows) return total;
		}
		return total;
	}

	/**
	 * Seed the anchor on the frame the composer zone mounts.
	 *
	 * The mount path goes through here rather than a bare {@link sync} for the
	 * name: a launch card painted before this mode existed leaves a composed
	 * frame this layout did not produce, and the anchor must not be seeded from
	 * it. {@link sync} reads the live children only, so the seed is the ordinary
	 * sizing pass run one frame early.
	 */
	seedAfterMount(): void {
		this.sync();
	}

	/**
	 * Layout half of hero dismissal (the welcome controller reports
	 * `removedRows`). The centring top margin goes with the card; the bottom
	 * anchor resizes against the removed rows so the composer stays pinned to
	 * the viewport bottom on this very frame, not the next.
	 */
	onHeroDismissed(_removedRows: number): void {
		// The hero is already unmounted, so the live-children walk is exact on
		// this frame, and sync() routes the slack per the current state
		// (all-below at rest, all-above once a conversation exists) instead of
		// hardcoding the composer-pinned distribution here.
		this.topFill.setLines(0);
		this.sync();
		this.port.ui.requestRender();
	}
}
