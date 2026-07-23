import { type Container, Spacer, type TUI } from "@veyyon/tui";
import { type RecentSession, WelcomeComponent } from "../components/welcome";

/** Data the welcome hero renders. The controller never reaches into the
 * session itself; the host resolves model/recents and hands them over. */
export interface WelcomeHeroInputs {
	version: string;
	/** Empty (not "Unknown") when no model is configured, so the card renders
	 * a "/login" call to action instead of a dead "Unknown · Unknown". */
	modelName: string;
	providerName: string;
	recentSessions: RecentSession[];
}

/**
 * The slice of interactive-mode layout the welcome lane needs. The fill math
 * (top/bottom anchors, home-screen slack) stays with its one owner in
 * interactive-mode; the controller only reports what it added or removed.
 */
export interface WelcomeLayoutPort {
	ui: TUI;
	/** Transcript container the full `/welcome` card mounts into. */
	chatContainer: Container;
	/** Rows the hero's centring top margin currently occupies. */
	topFillRows(width: number): number;
	/** Re-anchor after the hero (card + spacers + top margin, `removedRows`
	 * total) left the tree — the host zeroes the top fill and resizes the
	 * bottom fill on THIS frame, then requests a render. */
	onHeroDismissed(removedRows: number): void;
	/** Remeasure the bottom anchor after the full card mounts mid-transcript. */
	remeasureAnchor(): void;
}

/**
 * Owns the startup welcome hero and the full `/welcome` card: mounting,
 * the intro bloom, and dismissal. Extracted from interactive-mode (ARCH-2)
 * so the god-file keeps only orchestration and the layout math it owns.
 */
export class WelcomeController {
	#component: WelcomeComponent | undefined;
	/** The hero card's surrounding spacers, kept so dismissal removes the
	 *  whole block and leaves no blank rows behind. */
	#spacers: Spacer[] = [];

	constructor(private readonly port: WelcomeLayoutPort) {}

	/** True while the startup hero is mounted — the layout gives it a share
	 * of the home-screen slack as top margin while this holds. */
	get hasHero(): boolean {
		return this.#component !== undefined;
	}

	/** Mount the startup hero (spacer · card · spacer) at the top of the UI
	 * tree. The host adds its centring top fill first; ordering matters. */
	mountHero(inputs: WelcomeHeroInputs, options: { playIntro: boolean }): void {
		this.#component = new WelcomeComponent(
			inputs.version,
			inputs.modelName,
			inputs.providerName,
			inputs.recentSessions,
		);
		this.#spacers = [new Spacer(1), new Spacer(1)];
		this.port.ui.addChild(this.#spacers[0] as Spacer);
		this.port.ui.addChild(this.#component);
		this.port.ui.addChild(this.#spacers[1] as Spacer);
		if (options.playIntro) this.playIntro();
	}

	/** Play the launch bloom. Component-scoped: the intro only mutates the
	 * welcome box's own rows, so a resumed long transcript is not re-walked
	 * per animation frame. */
	playIntro(): void {
		const welcome = this.#component;
		welcome?.playIntro(() => this.port.ui.requestComponentRender(welcome));
	}

	/** Remove the startup hero (and its spacers) — the first real keystroke
	 * ends the hero moment. Idempotent. Reports the removed row count
	 * (card + spacers + the host's top margin) so the host can keep the
	 * composer pinned to the viewport bottom on this very frame. */
	dismiss(): void {
		const welcome = this.#component;
		if (!welcome) return;
		this.#component = undefined;
		welcome.stopIntro();
		const width = this.port.ui.terminal.columns;
		// The host's anchor measures via the last composed frame, which still
		// includes the card — report the removed rows explicitly so the fill
		// math corrects on this frame, not the next.
		const removedRows = welcome.render(width).length + this.#spacers.length + this.port.topFillRows(width);
		for (const spacer of this.#spacers) this.port.ui.removeChild(spacer);
		this.#spacers = [];
		this.port.ui.removeChild(welcome);
		this.port.onHeroDismissed(removedRows);
	}

	/** Append the full welcome card (sun, action menu, recents) to the
	 * transcript — `/welcome`. Supersedes the home hero: leaving both mounted
	 * painted two suns and, with the home-anchor slack still sized for an
	 * empty transcript, pushed the fresh card clean off the top of the
	 * viewport (live capture 2026-07-22: /welcome showed a blank screen). */
	showFull(inputs: WelcomeHeroInputs): void {
		const welcome = new WelcomeComponent(
			inputs.version,
			inputs.modelName,
			inputs.providerName,
			inputs.recentSessions,
			[],
			true,
		);
		this.dismiss();
		this.port.chatContainer.addChild(new Spacer(1));
		this.port.chatContainer.addChild(welcome);
		this.port.chatContainer.addChild(new Spacer(1));
		// Remeasure so the anchor accounts for the card on THIS frame.
		this.port.remeasureAnchor();
		welcome.playIntro(() => this.port.ui.requestComponentRender(welcome));
	}
}
