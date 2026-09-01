import { describe, expect, it } from "bun:test";
import { exponentialBackoffDelay } from "../src/backoff";
import { RingBuffer } from "../src/ring";
import { Snowflake } from "../src/snowflake";

describe("exponentialBackoffDelay", () => {
	it("returns base delay for attempt 0 with no jitter", () => {
		const result = exponentialBackoffDelay(0, { baseMs: 1000, jitter: 0, random: () => 0 });
		expect(result).toBe(1000);
	});
	it("doubles delay per attempt", () => {
		const opts = { jitter: 0, random: () => 0 };
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
		expect(exponentialBackoffDelay(1, opts)).toBe(2000);
		expect(exponentialBackoffDelay(2, opts)).toBe(4000);
		expect(exponentialBackoffDelay(3, opts)).toBe(8000);
	});
	it("caps at maxMs", () => {
		const result = exponentialBackoffDelay(100, { baseMs: 1000, maxMs: 30000, jitter: 0, random: () => 0 });
		expect(result).toBe(30000);
	});
	it("applies jitter with random=0 (minimum jitter)", () => {
		const result = exponentialBackoffDelay(0, { baseMs: 1000, jitter: 0.25, random: () => 0 });
		// capped * (1 - 0.25 + 0 * 0.5) = 1000 * 0.75
		expect(result).toBe(750);
	});
	it("applies jitter with random=1 (maximum jitter)", () => {
		const result = exponentialBackoffDelay(0, { baseMs: 1000, jitter: 0.25, random: () => 1 });
		// capped * (1 - 0.25 + 1 * 0.5) = 1000 * 1.25
		expect(result).toBe(1250);
	});
	it("applies jitter with random=0.5 (center)", () => {
		const result = exponentialBackoffDelay(0, { baseMs: 1000, jitter: 0.25, random: () => 0.5 });
		// capped * (1 - 0.25 + 0.5 * 0.5) = 1000 * 1.0
		expect(result).toBe(1000);
	});
	it("uses default options when none provided", () => {
		const result = exponentialBackoffDelay(0, { jitter: 0, random: () => 0 });
		expect(result).toBe(1000);
	});
	it("handles custom baseMs", () => {
		const result = exponentialBackoffDelay(0, { baseMs: 500, jitter: 0, random: () => 0 });
		expect(result).toBe(500);
	});
	it("handles zero jitter", () => {
		const result = exponentialBackoffDelay(5, { baseMs: 1000, maxMs: 30000, jitter: 0, random: () => 0.5 });
		expect(result).toBe(30000);
	});
});

