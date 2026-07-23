/**
 * Cursor conversation caches are bounded (resource-leak regression).
 *
 * The bug this suite locks out (HUNT2-resleak-cursor-conversation-cache, found
 * 2026-07-22): `conversationStateCache` and `conversationBlobStores` were plain
 * module-level Maps keyed by conversationId. A long-lived process — an
 * autonomous run touching many conversations, or many short sessions with random
 * ids — accumulated one entry per conversation for the process lifetime, an
 * unbounded leak of conversation state and blob bytes. The fix backs both caches
 * with `BoundedLruMap`, which evicts the least-recently-used entry past its cap
 * and refreshes recency on BOTH get and set so an actively-streamed conversation
 * is never evicted mid-round.
 *
 * These tests assert real eviction and real recency behavior with exact keys,
 * not merely that the type exists.
 */
import { describe, expect, it } from "bun:test";
import { BoundedLruMap } from "@veyyon/ai/providers/cursor";

describe("BoundedLruMap — bounded cursor conversation caches", () => {
	it("evicts the least-recently-used entry once the cap is exceeded", () => {
		const cache = new BoundedLruMap<string, number>(3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		// Fourth insertion evicts the oldest ("a"); the rest survive with values.
		cache.set("d", 4);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
		expect(cache.get("d")).toBe(4);
	});

	it("never grows past the cap no matter how many distinct keys arrive", () => {
		const max = 8;
		const cache = new BoundedLruMap<number, number>(max);
		// Simulate a run touching 500 distinct conversation ids.
		for (let i = 0; i < 500; i++) cache.set(i, i * 10);
		// Only the last `max` ids remain; everything older is gone.
		let present = 0;
		for (let i = 0; i < 500; i++) if (cache.get(i) !== undefined) present++;
		expect(present).toBe(max);
		expect(cache.get(499)).toBe(4990);
		expect(cache.get(492)).toBe(4920);
		expect(cache.get(491)).toBeUndefined();
	});

	it("get refreshes recency so an actively-read entry outlives newer ones", () => {
		const cache = new BoundedLruMap<string, number>(3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		// Touch "a" — it is now the most-recently-used, so the NEXT eviction must
		// drop "b" (the new oldest), not "a". This is the in-flight-round guard.
		expect(cache.get("a")).toBe(1);
		cache.set("d", 4);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
		expect(cache.get("d")).toBe(4);
	});

	it("set on an existing key refreshes recency and replaces the value", () => {
		const cache = new BoundedLruMap<string, number>(3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		// Re-set "a": updates the value AND moves it to most-recent, so "b" is next out.
		cache.set("a", 100);
		cache.set("d", 4);
		expect(cache.get("a")).toBe(100);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBe(3);
		expect(cache.get("d")).toBe(4);
	});

	it("keeps entries whose recency was refreshed by a preceding get chain", () => {
		// A conversation streamed across several rounds is get() then set() every
		// round; over many other conversations arriving between its rounds it must
		// still be resident. Models the real cursor.ts access pattern.
		const cache = new BoundedLruMap<string, number>(4);
		cache.set("live", 0);
		for (let round = 1; round <= 50; round++) {
			// Other conversations churn through.
			cache.set(`other-${round}-x`, round);
			cache.set(`other-${round}-y`, round);
			// The live conversation is touched each round (get then re-set), as the
			// provider does with conversationStateCache.
			expect(cache.get("live")).toBe(round - 1);
			cache.set("live", round);
		}
		expect(cache.get("live")).toBe(50);
	});
});
