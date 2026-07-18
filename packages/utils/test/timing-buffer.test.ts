import { beforeEach, describe, expect, it } from "bun:test";
import { drainModuleLoadEvents, type ModuleLoadEvent, moduleLoadBuffer } from "../src/timing-buffer";

const REGISTRY_KEY = Symbol.for("veyyon.moduleLoadBuffer");

function event(path: string): ModuleLoadEvent {
	return { path, start: 0, durationMs: 1, imports: [] };
}

// The preload and the logger share this buffer through a registry-global
// `Symbol.for` key so neither has to import the other. Lock the lazy-create,
// the cross-module identity, and the drain-and-reset semantics.
describe("timing-buffer", () => {
	beforeEach(() => {
		// Normalize the process-global singleton before each case.
		drainModuleLoadEvents();
	});

	it("lazily creates one buffer and returns the same instance on repeated access", () => {
		const first = moduleLoadBuffer();
		const second = moduleLoadBuffer();
		expect(second).toBe(first);
		expect(first).toEqual([]);
	});

	it("exposes the buffer under the shared registry symbol so a second importer sees the same array", () => {
		const buffer = moduleLoadBuffer();
		buffer.push(event("a.ts"));
		const viaRegistry = (globalThis as unknown as Record<symbol, ModuleLoadEvent[]>)[REGISTRY_KEY];
		expect(viaRegistry).toBe(buffer);
		expect(viaRegistry.map(e => e.path)).toEqual(["a.ts"]);
	});

	it("drains the accumulated events and empties the buffer", () => {
		const buffer = moduleLoadBuffer();
		buffer.push(event("a.ts"), event("b.ts"));

		const drained = drainModuleLoadEvents();
		expect(drained.map(e => e.path)).toEqual(["a.ts", "b.ts"]);
		// A fresh buffer follows the drain, decoupled from the drained snapshot.
		expect(moduleLoadBuffer()).toEqual([]);
		expect(moduleLoadBuffer()).not.toBe(drained);
	});

	it("returns an empty list when draining a never-touched or already-drained buffer", () => {
		expect(drainModuleLoadEvents()).toEqual([]);
		moduleLoadBuffer().push(event("x.ts"));
		expect(drainModuleLoadEvents().map(e => e.path)).toEqual(["x.ts"]);
		expect(drainModuleLoadEvents()).toEqual([]);
	});
});
