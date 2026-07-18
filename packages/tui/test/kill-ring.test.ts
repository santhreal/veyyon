/**
 * Unit coverage for the Emacs-style kill ring (kill-ring.ts).
 *
 * The ring is pure data structure logic behind Ctrl-K/Ctrl-W/Ctrl-Y and
 * yank-pop in input.ts and editor.ts. It had zero direct tests, yet it owns
 * two easy-to-break invariants: the accumulate merge direction (backward vs
 * forward deletion) and the bounded entry cap (a runaway kill loop must not
 * grow the ring without limit). These lock exact values for both.
 */
import { describe, expect, it } from "bun:test";
import { KillRing } from "@veyyon/tui/kill-ring";

// Mirror of the module-private cap; the eviction test asserts against it.
const MAX_ENTRIES = 60;

describe("KillRing", () => {
	it("starts empty and peeks undefined", () => {
		const ring = new KillRing();
		expect(ring.length).toBe(0);
		expect(ring.peek()).toBeUndefined();
	});

	it("ignores empty pushes so a no-op kill never creates an entry", () => {
		const ring = new KillRing();
		ring.push("", { prepend: false });
		ring.push("", { prepend: true, accumulate: true });
		expect(ring.length).toBe(0);
		expect(ring.peek()).toBeUndefined();
	});

	it("pushes a distinct entry per non-accumulating kill", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		expect(ring.length).toBe(2);
		expect(ring.peek()).toBe("b");
	});

	it("appends to the most recent entry when accumulating a forward deletion", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false, accumulate: true });
		ring.push("c", { prepend: false, accumulate: true });
		expect(ring.length).toBe(1);
		expect(ring.peek()).toBe("abc");
	});

	it("prepends to the most recent entry when accumulating a backward deletion", () => {
		const ring = new KillRing();
		ring.push("c", { prepend: true });
		ring.push("b", { prepend: true, accumulate: true });
		ring.push("a", { prepend: true, accumulate: true });
		expect(ring.length).toBe(1);
		expect(ring.peek()).toBe("abc");
	});

	it("treats accumulate on an empty ring as a fresh entry, not a crash", () => {
		const ring = new KillRing();
		ring.push("x", { prepend: false, accumulate: true });
		expect(ring.length).toBe(1);
		expect(ring.peek()).toBe("x");
	});

	it("interleaves accumulate and fresh kills correctly", () => {
		const ring = new KillRing();
		ring.push("foo", { prepend: false });
		ring.push("bar", { prepend: false, accumulate: true }); // -> "foobar"
		ring.push("baz", { prepend: false }); // fresh entry
		expect(ring.length).toBe(2);
		expect(ring.peek()).toBe("baz");
		ring.rotate();
		expect(ring.peek()).toBe("foobar");
	});

	it("caps the ring at MAX_ENTRIES, evicting the oldest entry", () => {
		const ring = new KillRing();
		for (let i = 0; i <= MAX_ENTRIES; i++) {
			ring.push(`e${i}`, { prepend: false });
		}
		// MAX_ENTRIES + 1 pushes -> length capped, oldest (e0) dropped.
		expect(ring.length).toBe(MAX_ENTRIES);
		expect(ring.peek()).toBe(`e${MAX_ENTRIES}`);
		// Rotate all the way around: e1 (now the oldest surviving entry) must be
		// reachable, proving e0 was the only one evicted.
		const seen = new Set<string>();
		for (let i = 0; i < MAX_ENTRIES; i++) {
			seen.add(ring.peek()!);
			ring.rotate();
		}
		expect(seen.has("e0")).toBe(false);
		expect(seen.has("e1")).toBe(true);
		expect(seen.has(`e${MAX_ENTRIES}`)).toBe(true);
		expect(seen.size).toBe(MAX_ENTRIES);
	});

	it("rotate cycles the most recent entry to the back of the yank order", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		ring.push("c", { prepend: false }); // order (oldest..newest) [a,b,c], peek c
		ring.rotate(); // [c,a,b], peek b
		expect(ring.peek()).toBe("b");
		ring.rotate(); // [b,c,a], peek a
		expect(ring.peek()).toBe("a");
		ring.rotate(); // [a,b,c], peek c
		expect(ring.peek()).toBe("c");
	});

	it("rotate is a no-op with zero or one entry", () => {
		const ring = new KillRing();
		ring.rotate();
		expect(ring.peek()).toBeUndefined();
		ring.push("only", { prepend: false });
		ring.rotate();
		expect(ring.peek()).toBe("only");
		expect(ring.length).toBe(1);
	});

	it("peek never mutates the ring", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		expect(ring.peek()).toBe("b");
		expect(ring.peek()).toBe("b");
		expect(ring.length).toBe(2);
	});
});
