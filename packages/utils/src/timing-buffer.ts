export interface ModuleLoadEvent {
	path: string;
	start: number;
	durationMs: number;
	bodyMs?: number;
	imports: string[];
}

const KEY: symbol = Symbol.for("veyyon.moduleLoadBuffer");

type Store = Record<symbol, ModuleLoadEvent[] | undefined>;

export function moduleLoadBuffer(): ModuleLoadEvent[] {
	const store = globalThis as unknown as Store;
	let buffer = store[KEY];
	if (!buffer) {
		buffer = [];
		store[KEY] = buffer;
	}
	return buffer;
}

export function drainModuleLoadEvents(): ModuleLoadEvent[] {
	const store = globalThis as unknown as Store;
	const buffer = store[KEY];
	if (!buffer || buffer.length === 0) return [];
	store[KEY] = [];
	return buffer;
}
