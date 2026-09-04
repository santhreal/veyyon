/**
 * How many inline images may be live terminal graphics at once.
 *
 * This is engine state, not component state: the demotion it decides costs a full redraw plus an
 * explicit graphics purge, both of which only the renderer can emit. `Image` reports display order
 * into it and reads back whether it was demoted; the engine drives the purge on the frame after a
 * new image pushes the count past the cap.
 */
const EMPTY_IDS: readonly number[] = [];
const EMPTY_TRANSMITS: readonly string[] = [];

/** Default count of inline images kept as live graphics before older ones fall back to text. */
export const DEFAULT_MAX_INLINE_IMAGES = 8;

let nextImageBudgetSeed = Math.floor(Math.random() * 0xffffff);
function nextImageIdSeed(): number {
	nextImageBudgetSeed = (nextImageBudgetSeed + 0x10000) & 0xffffff;
	return nextImageBudgetSeed || 1;
}
/**
 * Bounds how many inline images render as live terminal graphics at once.
 *
 * Terminal graphics protocols — Kitty especially — keep every transmitted image
 * in a per-terminal store and re-draw placements as content scrolls; text-clear
 * escapes (`CSI 2 J` / `CSI 3 J`) do not remove them. Unbounded, a session that
 * shows many images piles up placements plus store memory and leaves ghosts in
 * scrollback.
 *
 * The budget keeps the most recent `cap` images live and demotes older ones to
 * their text fallback. Demotion needs a full redraw (so off-screen rows are
 * rewritten) plus an explicit graphics purge of the demoted ids — {@link Image}
 * reports display order via {@link observe}, and the TUI drives the purge +
 * redraw on the frame after a new image pushes the count past the cap.
 *
 * `cap <= 0` disables budgeting: every image stays a live graphic.
 */
export class ImageBudget {
	#cap: number;
	#requestRender: () => void;
	#nextId = nextImageIdSeed();
	#keyToId = new Map<string, number>();
	#idToKey = new Map<number, string>();
	/** Display-order image ids observed during the in-flight pass. */
	#passIds: number[] = [];
	/**
	 * Suppress threshold reflected in the frame currently on the terminal: images
	 * at display indices `[0, #onTerminal)` are shown as text there.
	 */
	#onTerminal = 0;
	/** Suppress threshold the current/next render should apply. */
	#planned = 0;
	/**
	 * True while the in-flight pass applies a stricter threshold than the terminal
	 * shows — the demotion frame that must purge graphics and fully repaint.
	 */
	#applyingReset = false;
	#lastTotal = 0;
	#purgeIds: number[] = [];
	/** Image ids whose data is believed to be loaded in the terminal's store. */
	#transmitted = new Set<number>();
	/** Transmit sequences (full base64) to write once, before this frame's placements. */
	#pendingTransmits: string[] = [];
	// True while the in-flight pass is a partial/throwaway pass (the
	// non-multiplexer resize viewport fast path) that walks only the visible
	// tail, bottom-up. Such a pass cannot derive display order from observe()
	// call order, so its suppression decisions replay the committed split below.
	#stablePass = false;
	// Image ids shown as text in the frame currently on the terminal: the
	// display-order prefix [0, #onTerminal) of the last full pass, snapshotted by
	// id so a partial pass reproduces the on-screen live/text split without a
	// full, correctly-ordered walk.
	#suppressedIds = new Set<number>();

	constructor(cap: number = DEFAULT_MAX_INLINE_IMAGES, requestRender: () => void = () => {}) {
		this.#cap = normalizeCap(cap);
		this.#requestRender = requestRender;
	}

	get cap(): number {
		return this.#cap;
	}

	get enabled(): boolean {
		return this.#cap > 0;
	}

	setRequestRender(requestRender: () => void): void {
		this.#requestRender = requestRender;
	}

