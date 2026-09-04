import { Terminal } from "@xterm/headless";

export interface StartupFrameSample {
	at: number;
	text: string;
	changed: boolean;
	ready: boolean;
	editable: boolean;
}

export interface SettledStartupFrame {
	firstByte: number;
	editable: number;
	settledEditable: number;
	observationMs: number;
	stableForMs: number;
}

/**
 * Observe terminal state, not matches in an accumulated escape stream. Settlement is
 * retrospective over the complete observation interval, with a minimum stable tail.
 * It does not certify that a network-driven update cannot arrive after that interval.
 */
export class StartupFrameObserver {
	readonly terminal: Terminal;
	readonly samples: StartupFrameSample[] = [];
	#expectedModel: string;
	#probe: string;
	#firstByte: number | undefined;
	#editable: number | undefined;
	#lastChange = 0;
	#signature = "";
	#pending: Promise<void> = Promise.resolve();

	constructor(columns: number, rows: number, expectedModel: string, probe: string) {
		if (!expectedModel.trim()) throw new Error("A resolved model display name is required for settled startup");
		this.terminal = new Terminal({ cols: columns, rows, allowProposedApi: true, scrollback: 0 });
		this.#expectedModel = expectedModel;
		this.#probe = probe;
	}

	write(chunk: string, at: number): Promise<void> {
		this.#firstByte ??= at;
		this.#pending = this.#pending.then(async () => {
			const parsed = Promise.withResolvers<void>();
			this.terminal.write(chunk, parsed.resolve);
			await parsed.promise;
			this.#observe(at);
		});
		return this.#pending;
	}

	/** Wait for all queued terminal writes before persisting a trace or disposing. */
	flush(): Promise<void> {
		return this.#pending;
	}

	#observe(at: number): void {
		const buffer = this.terminal.buffer.active;
		const cell = buffer.getNullCell();
		const lines: string[] = [];
		const appearance: string[] = [];
		for (let y = 0; y < this.terminal.rows; y++) {
			const line = buffer.getLine(buffer.viewportY + y);
			lines.push(line?.translateToString(true) ?? "");
			if (!line) continue;
			for (let x = 0; x < this.terminal.cols; x++) {
				if (!line.getCell(x, cell)) continue;
				appearance.push(
					`${cell.getFgColorMode()},${cell.getFgColor()},${cell.getBgColorMode()},${cell.getBgColor()},${cell.isBold()},${cell.isItalic()},${cell.isDim()},${cell.isUnderline()},${cell.isInverse()},${cell.isBlink()},${cell.isInvisible()},${cell.isStrikethrough()},${cell.isOverline()}`,
				);
			}
		}
		const text = lines.join("\n");
		const signature = `${text}\n${appearance.join(";")}\n${buffer.cursorX},${buffer.cursorY}`;
		const changed = signature !== this.#signature;
		if (changed) {
			this.#signature = signature;
			this.#lastChange = at;
		}
		// Require the edited probe on the composer row, not an echo elsewhere on screen.
		const editable = lines.some(line => /^\s*›\s*/u.test(line) && line.includes(this.#probe));
		if (editable) this.#editable ??= at;
		const ready =
			text.includes(this.#expectedModel) &&
			/\b\d+(?:\.\d+)?% left\b/u.test(text) &&
			!text.includes("? left") &&
			!text.includes("no model yet") &&
			!text.includes("no-model");
		this.samples.push({ at, text, changed, ready, editable });
	}

	async finish(observationMs: number, minimumStableMs: number): Promise<SettledStartupFrame> {
		await this.#pending;
		const last = this.samples.at(-1);
		if (!last?.ready || !last.editable || this.#firstByte === undefined || this.#editable === undefined) {
			throw new Error(`Startup did not reach resolved metadata and an editable composer in ${observationMs}ms`);
		}
		const settledEditable = Math.max(this.#lastChange, this.#editable);
		const stableForMs = observationMs - settledEditable;
		if (stableForMs < minimumStableMs) {
			throw new Error(
				`Startup remained unchanged for only ${stableForMs.toFixed(1)}ms; require ${minimumStableMs}ms`,
			);
		}
		return { firstByte: this.#firstByte, editable: this.#editable, settledEditable, observationMs, stableForMs };
	}

	dispose(): void {
		this.terminal.dispose();
	}
}
