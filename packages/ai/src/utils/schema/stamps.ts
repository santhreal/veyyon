function define<T extends object>(target: T, key: symbol, value: unknown): void {
	if (Object.isFrozen(target)) return;
	Object.defineProperty(target, key, { value, writable: true, configurable: true });
}

export function stamp<T extends object, V>(target: T, key: symbol, compute: (target: T) => V): V {
	const slot = target as Record<symbol, V | undefined>;
	const existing = slot[key];
	if (existing !== undefined) return existing;
	const value = compute(target);
	define(target, key, value);
	return value;
}

const kEpoch = Symbol("pi.schema.epoch");
let __epoch = 0;

export function epochNext(): number {
	return ++__epoch;
}

export function once<T extends object>(target: T, epoch: number): boolean {
	const slot = target as Record<symbol, number | undefined>;
	const cur = slot[kEpoch];
	if (cur !== undefined && cur >= epoch) return false;
	if (cur === undefined) define(target, kEpoch, epoch);
	else slot[kEpoch] = epoch;
	return true;
}

const kDepth = Symbol("pi.schema.depth");

export function enter<T extends object>(target: T): boolean {
	const slot = target as Record<symbol, number | undefined>;
	const cur = slot[kDepth];
	if (cur === undefined) {
		define(target, kDepth, 1);
		return true;
	}
	if (cur !== 0) return false;
	slot[kDepth] = 1;
	return true;
}

export function exit<T extends object>(target: T): void {
	const slot = target as Record<symbol, number | undefined>;
	const cur = slot[kDepth];
	if (cur === undefined) return;
	slot[kDepth] = cur - 1;
}