describe("RingBuffer", () => {
	it("starts empty", () => {
		const ring = new RingBuffer<number>(5);
		expect(ring.isEmpty).toBe(true);
		expect(ring.length).toBe(0);
		expect(ring.isFull).toBe(false);
	});
	it("pushes items up to capacity", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		expect(ring.length).toBe(3);
		expect(ring.isFull).toBe(true);
		expect(ring.toArray()).toEqual([1, 2, 3]);
	});
	it("overwrites oldest when full and returns it", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		const overwritten = ring.push(4);
		expect(overwritten).toBe(1);
		expect(ring.toArray()).toEqual([2, 3, 4]);
	});
	it("shifts from front", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		expect(ring.shift()).toBe(1);
		expect(ring.length).toBe(1);
		expect(ring.toArray()).toEqual([2]);
	});
	it("shift returns undefined when empty", () => {
		const ring = new RingBuffer<number>(3);
		expect(ring.shift()).toBeUndefined();
	});
	it("pops from back", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		expect(ring.pop()).toBe(2);
		expect(ring.length).toBe(1);
		expect(ring.toArray()).toEqual([1]);
	});
	it("pop returns undefined when empty", () => {
		const ring = new RingBuffer<number>(3);
		expect(ring.pop()).toBeUndefined();
	});
	it("unshifts to front", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(2);
		ring.push(3);
		ring.unshift(1);
		expect(ring.toArray()).toEqual([1, 2, 3]);
	});
	it("unshift overwrites when full and returns overwritten", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		const overwritten = ring.unshift(0);
		expect(overwritten).toBe(3);
		expect(ring.toArray()).toEqual([0, 1, 2]);
	});
	it("accesses by index with at()", () => {
		const ring = new RingBuffer<number>(5);
		ring.push(10);
		ring.push(20);
		ring.push(30);
		expect(ring.at(0)).toBe(10);
		expect(ring.at(1)).toBe(20);
		expect(ring.at(2)).toBe(30);
	});
	it("at() supports negative index", () => {
		const ring = new RingBuffer<number>(5);
		ring.push(10);
		ring.push(20);
		ring.push(30);
		expect(ring.at(-1)).toBe(30);
		expect(ring.at(-2)).toBe(20);
	});
	it("at() returns undefined for out-of-bounds", () => {
		const ring = new RingBuffer<number>(5);
		ring.push(10);
		expect(ring.at(5)).toBeUndefined();
		expect(ring.at(-10)).toBeUndefined();
	});
	it("peek returns first element", () => {
		const ring = new RingBuffer<number>(5);
		ring.push(10);
		ring.push(20);
		expect(ring.peek()).toBe(10);
	});
	it("peekBack returns last element", () => {
		const ring = new RingBuffer<number>(5);
		ring.push(10);
		ring.push(20);
		expect(ring.peekBack()).toBe(20);
	});
	it("clears buffer", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		ring.clear();
		expect(ring.isEmpty).toBe(true);
		expect(ring.length).toBe(0);
		expect(ring.toArray()).toEqual([]);
	});
	it("iterates in order", () => {
		const ring = new RingBuffer<number>(5);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		const items: number[] = [];
		for (const item of ring) items.push(item);
		expect(items).toEqual([1, 2, 3]);
	});
	it("handles wrap-around correctly in toArray", () => {
		const ring = new RingBuffer<number>(3);
		ring.push(1);
		ring.push(2);
		ring.push(3);
		ring.push(4); // overwrites 1
		ring.push(5); // overwrites 2
		expect(ring.toArray()).toEqual([3, 4, 5]);
	});
	it("handles capacity 1", () => {
		const ring = new RingBuffer<number>(1);
		ring.push(1);
		expect(ring.isFull).toBe(true);
		const overwritten = ring.push(2);
		expect(overwritten).toBe(1);
		expect(ring.toArray()).toEqual([2]);
	});
});

