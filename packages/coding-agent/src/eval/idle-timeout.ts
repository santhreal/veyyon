export class IdleTimeout {
	readonly #controller = new AbortController();
	readonly #idleMs: number;
	#deadlineMs: number;
	#timer: NodeJS.Timeout | undefined;
	#settled = false;
	#pauseDepth = 0;

	constructor(idleMs: number) {
		this.#idleMs = Math.max(1, Math.floor(idleMs));
		this.#deadlineMs = Date.now() + this.#idleMs;
		this.#controller.signal.addEventListener("abort", IdleTimeout.#anchorReason);
		this.#arm(this.#idleMs);
	}

	static readonly #anchorReason = (): void => {};

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get idleMs(): number {
		return this.#idleMs;
	}

	pause(): void {
		if (this.#settled) return;
		this.#pauseDepth++;
		if (this.#pauseDepth !== 1) return;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	resume(): void {
		if (this.#settled || this.#pauseDepth === 0) return;
		this.#pauseDepth--;
		if (this.#pauseDepth > 0) return;
		this.#deadlineMs = Date.now() + this.#idleMs;
		this.#arm(this.#idleMs);
	}

	dispose(): void {
		if (this.#settled) return;
		this.#settled = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	#arm(delayMs: number): void {
		const timer = setTimeout(() => this.#onExpire(), Math.max(0, delayMs));
		timer.unref?.();
		this.#timer = timer;
	}

	#onExpire(): void {
		if (this.#settled || this.#pauseDepth > 0) return;
		const remainingMs = this.#deadlineMs - Date.now();
		if (remainingMs > 0) {
			this.#arm(remainingMs);
			return;
		}
		this.#settled = true;
		this.#timer = undefined;
		this.#controller.abort(new DOMException(`Idle for ${Math.round(this.#idleMs / 1000)}s`, "TimeoutError"));
	}
}
