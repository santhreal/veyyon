import { describe, expect, it } from "bun:test";
import { ColdEntryPayloads, coldFieldsOf, MIN_COLD_STRING_LENGTH } from "@veyyon/kernel/session/session-cold-payloads";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";

/**
 * WHY: cooling an entry replaces each large field with an accessor and records which fields it
 * replaced, as a key list every entry with the same cooled fields shares. The list is found by
 * walking a trie of field names as the entry's keys are read, and the keys are read with `for...in`
 * filtered by `Object.hasOwn`. A walk that confuses two orders of the same fields, returns the list
 * of a longer path for its prefix, drops a field, or takes an enumerable prototype property for an
 * own field records the wrong fields: a read-back restores fields the entry never had, or leaves a
 * moved field behind an accessor that nothing restores, and the entry serializes differently from
 * its line.
 *
 * The class this closes: over generated entries, message and non-message, with fields in random
 * order and each value small, long, an object or null, the cooled fields are exactly the own large
 * fields in key order, each held behind an accessor and every other field held as a value, entries
 * with the same cooled fields share one list, the entry and its message stand-in keep their key
 * order, and every entry serializes back to its line. Fields an entry inherits are neither moved nor
 * copied onto the stand-in.
 *
 * What it does NOT catch: blob references, which the generator never writes, and the read-back of a
 * line whose bytes changed under the handle; the session manager suites cover both.
 */

/** A deterministic generator, so a failing seed reproduces. */
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

const FIELD_NAMES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const LONG = "x".repeat(MIN_COLD_STRING_LENGTH);
const ENTRY_RESIDENT = new Set(["type", "id", "parentId", "timestamp"]);
const MESSAGE_ENTRY_RESIDENT = new Set([...ENTRY_RESIDENT, "message"]);

function isLargeValue(value: unknown): boolean {
	return typeof value === "string"
		? value.length >= MIN_COLD_STRING_LENGTH
		: typeof value === "object" && value !== null;
}

/** The own fields of `record` outside `resident` that cooling moves, in key order. */
function expectedLarge(record: Record<string, unknown>, resident: ReadonlySet<string>): string[] {
	return Object.keys(record).filter(key => !resident.has(key) && isLargeValue(record[key]));
}

/** The own keys of `target` held behind an accessor rather than as a value, in key order. */
function accessorKeys(target: Record<string, unknown>): string[] {
	return Object.keys(target).filter(key => Object.getOwnPropertyDescriptor(target, key)!.get !== undefined);
}

/** A random subset of the field names in random order, each with a small, long, object or null value. */
function randomFields(random: () => number, target: Record<string, unknown>): void {
	const names = [...FIELD_NAMES];
	for (let i = names.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[names[i], names[j]] = [names[j]!, names[i]!];
	}
	const count = Math.floor(random() * (names.length + 1));
	for (const name of names.slice(0, count)) {
		const roll = random();
		target[name] =
			roll < 0.3
				? "small"
				: roll < 0.55
					? `${LONG}${name}`
					: roll < 0.8
						? { nested: [name, 1] }
						: roll < 0.9
							? null
							: 7;
	}
}

