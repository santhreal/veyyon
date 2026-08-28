export class Rng {
	#state: number;

	constructor(seed: number) {
		this.#state = seed >>> 0;
	}

	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	}

	int(min: number, max: number): number {
		if (max < min) return min;
		return Math.floor(this.next() * (max - min + 1)) + min;
	}

	chance(probability: number): boolean {
		return this.next() < probability;
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) {
			throw new Error("Cannot pick from an empty list");
		}
		return items[this.int(0, items.length - 1)]!;
	}
}

export interface StressRandomStreams {
	readonly ops: Rng;
	readonly content: Rng;
	readonly overlay: Rng;
	readonly geometry: Rng;
	readonly cursor: Rng;
	readonly children: Rng;
}

export function createRandomStreams(seed: number): StressRandomStreams {
	return {
		ops: new Rng(mixSeed(seed, 0x01)),
		content: new Rng(mixSeed(seed, 0x02)),
		overlay: new Rng(mixSeed(seed, 0x03)),
		geometry: new Rng(mixSeed(seed, 0x04)),
		cursor: new Rng(mixSeed(seed, 0x05)),
		children: new Rng(mixSeed(seed, 0x06)),
	};
}

export function mixSeed(seed: number, stream: number): number {
	let mixed = (seed ^ Math.imul(stream, 0x9e3779b9)) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
	return (mixed ^ (mixed >>> 16)) >>> 0;
}

export interface WeightedCandidate<T> {
	readonly item: T;
	readonly weight: number;
}

export function weightedPick<T>(rng: Rng, items: readonly WeightedCandidate<T>[]): T {
	let total = 0;
	for (const entry of items) {
		total += Math.max(0, entry.weight);
	}
	if (total <= 0) throw new Error("No weighted candidates");

	let roll = rng.next() * total;
	for (const entry of items) {
		const weight = Math.max(0, entry.weight);
		roll -= weight;
		if (roll < 0) return entry.item;
	}
	return items[items.length - 1]!.item;
}
