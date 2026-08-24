/**
 * WHY THIS SUITE EXISTS. `core/memory.ts` and `core/beam/store.ts` export the
 * same verb names — `remember`, `recall`, `get`, `scratchpadRead` and the rest —
 * so a reader cannot tell from the names whether the second is the storage
 * implementation or a fork of it. It is the implementation: the module verb
 * resolves the default instance, the instance method calls the store function
 * with its own state. The suite writes through one layer and reads through
 * another, so a second store behind the facade shows up as a lost row rather
 * than as a passing test.
 *
 * THE CLASS THIS CLOSES. A verb the facade answers from somewhere other than the
 * store the instance owns. The colliding-name set is derived from both modules at
 * run time and pinned by exact equality, so a new shared verb fails here until
 * someone records what it is.
 *
 * WHAT IT DOES NOT CATCH. A verb that exists on only one of the two layers, and
 * recall RANKING, which the recall suites own.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "@veyyon/mnemopi/core/beam/store";
import * as memory from "@veyyon/mnemopi/core/memory";

const roots: string[] = [];
let previousDataDir: string | undefined;

function useTempDataDir(): void {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-one-verb-"));
	roots.push(root);
	previousDataDir = process.env.MNEMOPI_DATA_DIR;
	process.env.MNEMOPI_DATA_DIR = root;
}

afterEach(() => {
	memory.resetDefaultInstanceForTests();
	if (previousDataDir === undefined) delete process.env.MNEMOPI_DATA_DIR;
	else process.env.MNEMOPI_DATA_DIR = previousDataDir;
	previousDataDir = undefined;
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

/** The verbs both modules spell, derived rather than listed. */
const SHARED_VERBS = ["get", "getContext", "remember", "scratchpadClear", "scratchpadRead", "scratchpadWrite"];

function functionNames(module: Record<string, unknown>): string[] {
	return Object.keys(module)
		.filter(name => typeof module[name] === "function")
		.sort();
}

describe("a memory verb has one implementation", () => {
	it("names exactly the verbs the facade and the store both export", () => {
		const storeNames = new Set(functionNames(store as unknown as Record<string, unknown>));
		const shared = functionNames(memory as unknown as Record<string, unknown>).filter(name => storeNames.has(name));

		expect(shared).toEqual(SHARED_VERBS);
	});

	it("reads a facade write out of the store the instance owns", () => {
		useTempDataDir();
		const id = memory.remember("Ada prefers deterministic tests");
		const beam = memory.getDefaultInstance().beam;

		expect(store.get(beam, id)).toMatchObject({ id, content: "Ada prefers deterministic tests" });
		expect(memory.get(id)).toMatchObject({ id, content: "Ada prefers deterministic tests" });
	});

	it("reads a store write back through the facade, including recall", async () => {
		useTempDataDir();
		const beam = memory.getDefaultInstance().beam;
		const id = store.remember(beam, "Ada keeps the kettle in the pantry");

		expect(memory.get(id)).toMatchObject({ id });
		expect(memory.getContext(5).length).toBeGreaterThan(0);
		expect((await memory.recall("kettle", 5)).map(result => result.id)).toContain(id);
	});

	it("shares the scratchpad between the two layers", () => {
		useTempDataDir();
		const beam = memory.getDefaultInstance().beam;
		memory.scratchpadWrite("through the facade");
		store.scratchpadWrite(beam, "through the store");

		expect(store.scratchpadRead(beam)).toHaveLength(2);
		expect(memory.scratchpadRead()).toHaveLength(2);

		memory.scratchpadClear();

		expect(store.scratchpadRead(beam)).toEqual([]);
	});

	it("retargets the facade at another bank without carrying the first bank's rows", () => {
		useTempDataDir();
		const id = memory.remember("belongs to the default bank");
		memory.setBank("other");

		expect(memory.getBank()).toBe("other");
		expect(memory.get(id)).toBeNull();
		expect(store.get(memory.getDefaultInstance().beam, id)).toBeNull();
	});
});