function generate(seed: number, count: number): Record<string, unknown>[] {
	const random = mulberry32(seed);
	const records: Record<string, unknown>[] = [];
	for (let i = 0; i < count; i++) {
		const base: Record<string, unknown> = {
			id: `s${seed}-${i}`,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		if (random() < 0.5) {
			const message: Record<string, unknown> = { role: "toolResult" };
			randomFields(random, message);
			const entry: Record<string, unknown> = { type: "message", ...base, message };
			if (random() < 0.3) randomFields(random, entry);
			records.push(entry);
		} else {
			const entry: Record<string, unknown> = { type: "compaction", ...base };
			randomFields(random, entry);
			records.push(entry);
		}
	}
	return records;
}

/** Payloads pinned on a reader that returns the line recorded at each offset. */
function pinnedPayloads(lines: readonly string[]): ColdEntryPayloads {
	const payloads = new ColdEntryPayloads();
	const reader = {
		identity: "test:1",
		read: (offset: number) => lines[offset]!,
		close: () => {},
	};
	const pinned = payloads.pin(
		"test:1",
		() => reader,
		line => JSON.parse(line) as SessionEntry,
	);
	expect(pinned).toBe(true);
	return payloads;
}

describe("a cold entry lists its own large fields in key order", () => {
	for (const seed of [1, 2, 3, 4]) {
		it(`moves exactly the own large fields, shares each list, and serializes back to its line (seed ${seed})`, () => {
			const records = generate(seed, 400);
			const lines = records.map(record => JSON.stringify(record));
			const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>);
			const payloads = pinnedPayloads(lines);
			const shared = new Map<string, readonly string[]>();
			let cooledWithMessage = 0;
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i]!;
				const original = records[i]!;
				const nested = original.type === "message" ? (original.message as Record<string, unknown>) : undefined;
				const entryKeys = expectedLarge(original, nested === undefined ? ENTRY_RESIDENT : MESSAGE_ENTRY_RESIDENT);
				const messageKeys = nested === undefined ? [] : expectedLarge(nested, new Set());
				const cooled = payloads.cool(entry as unknown as SessionEntry, i, 2048);
				expect(cooled).toBe(entryKeys.length > 0 || messageKeys.length > 0);
				if (!cooled) {
					expect(coldFieldsOf(entry)).toBeUndefined();
					continue;
				}
				const listed = coldFieldsOf(entry)!;
				expect([...listed]).toEqual(entryKeys);
				const known = shared.get(`e:${entryKeys.join(",")}`) ?? listed;
				expect(listed).toBe(known);
				shared.set(`e:${entryKeys.join(",")}`, listed);
				expect(Object.keys(entry)).toEqual(Object.keys(original));
				const standsIn = nested !== undefined && messageKeys.length > 0;
				expect(accessorKeys(entry)).toEqual(
					expectedLarge(original, standsIn ? ENTRY_RESIDENT : MESSAGE_ENTRY_RESIDENT),
				);
				if (standsIn) {
					cooledWithMessage += 1;
					const standIn = entry.message as Record<string, unknown>;
					const listedMessage = coldFieldsOf(standIn)!;
					expect([...listedMessage]).toEqual(messageKeys);
					const knownMessage = shared.get(`m:${messageKeys.join(",")}`) ?? listedMessage;
					expect(listedMessage).toBe(knownMessage);
					shared.set(`m:${messageKeys.join(",")}`, listedMessage);
					expect(Object.keys(standIn)).toEqual(Object.keys(nested));
					expect(accessorKeys(standIn)).toEqual(messageKeys);
				}
			}
			expect(cooledWithMessage).toBeGreaterThan(0);
			for (let i = 0; i < entries.length; i++) {
				expect(JSON.stringify(entries[i])).toBe(lines[i]!);
				expect(coldFieldsOf(entries[i]!)).toBeUndefined();
			}
		});
	}

	it("returns a prefix's own list, not the list of a longer path through it", () => {
		const records = [
			{ type: "compaction", id: "long", parentId: null, timestamp: "t", alpha: LONG, beta: LONG },
			{ type: "compaction", id: "prefix", parentId: null, timestamp: "t", alpha: LONG, beta: "small" },
			{ type: "compaction", id: "swapped", parentId: null, timestamp: "t", beta: LONG, alpha: LONG },
		];
		const lines = records.map(record => JSON.stringify(record));
		const entries = lines.map(line => JSON.parse(line) as SessionEntry);
		const payloads = pinnedPayloads(lines);
		for (let i = 0; i < entries.length; i++) expect(payloads.cool(entries[i]!, i, 2048)).toBe(true);
		expect(entries.map(entry => [...coldFieldsOf(entry)!])).toEqual([
			["alpha", "beta"],
			["alpha"],
			["beta", "alpha"],
		]);
	});

	it("neither moves nor copies a field the entry or its message inherits", () => {
		const inherited = { inheritedPayload: LONG };
		const message = Object.assign(Object.create(inherited) as Record<string, unknown>, {
			role: "toolResult",
			content: [{ type: "text", text: LONG }],
		});
		const entry = Object.assign(Object.create(inherited) as Record<string, unknown>, {
			type: "message",
			id: "own",
			parentId: null,
			timestamp: "t",
			message,
			extra: LONG,
		});
		const line = JSON.stringify(entry);
		const payloads = pinnedPayloads([line]);
		expect(payloads.cool(entry as unknown as SessionEntry, 0, 2048)).toBe(true);
		expect([...coldFieldsOf(entry)!]).toEqual(["extra"]);
		const standIn = entry.message as Record<string, unknown>;
		expect([...coldFieldsOf(standIn)!]).toEqual(["content"]);
		expect(Object.keys(standIn)).toEqual(["role", "content"]);
		expect(Object.hasOwn(entry, "inheritedPayload")).toBe(false);
		expect(JSON.stringify(entry)).toBe(line);
	});
});
