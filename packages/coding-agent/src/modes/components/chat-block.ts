import { type Component, Container } from "@veyyon/tui";

/**
 * Capabilities a mounted {@link ChatBlock} may use against its host transcript.
 * Kept minimal so blocks never reach into the full TUI/InteractiveMode surface.
 */
export interface ChatBlockHost {
	/** Schedule a repaint scoped to one block — never the whole transcript. */
	requestComponentRender(component: Component): void;
}

/**
 * Lifecycle-aware transcript block. `mount` runs `onMount`; effects register teardown
 * via `onCleanup`. Repaints through `requestRender` (never touching the TUI). Tears down
 * once on `finish` (self-complete) or `dispose` (host discards).
 */
export abstract class ChatBlock extends Container {
	#host: ChatBlockHost | undefined;
	#cleanups: Array<() => void> = [];
	#active = false;
	#disposed = false;

	/**
	 * Run setup after the block is in the transcript: start timers/subscriptions
	 * and register their teardown with {@link onCleanup}. Default: no-op (a block
	 * whose content is fixed at construction needs no mount work).
	 */
	onMount(): void {}

	/**
	 * Register a teardown to run on {@link finish}/{@link dispose}, à la a
	 * `useEffect` cleanup. If the block is already disposed the cleanup runs
	 * immediately so callers never leak.
	 */
	onCleanup(cleanup: () => void): void {
		if (this.#disposed) {
			cleanup();
			return;
		}
		this.#cleanups.push(cleanup);
	}

	/** Ask the host to repaint this block. No-op before mount or after dispose. */
	requestRender(): void {
		this.#host?.requestComponentRender(this);
	}

	/** True between {@link mount} and {@link finish}/{@link dispose}. */
	get active(): boolean {
		return this.#active;
	}

	/**
	 * Host-only: attach the host and run {@link onMount}. Idempotent — a second
	 * call (e.g. a transcript rebuild that re-presents the same instance) is a
	 * no-op.
	 */
	mount(host: ChatBlockHost): void {
		if (this.#host || this.#disposed) return;
		this.#host = host;
		this.#active = true;
		this.onMount();
	}

	/**
	 * Self-complete: stop ongoing effects and freeze the block at its current
	 * content, leaving it rendered in the transcript. Use when the operation the
	 * block represents finishes (connection resolved, download done).
	 */
	finish(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#runCleanups();
		this.requestRender();
	}

	/**
	 * Host-only teardown: release everything and propagate to children. Called
	 * when the host permanently discards the block (transcript reset). Idempotent.
	 */
	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#active = false;
		this.#runCleanups();
		super.dispose();
		this.#host = undefined;
	}

	/** Live blocks stay repaintable; finished/disposed ones may freeze. */
	isTranscriptBlockFinalized(): boolean {
		return !this.#active;
	}

	#runCleanups(): void {
		const cleanups = this.#cleanups.splice(0);
		for (const cleanup of cleanups) cleanup();
	}
}
