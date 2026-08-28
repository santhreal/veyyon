const MAX_ENTRIES = 60;

export class KillRing {
	#ring: string[] = [];

	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.#ring.length > 0) {
			const last = this.#ring.pop()!;
			this.#ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.#ring.push(text);
			if (this.#ring.length > MAX_ENTRIES) {
				this.#ring.shift();
			}
		}
	}

	peek(): string | undefined {
		return this.#ring.length > 0 ? this.#ring[this.#ring.length - 1] : undefined;
	}

	rotate(): void {
		if (this.#ring.length > 1) {
			const last = this.#ring.pop()!;
			this.#ring.unshift(last);
		}
	}

	get length(): number {
		return this.#ring.length;
	}
}
