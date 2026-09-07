/**
 * The byte-sink terminal and the manual scheduler the frame benches drive the
 * engine with. A sink counts what the engine writes and keeps the last chunk,
 * so a phase can assert that bytes reached the terminal and that the final
 * frame holds the sentinel it streamed; the scheduler queues every callback
 * and runs them on flush(), so a render never fires before the engine has
 * stored its own timer handle.
 */
import type { Terminal, TerminalAppearance } from "../src/terminal";
import type { RenderScheduler } from "../src/tui";

export class SinkTerminal implements Terminal {
	bytes = 0;
	writes = 0;
	lastChunk = "";
	constructor(
		public colsValue = 100,
		public rowsValue = 40,
	) {}
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += data.length;
		this.writes += 1;
		this.lastChunk = data;
	}
	get columns(): number {
		return this.colsValue;
	}
	get rows(): number {
		return this.rowsValue;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	readonly keyboardEnhancementEnterSequence = null;
	readonly keyboardEnhancementExitSequence = null;
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}

// Manual scheduler: callbacks queue and run on flush(). Running them inline
// would fire the render callback BEFORE `#renderTimer` is assigned, leaving a
// stale timer handle that silently blocks every later frame.
export class ManualScheduler implements RenderScheduler {
	#queue: Array<(() => void) | null> = [];
	now(): number {
		return performance.now();
	}
	scheduleImmediate(callback: () => void): void {
		this.#queue.push(callback);
	}
	scheduleRender(callback: () => void, _delayMs: number) {
		const index = this.#queue.push(callback) - 1;
		return {
			cancel: () => {
				this.#queue[index] = null;
			},
		};
	}
	flush(): void {
		while (this.#queue.length > 0) {
			const callback = this.#queue.shift();
			callback?.();
		}
	}
}
