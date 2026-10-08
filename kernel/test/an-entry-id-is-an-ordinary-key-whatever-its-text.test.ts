import { describe, expect, it } from "bun:test";
import { walkBranchPath } from "@veyyon/kernel/session/session-context";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionEntryIndex } from "@veyyon/kernel/session/session-entry-index";

/**
 * WHY: `SessionEntryIndex` keys its entries by id in a plain object rather than a `Map`, which holds
 * half the memory. A plain object has keys that mean something to it: an object with a prototype
 * answers `toString` or `constructor` for an id never inserted, assigning `__proto__` replaces its
 * prototype instead of storing an entry, and a key that reads as an array index is stored apart from
 * the others. A session whose ids hit one of these would resume on a branch its entries do not form.
 *
 * The class this closes: for every key an object treats specially, the index answers `has`, `get`,
 * `leafPath` and `pathTo` as a `Map` keyed by the same ids does, after `insert` and after `rebuild`,
 * and holds none of them after `clear`. The special keys are read from `Object.prototype` at run
 * time, so a name an engine adds is covered without editing this file; the field names of an entry
 * and the array-index forms are listed.
 *
 * What it does NOT catch: the empty id. The walk and the leaf lookup treat an empty id as no id, as
 * they did over a `Map`, so it is left out rather than compared.
 */

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function entry(id: string, parentId: string | null): SessionEntry {
	return { type: "model_change", id, parentId, timestamp: TIMESTAMP, model: `provider/${id}` };
}

const SPECIAL_IDS = [
	...Object.getOwnPropertyNames(Object.prototype),
	// An entry's own fields: an index whose storage became an entry's prototype answers these.
	...Object.keys(entry("x", null)),
	// Canonical array indices, the largest one, and forms that only look like one.
	"0",
	"12345678",
	"4294967294",
	"4294967295",
	"-1",
	"01",
	"1e3",
];

function ids(entries: readonly SessionEntry[]): string[] {
	return entries.map(value => value.id);
}

/** One chain whose ids are the special keys, each the parent of the next. */
function chain(): SessionEntry[] {
	// A repeated id would shadow its first entry and leave that key untested.
	expect(new Set(SPECIAL_IDS).size).toBe(SPECIAL_IDS.length);
	return SPECIAL_IDS.map((id, at) => entry(id, at === 0 ? null : SPECIAL_IDS[at - 1]!));
}

const FILLS = {
	insert: (index: SessionEntryIndex, entries: SessionEntry[]) => {
		for (const value of entries) index.insert(value);
	},
	rebuild: (index: SessionEntryIndex, entries: SessionEntry[]) => index.rebuild(entries),
};

describe("an entry id is an ordinary key whatever its text", () => {
	for (const [fill, run] of Object.entries(FILLS)) {
		it(`finds each special id after ${fill} as a Map does`, () => {
			const entries = chain();
			const reference = new Map(entries.map(value => [value.id, value]));
			const index = new SessionEntryIndex();
			run(index, entries);

			for (const value of entries) {
				expect({ id: value.id, has: index.has(value.id), same: index.get(value.id) === value }).toEqual({
					id: value.id,
					has: true,
					same: true,
				});
				expect({ id: value.id, path: ids(index.pathTo(value.id)) }).toEqual({
					id: value.id,
					path: ids(walkBranchPath(reference, value)),
				});
			}
			expect(ids(index.leafPath())).toEqual(SPECIAL_IDS);
			expect(index.leafEntry()).toBe(entries[entries.length - 1]);
		});
	}

	it("answers nothing for a special id it was never given", () => {
		const index = new SessionEntryIndex();
		index.insert(entry("e1", null));
		const reference = new Map([["e1", entry("e1", null)]]);

		for (const id of SPECIAL_IDS) {
			expect({ id, has: index.has(id), got: index.get(id), path: ids(index.pathTo(id)) }).toEqual({
				id,
				has: reference.has(id),
				got: undefined,
				path: ids(walkBranchPath(reference, reference.get(id))),
			});
		}
		expect(ids(index.leafPath())).toEqual(["e1"]);
	});

	it("holds no special id after clear", () => {
		const index = new SessionEntryIndex();
		index.rebuild(chain());
		index.clear();

		expect(SPECIAL_IDS.filter(id => index.has(id) || index.get(id) !== undefined)).toEqual([]);
		expect(index.leafPath()).toEqual([]);
	});
});