describe("Snowflake", () => {
	it("PATTERN matches 16 hex chars", () => {
		expect(Snowflake.PATTERN.test("0123456789abcdef")).toBe(true);
		expect(Snowflake.PATTERN.test("0123456789abcde")).toBe(false);
		expect(Snowflake.PATTERN.test("0123456789abcdefg")).toBe(false);
	});
	it("EPOCH_TIMESTAMP is 1420070400000", () => {
		expect(Snowflake.EPOCH_TIMESTAMP).toBe(1420070400000);
	});
	it("formatParts produces valid snowflake", () => {
		const sf = Snowflake.formatParts(1000000, 42);
		expect(Snowflake.valid(sf)).toBe(true);
	});
	it("valid returns true for generated snowflake", () => {
		const sf = Snowflake.next();
		expect(Snowflake.valid(sf)).toBe(true);
	});
	it("valid returns false for invalid strings", () => {
		expect(Snowflake.valid("")).toBe(false);
		expect(Snowflake.valid("short")).toBe(false);
		expect(Snowflake.valid("0123456789abcdeg")).toBe(false);
	});
	it("getSequence extracts sequence from snowflake", () => {
		const sf = Snowflake.formatParts(0, 42);
		expect(Snowflake.getSequence(sf)).toBe(42);
	});
	it("getTimestamp extracts timestamp from snowflake", () => {
		const dt = 1000000;
		const sf = Snowflake.formatParts(dt, 0);
		expect(Snowflake.getTimestamp(sf)).toBe(dt + Snowflake.EPOCH_TIMESTAMP);
	});
	it("getDate returns Date from snowflake", () => {
		const dt = 1000000;
		const sf = Snowflake.formatParts(dt, 0);
		const date = Snowflake.getDate(sf);
		expect(date.getTime()).toBe(dt + Snowflake.EPOCH_TIMESTAMP);
	});
	it("Source generates incrementing sequences", () => {
		const source = new Snowflake.Source(0);
		const sf1 = source.generate(Snowflake.EPOCH_TIMESTAMP + 1000);
		const sf2 = source.generate(Snowflake.EPOCH_TIMESTAMP + 1000);
		expect(Snowflake.getSequence(sf1)).toBe(1);
		expect(Snowflake.getSequence(sf2)).toBe(2);
	});
	it("Source.reset resets sequence to 0", () => {
		const source = new Snowflake.Source(0);
		source.generate(Snowflake.EPOCH_TIMESTAMP + 1000);
		source.generate(Snowflake.EPOCH_TIMESTAMP + 1000);
		source.reset();
		expect(source.sequence).toBe(0);
	});
	it("lowerbound with Date", () => {
		const date = new Date(Snowflake.EPOCH_TIMESTAMP + 5000);
		const lb = Snowflake.lowerbound(date);
		expect(Snowflake.valid(lb)).toBe(true);
		expect(Snowflake.getSequence(lb)).toBe(0);
	});
	it("lowerbound with number", () => {
		const lb = Snowflake.lowerbound(Snowflake.EPOCH_TIMESTAMP + 5000);
		expect(Snowflake.valid(lb)).toBe(true);
		expect(Snowflake.getSequence(lb)).toBe(0);
	});
	it("lowerbound with Snowflake string returns it as-is", () => {
		const sf = Snowflake.formatParts(1000, 42);
		expect(Snowflake.lowerbound(sf)).toBe(sf);
	});
	it("upperbound with Date has max sequence", () => {
		const date = new Date(Snowflake.EPOCH_TIMESTAMP + 5000);
		const ub = Snowflake.upperbound(date);
		expect(Snowflake.valid(ub)).toBe(true);
		expect(Snowflake.getSequence(ub)).toBe(Snowflake.MAX_SEQUENCE);
	});
	it("upperbound with number has max sequence", () => {
		const ub = Snowflake.upperbound(Snowflake.EPOCH_TIMESTAMP + 5000);
		expect(Snowflake.getSequence(ub)).toBe(Snowflake.MAX_SEQUENCE);
	});
	it("upperbound with Snowflake string returns it as-is", () => {
		const sf = Snowflake.formatParts(1000, 42);
		expect(Snowflake.upperbound(sf)).toBe(sf);
	});
	it("MAX_SEQUENCE is 0x3fffff", () => {
		expect(Snowflake.MAX_SEQUENCE).toBe(0x3fffff);
	});
	it("next generates valid snowflakes", () => {
		const sf1 = Snowflake.next();
		const sf2 = Snowflake.next();
		expect(Snowflake.valid(sf1)).toBe(true);
		expect(Snowflake.valid(sf2)).toBe(true);
	});
	it("sequence wraps at MAX_SEQUENCE", () => {
		const source = new Snowflake.Source(Snowflake.MAX_SEQUENCE - 1);
		const sf1 = source.generate(Snowflake.EPOCH_TIMESTAMP + 1000);
		expect(Snowflake.getSequence(sf1)).toBe(Snowflake.MAX_SEQUENCE);
		const sf2 = source.generate(Snowflake.EPOCH_TIMESTAMP + 1000);
		expect(Snowflake.getSequence(sf2)).toBe(0);
	});
});