	setCap(cap: number): void {
		const next = normalizeCap(cap);
		if (next === this.#cap) return;
		this.#cap = next;
		this.#reconcile(this.#lastTotal);
	}

	/**
	 * Stable graphics id for a logical image. A non-empty `key` maps to the same
	 * id across re-creations (so repaints replace the placement); a missing key
	 * gets a fresh id every call.
	 */
	acquireId(key?: string): number {
		if (key) {
			const existing = this.#keyToId.get(key);
			if (existing !== undefined) return existing;
			const id = this.#nextId;
			this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
			this.#keyToId.set(key, id);
			this.#idToKey.set(id, key);
			return id;
		}
		const id = this.#nextId;
		this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
		return id;
	}

	/**
	 * Begin a render pass. Called by the renderer before composing the frame.
	 * Pass `stable: true` for a partial/throwaway pass that does not walk the
	 * whole tree in display order (the resize viewport fast path): {@link observe}
	 * then replays the last committed per-id decision instead of one derived from
	 * call order, and the pass must NOT be closed with {@link endPass}.
	 */
	beginPass(stable = false): void {
		this.#passIds.length = 0;
		this.#stablePass = stable;
		this.#applyingReset = !stable && this.#cap > 0 && this.#planned > this.#onTerminal;
	}

	/**
	 * Record an image in display order and report whether it must render its text
	 * fallback this frame. Called by every {@link Image} during render — including
	 * on a cache hit, so the image keeps its display-order slot.
	 *
	 * During a `stable` pass ({@link beginPass}) the call order and visible subset
	 * are not authoritative, so the decision is the committed on-terminal split
	 * (`#suppressedIds`) keyed by id — order- and partiality-independent.
	 */
	observe(imageId: number): boolean {
		if (this.#stablePass) {
			const suppressed = this.#cap > 0 && this.#suppressedIds.has(imageId);
			if (suppressed) this.#forgetKeyForId(imageId);
			return suppressed;
		}
		const index = this.#passIds.length;
		this.#passIds.push(imageId);
		const suppressed = this.#cap > 0 && index < this.#planned;
		if (suppressed) this.#forgetKeyForId(imageId);
		return suppressed;
	}

	/**
	 * End a render pass. Returns true when this frame must purge graphics and
	 * fully repaint to apply a stricter budget; read the ids via
	 * {@link takePurgeIds}.
	 */
	endPass(): boolean {
		const total = this.#passIds.length;
		this.#lastTotal = total;
		let reset = false;
		if (this.#applyingReset) {
			for (let i = this.#onTerminal; i < this.#planned && i < total; i++) {
				const id = this.#passIds[i];
				this.#purgeIds.push(id);
				// d=I frees the data too, so the image must re-transmit if it returns.
				this.#transmitted.delete(id);
				this.#forgetKeyForId(id);
			}
			this.#onTerminal = this.#planned;
			this.#applyingReset = false;
			reset = true;
		}
		this.#reconcile(total);
		// Snapshot the committed display-order suppression by id: the prefix
		// [0, #onTerminal) is what the terminal currently shows as text. Partial
		// passes replay this per id (see #stablePass) instead of re-deriving it
		// from a reversed, tail-only walk.
		this.#suppressedIds = new Set(this.#passIds.slice(0, this.#onTerminal));
		return reset;
	}

	/** Image ids to delete from the terminal this frame; clears the pending set. */
	takePurgeIds(): readonly number[] {
		if (this.#purgeIds.length === 0) return EMPTY_IDS;
		const ids = this.#purgeIds;
		this.#purgeIds = [];
		return ids;
	}

	/** All image ids believed to be loaded in the terminal store; clears tracking. */
	takeAllTransmittedIds(): readonly number[] {
		if (this.#transmitted.size === 0) return EMPTY_IDS;
		const ids = [...this.#transmitted];
		this.#transmitted.clear();
		this.#purgeIds = [];
		this.#pendingTransmits = [];
		this.#keyToId.clear();
		this.#idToKey.clear();
		return ids;
	}

	/** Whether `imageId`'s data still needs to be transmitted to the terminal. */
	shouldTransmit(imageId: number): boolean {
		return !this.#transmitted.has(imageId);
	}

	/**
	 * Queue a one-time transmit for `imageId`. No-op if already transmitted, so a
	 * repeated call (e.g. a width-change re-render) never re-sends the data.
	 */
	enqueueTransmit(imageId: number, sequence: string): void {
		if (this.#transmitted.has(imageId)) return;
		this.#transmitted.add(imageId);
		this.#pendingTransmits.push(sequence);
	}

	/** Whether a frame has image data queued but not yet written to the terminal. */
	hasPendingTransmits(): boolean {
		return this.#pendingTransmits.length > 0;
	}

	/**
	 * True when the budget has nothing in flight: no live images observed on
	 * the last pass, no queued transmits, no pending purges, and no stricter
	 * threshold left to apply. A component-scoped frame may skip the observe
	 * pass only then — a partial tree walk would under-count display order.
	 */
	get quiescent(): boolean {
		return (
			this.#lastTotal === 0 &&
			this.#pendingTransmits.length === 0 &&
			this.#purgeIds.length === 0 &&
			this.#planned === this.#onTerminal
		);
	}

	/** Transmit sequences to write before this frame's placements; clears the queue. */
	takeTransmits(): readonly string[] {
		if (this.#pendingTransmits.length === 0) return EMPTY_TRANSMITS;
		const sequences = this.#pendingTransmits;
		this.#pendingTransmits = [];
		return sequences;
	}

	/**
	 * Drop transmit tracking so every still-live image re-enqueues its data
	 * (`a=t`) on the next render. Recovers when the terminal dropped the original
	 * transmit — e.g. Ghostty discarding graphics sent during its post-startup
	 * window — where a placement-only replay can never bind a Unicode placeholder.
	 * Pair with a component invalidate + forced repaint so the data and placement
	 * re-emit together; keeps no base64 in budget state (the transmit-once design).
	 */
	forgetTransmitted(): void {
		if (this.#transmitted.size === 0 && this.#pendingTransmits.length === 0) return;
		this.#transmitted.clear();
		this.#pendingTransmits = [];
	}

	#forgetKeyForId(id: number): void {
		const key = this.#idToKey.get(id);
		if (key === undefined) return;
		this.#idToKey.delete(id);
		if (this.#keyToId.get(key) === id) this.#keyToId.delete(key);
	}

	#reconcile(total: number): void {
		const desired = this.#cap > 0 ? Math.max(0, total - this.#cap) : 0;
		if (desired === this.#planned) {
			// Budget relaxed without a stricter frame (cap raised or images
			// removed): surviving graphics are untouched and re-exposed rows
			// repaint normally, so just track the looser threshold.
			if (this.#planned < this.#onTerminal) this.#onTerminal = this.#planned;
			return;
		}
		this.#planned = desired;
		// More images must be demoted than the terminal shows: schedule the purge +
		// full-redraw frame. Fewer: no ghosts to clear, so just catch the tracking
		// up — a normal repaint re-exposes the un-demoted images. Either way a
		// render is needed to apply the new threshold.
		if (desired <= this.#onTerminal) this.#onTerminal = desired;
		this.#requestRender();
	}
}

function normalizeCap(cap: number): number {
	if (!Number.isFinite(cap)) return 0;
	return Math.max(0, Math.trunc(cap));
}
