import {
	Container,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackCompaction,
	Spacer,
	type TUI,
} from "@veyyon/tui";
import { type RecentSession, WelcomeComponent } from "../components/dialogs/welcome";

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
 * The startup hero's place in the root tree: spacer, card, spacer.
 *
 * Dismissal empties the slot. The rows the engine already committed to native
 * scrollback leave the frame through the drop report of
 * `NativeScrollbackCompaction`, so the engine moves its commit index past rows
 * the terminal still holds. A resumed session renders its transcript under the
 * card, which scrolls the card into history before the first keystroke
 * dismisses it. Without the report the card's rows vanish from the front of the
 * committed prefix, the engine reads that as diverged history, and it erases
 * native scrollback and replays the whole transcript, rendering every block of
 * the session again.
 */
class HeroSlot extends Container implements NativeScrollbackCommittedRows, NativeScrollbackCompaction {
	// Rows of the previous frame's render the engine holds as committed, fed before each render.
	#committedRows = 0;
	// Rows the last render returned.
	#renderedRows = 0;
	// Committed rows dropped since the engine last read the count.
	#droppedRows = 0;

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = rows;
	}

	takeNativeScrollbackDroppedRows(): number {
		const rows = this.#droppedRows;
		this.#droppedRows = 0;
		return rows;
	}

	/** The slot's height, without the drop a render records. */
	measureHeight(width: number): number {
		return super.render(width).length;
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		// The committed rows are the leading rows of the card, so an emptied slot drops
		// exactly those. Rows still on screen were never committed and repaint as an
		// ordinary change.
		if (lines.length === 0) this.#droppedRows += Math.min(this.#committedRows, this.#renderedRows);
		this.#renderedRows = lines.length;
		return lines;
	}
}

/**
 * Owns the startup welcome hero and the full `/welcome` card: mounting and
 * dismissal. Extracted from interactive-mode (ARCH-2) so the god-file keeps
 * only orchestration and the layout math it owns.
 */
export class WelcomeController {
	/** The hero card and its surrounding spacers, emptied on dismissal so no blank rows stay behind. */
	#slot: HeroSlot | undefined;

	constructor(private readonly port: WelcomeLayoutPort) {}

	/** True while the startup hero is mounted — the layout gives it a share
	 * of the home-screen slack as top margin while this holds. */
	get hasHero(): boolean {
		return this.#slot !== undefined;
	}

	/** Mount the startup hero (spacer · card · spacer) at the top of the UI
	 * tree. The host adds its centring top fill first; ordering matters.
	 *
	 * `adopted` is the card the first frame already painted (`first-frame.ts`).
	 * Its data is refreshed rather than a second card built, so the sun, the
	 * tip and the row count do not change under the operator when the session
	 * finally lands. */
	mountHero(inputs: WelcomeHeroInputs, adopted?: WelcomeComponent): void {
		if (adopted) {
			adopted.setModel(inputs.modelName, inputs.providerName);
			adopted.setRecentSessions(inputs.recentSessions);
		}
		const card =
			adopted ?? new WelcomeComponent(inputs.version, inputs.modelName, inputs.providerName, inputs.recentSessions);
		const slot = new HeroSlot();
		slot.addChild(new Spacer(1));
		slot.addChild(card);
		slot.addChild(new Spacer(1));
		this.#slot = slot;
		this.port.ui.addChild(slot);
	}

	/** Empty the startup hero's slot — the first real keystroke ends the hero
	 * moment. Idempotent. Reports the removed row count (card + spacers + the
	 * host's top margin) so the host can keep the composer pinned to the
	 * viewport bottom on this very frame. The emptied slot stays mounted: its
	 * next render reports the card rows native scrollback already holds. */
	dismiss(): void {
		const slot = this.#slot;
		if (!slot) return;
		this.#slot = undefined;
		const width = this.port.ui.terminal.columns;
		// The host's anchor measures via the last composed frame, which still
		// includes the card — report the removed rows explicitly so the fill
		// math corrects on this frame, not the next.
		const removedRows = slot.measureHeight(width) + this.port.topFillRows(width);
		slot.clear();
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
	}
}
