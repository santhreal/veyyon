import { describe, expect, it } from "bun:test";
import { walkBranchPath } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionEntryIndex } from "@veyyon/kernel/session/session-entry-index";

/**
 * WHY: `SessionEntryIndex` keeps the active branch (root to leaf) cached and extends it in place when
 * an entry is appended to the leaf, because every startup reader walks that branch and a walk of a
 * long session costs tens of milliseconds. A rebuild starts from the empty branch and extends it the
 * same way, so a session that never branched loads holding its branch. A cache that is extended
 * when it should have been dropped serves a branch the entries no longer form: an insert that hangs
 * off another entry, an insert that reuses an id already on the map, an empty id, a leaf move, a
 * rebuild of a log that branches or a clear. The session then resumes on, compacts, or prompts with
 * the wrong conversation, and nothing reports it.
 *
 * The class this closes: after any sequence of the index's mutating calls, `leafPath()` and
 * `pathTo()` equal an uncached walk of the current entries from the current leaf, and `pathTo()`
 * returns a copy the caller may edit. The mutating calls are driven by a seeded walk that mixes
 * every kind of insert and every kind of leaf move. The index's method list is read from its
 * prototype at run time, and a method that is neither driven here nor classified as a read fails
 * the suite until someone records which it is.
 *
 * What it does NOT catch: a wrong walk. The reference is `walkBranchPath`, the same function the
 * index calls on a cache miss, so a defect in the walk itself agrees with itself here; the
 * session-manager branch-order suite pins the walk's direction.
 */

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function entry(id: string, parentId: string | null): SessionEntry {
	return { type: "model_change", id, parentId, timestamp: TIMESTAMP, model: `provider/${id}` };
}

/** Deterministic PRNG, so a failing step reproduces from its seed. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Walk {
	index: SessionEntryIndex;
	/** Every entry inserted since the last clear, in insert order: what a rebuild replays. */
	log: SessionEntry[];
	random: () => number;
	nextId: number;
}

function pick<T>(walk: Walk, items: readonly T[]): T | undefined {
	return items.length === 0 ? undefined : items[Math.floor(walk.random() * items.length)];
}

function insert(walk: Walk, value: SessionEntry): string {
	walk.index.insert(value);
	walk.log.push(value);
	return value.id;
}

function freshId(walk: Walk): string {
	return `e${walk.nextId++}`;
}

/** Each way the index can be mutated, named for the step a failure reports. */
const MUTATIONS: Record<string, (walk: Walk) => string> = {
	"insert on the leaf": walk => insert(walk, entry(freshId(walk), walk.index.leafId())),
	"insert off the leaf": walk => insert(walk, entry(freshId(walk), pick(walk, walk.log)?.id ?? null)),
	"insert a new root": walk => insert(walk, entry(freshId(walk), null)),
	"insert on the leaf reusing an id": walk => {
		const reused = pick(walk, walk.log)?.id ?? freshId(walk);
		return insert(walk, entry(reused, walk.index.leafId()));
	},
	"insert on the leaf with an empty id": walk => insert(walk, entry("", walk.index.leafId())),
	"move the leaf to an entry": walk => {
		const target = pick(walk, walk.log)?.id ?? null;
		walk.index.setLeaf(target);
		return `${target}`;
	},
	"move the leaf to where it is": walk => {
		walk.index.setLeaf(walk.index.leafId());
		return `${walk.index.leafId()}`;
	},
	"move the leaf before the first entry": walk => {
		walk.index.setLeaf(null);
		return "null";
	},
	"move the leaf to an unknown id": walk => {
		walk.index.setLeaf("missing");
		return "missing";
	},
	rebuild: walk => {
		walk.index.rebuild(walk.log);
		return `${walk.log.length} entries`;
	},
	"rebuild one unbranched chain": walk => {
		// The shape a load of a session that never branched rebuilds from, now and then with an id
		// the chain already holds, an empty id, or a parent that is not the entry before it.
		const chain: SessionEntry[] = [];
		const length = 1 + Math.floor(walk.random() * 40);
		for (let i = 0; i < length; i++) {
			const roll = walk.random();
			const id = roll < 0.03 ? "" : roll < 0.06 ? (pick(walk, chain)?.id ?? freshId(walk)) : freshId(walk);
			const parent = walk.random() < 0.03 ? (pick(walk, chain)?.id ?? null) : (chain.at(-1)?.id ?? null);
			chain.push(entry(id, parent));
		}
		walk.index.rebuild(chain);
		walk.log = chain;
		return `${chain.length} entries`;
	},
	clear: walk => {
		walk.index.clear();
		walk.log = [];
		return "";
	},
};

/** Which prototype method each mutation above drives. */
const DRIVEN_METHODS = ["clear", "insert", "rebuild", "setLeaf"];

/** Methods that read the index and change nothing a later read observes. */
const READ_METHODS = [
	"get",
	"has",
	"labelFor",
	"labelsInEffect",
	"leafEntry",
	"leafId",
	"leafPath",
	"pathTo",
	"tree",
	"usageSnapshot",
];

function ids(entries: readonly SessionEntry[]): string[] {
	return entries.map(value => value.id);
}

function expectBranchIsFresh(walk: Walk, step: string): void {
	const { index } = walk;
	const expected = ids(walkBranchPath(index, index.leafEntry()));
	expect({ step, leafPath: ids(index.leafPath()) }).toEqual({ step, leafPath: expected });

	const copy = index.pathTo();
	expect({ step, pathTo: ids(copy) }).toEqual({ step, pathTo: expected });
	copy.push(entry("appended-by-caller", null));
	expect({ step, afterCallerEdit: ids(index.leafPath()) }).toEqual({ step, afterCallerEdit: expected });

	const other = pick(walk, walk.log);
	if (other) {
		// An empty id names no entry to the index, as an empty parent id ends a walk.
		const expectedOther = ids(walkBranchPath(index, other.id === "" ? undefined : index.get(other.id)));
		expect({ step, pathToOther: ids(index.pathTo(other.id)) }).toEqual({ step, pathToOther: expectedOther });
	}
}

describe("the cached active branch is the branch a fresh walk finds", () => {
	it("drives every mutating method of the index", () => {
		const methods = Object.getOwnPropertyNames(SessionEntryIndex.prototype)
			.filter(name => name !== "constructor")
			.sort();
		expect(methods).toEqual([...DRIVEN_METHODS, ...READ_METHODS].sort());
	});

	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`matches a fresh walk after every step of seeded walk ${seed}`, () => {
			const walk: Walk = { index: new SessionEntryIndex(), log: [], random: mulberry32(seed), nextId: 0 };
			const names = Object.keys(MUTATIONS);
			// Appends to the leaf are what a live session mostly does and what extends the cache, so
			// half the steps are one; the rest spread over every other mutation.
			for (let step = 0; step < 1500; step++) {
				const name = walk.random() < 0.5 ? "insert on the leaf" : pick(walk, names)!;
				// A clear discards the branch the walk has grown; keep it rare so branches get long.
				if (name === "clear" && walk.random() < 0.9) continue;
				const detail = MUTATIONS[name]!(walk);
				expectBranchIsFresh(walk, `seed ${seed} step ${step}: ${name} ${detail}`);
			}
		});
	}
});
