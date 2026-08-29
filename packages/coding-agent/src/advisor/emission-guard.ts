import {
	DEFAULT_HISTORY_CAPACITY,
	normalizeAdvisorNote,
	SUPPRESSED_NORMALIZED_PHRASES,
} from "./emission-guard-helpers";

export { normalizeAdvisorNote };

export class AdvisorEmissionGuard {
	#seen = new Set<string>();
	#seenOrder: string[] = [];
	#consumedThisUpdate = false;
	readonly #capacity: number;

	constructor(opts: { capacity?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
	}

	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#consumedThisUpdate = false;
	}

	beginUpdate(): void {
		this.#consumedThisUpdate = false;
	}

	accept(note: string): boolean {
		const key = normalizeAdvisorNote(note);
		if (!key) return false;
		if (Object.hasOwn(SUPPRESSED_NORMALIZED_PHRASES, key)) return false;
		if (this.#seen.has(key)) return false;
		if (this.#consumedThisUpdate) return false;
		this.#consumedThisUpdate = true;
		this.#seen.add(key);
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
		return true;
	}
}
