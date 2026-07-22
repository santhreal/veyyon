import { describe, expect, it } from "bun:test";
import { IdleTimeout } from "@veyyon/coding-agent/eval/idle-timeout";

/**
 * IdleTimeout is the eval-cell watchdog: it aborts a cell that sits idle past its
 * window, but host-side bridge calls (agent()/parallel()/completion()) pause it so
 * delegated work does not count against the window, and pause is reference-counted
 * because parallel() has several bridge calls in flight at once. It had no test. A
 * regression here either kills a healthy long-delegating cell early or lets a hung
 * cell run forever. These pin the input clamp and the pause/resume/dispose state
 * machine with real (short) timers and generous waits to stay non-flaky.
 *
 * The expiry test also locks a real fix: Bun retains an asynchronously-set abort
 * reason only while an "abort" listener is registered on the signal, and this test
 * deliberately registers NONE of its own before reading signal.reason. Before the
 * fix (an anchoring no-op listener inside the watchdog) the reason read back as
 * undefined, so a consumer reading signal.reason synchronously would misclassify a
 * genuine idle timeout as a plain cancel.
 */

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const WINDOW = 30;
const PAST = 140; // comfortably longer than one window

describe("IdleTimeout construction", () => {
	it("clamps the window to a positive integer", () => {
		expect(new IdleTimeout(0).idleMs).toBe(1);
		expect(new IdleTimeout(-5).idleMs).toBe(1);
		expect(new IdleTimeout(7.9).idleMs).toBe(7);
	});

	it("does not abort before the window elapses", () => {
		const t = new IdleTimeout(10_000);
		expect(t.signal.aborted).toBe(false);
		t.dispose();
	});
});

describe("IdleTimeout expiry", () => {
	it("aborts with a TimeoutError reason readable without an abort listener (regression)", async () => {
		const t = new IdleTimeout(WINDOW);
		// Intentionally attach no "abort" listener before reading reason below.
		await wait(PAST);
		expect(t.signal.aborted).toBe(true);
		const reason = t.signal.reason;
		expect(reason).toBeInstanceOf(DOMException);
		expect((reason as DOMException).name).toBe("TimeoutError");
	});

	it("does not abort after dispose", async () => {
		const t = new IdleTimeout(WINDOW);
		t.dispose();
		await wait(PAST);
		expect(t.signal.aborted).toBe(false);
	});
});

describe("IdleTimeout pause/resume", () => {
	it("suspends the window while paused, then a fresh window runs after resume", async () => {
		const t = new IdleTimeout(WINDOW);
		t.pause();
		await wait(PAST);
		expect(t.signal.aborted).toBe(false); // paused work is not counted
		t.resume();
		await wait(PAST);
		expect(t.signal.aborted).toBe(true);
		t.dispose();
	});

	it("is reference-counted: it stays paused until every pause is matched by a resume", async () => {
		const t = new IdleTimeout(WINDOW);
		t.pause();
		t.pause();
		t.resume(); // depth 2 -> 1, still paused
		await wait(PAST);
		expect(t.signal.aborted).toBe(false);
		t.resume(); // depth 1 -> 0, window re-armed
		await wait(PAST);
		expect(t.signal.aborted).toBe(true);
		t.dispose();
	});

	it("ignores a resume with no matching pause (no early re-arm, no throw)", async () => {
		const t = new IdleTimeout(10_000);
		expect(() => t.resume()).not.toThrow();
		await wait(WINDOW * 2);
		expect(t.signal.aborted).toBe(false);
		t.dispose();
	});

	it("ignores pause/resume after dispose", async () => {
		const t = new IdleTimeout(WINDOW);
		t.dispose();
		t.pause();
		t.resume();
		await wait(PAST);
		expect(t.signal.aborted).toBe(false);
	});

	it("ignores pause/resume after the watchdog has already fired", async () => {
		// A settled watchdog must stay settled: late bridge activity arriving after the
		// idle abort must never un-abort or re-arm it, or a timed-out cell could resurrect.
		const t = new IdleTimeout(WINDOW);
		await wait(PAST);
		expect(t.signal.aborted).toBe(true);
		t.pause();
		t.resume();
		expect(t.signal.aborted).toBe(true);
		t.dispose();
	});
});
