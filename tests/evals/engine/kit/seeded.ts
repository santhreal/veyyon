/**
 * Deterministic data for one trial.
 *
 * A task's data (names, prices, dates, which row holds the answer) come from a seed, so a model
 * cannot answer from a remembered transcript, while every arm of one comparison meets the same data
 * on the same task and repeat. The seed is the task id and the repeat, never the arm.
 */

/** mulberry32: a 32-bit state, uniform enough for fixture data, and the same on every host. */
export class Seeded {
	#state: number;

	constructor(seed: number) {
		this.#state = seed >>> 0;
	}

	/** A float in [0, 1). */
	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	}

	/** An integer in [min, max], both ends included. */
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error("pick from an empty list");
		return items[Math.floor(this.next() * items.length)] as T;
	}

	/** A new array holding `items` in a seeded order. */
	shuffle<T>(items: readonly T[]): T[] {
		const out = [...items];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(this.next() * (i + 1));
			[out[i], out[j]] = [out[j] as T, out[i] as T];
		}
		return out;
	}

	/** `count` distinct items of `items`, in a seeded order. */
	sample<T>(items: readonly T[], count: number): T[] {
		if (count > items.length) throw new Error(`cannot sample ${count} of ${items.length}`);
		return this.shuffle(items).slice(0, count);
	}

	/** A code of `length` characters from an alphabet without look-alikes (no 0/O, 1/I/l). */
	code(length: number): string {
		const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
		let out = "";
		for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.next() * alphabet.length)];
		return out;
	}
}

/** FNV-1a over the text: a stable 32-bit seed from a task id. */
export function seedOf(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}
