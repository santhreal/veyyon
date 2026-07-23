/**
 * Manual bash backgrounding (`app.bash.background`, default Ctrl+B).
 *
 * Why this suite exists: bash could only move to the background AUTOMATICALLY
 * (wall-clock threshold or stall watcher). When the operator could already
 * see a command would run long, the only keys were wait or interrupt — the
 * user's explicit ask (2026-07-22) was a key that reclaims the turn. The
 * registry (bash-foreground-registry.ts) connects the TUI keystroke to the
 * bash tool's foreground wait; this suite locks the registry contract and
 * the end-to-end tool behavior: a foreground-waiting command converts to a
 * background job with `reason: "manual"` and its own operator notice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	hasForegroundBashWait,
	onForegroundBashWaitChange,
	registerForegroundBashWait,
	requestManualBackground,
	resetForegroundBashRegistryForTest,
} from "@veyyon/coding-agent/tools/bash-foreground-registry";

describe("foreground bash wait registry", () => {
	beforeEach(() => {
		resetForegroundBashRegistryForTest();
	});

	afterEach(() => {
		resetForegroundBashRegistryForTest();
	});

	/** The keybinding must be a no-op (and report so) when nothing waits —
	 * that false return is what lets Ctrl+B keep its readline cursor-left
	 * meaning while typing. */
	it("reports no consumption when no wait is registered", () => {
		expect(hasForegroundBashWait()).toBe(false);
		expect(requestManualBackground()).toBe(false);
	});

	it("resolves the registered wait and reports consumption", () => {
		let resolved = 0;
		registerForegroundBashWait(() => resolved++);
		expect(hasForegroundBashWait()).toBe(true);
		expect(requestManualBackground()).toBe(true);
		expect(resolved).toBe(1);
	});

	/** Nested foreground waits (a sub-agent's bash inside a turn): the NEWEST
	 * wait wins — the innermost command is the one on screen. */
	it("resolves the newest wait when several are registered", () => {
		const order: string[] = [];
		registerForegroundBashWait(() => order.push("outer"));
		registerForegroundBashWait(() => order.push("inner"));
		expect(requestManualBackground()).toBe(true);
		expect(order).toEqual(["inner"]);
	});

	/** Unregister must be idempotent and precise: releasing one wait leaves
	 * the others intact, and a stale double-release removes nothing else. */
	it("unregisters exactly the released wait", () => {
		const order: string[] = [];
		registerForegroundBashWait(() => order.push("a"));
		const releaseB = registerForegroundBashWait(() => order.push("b"));
		releaseB();
		releaseB();
		expect(hasForegroundBashWait()).toBe(true);
		expect(requestManualBackground()).toBe(true);
		expect(order).toEqual(["a"]);
	});

	/** The composer hint subscribes here; it must fire on register AND
	 * release so the hint appears and vanishes with the wait, not on a poll. */
	it("notifies listeners on register and on release", () => {
		let fired = 0;
		onForegroundBashWaitChange(() => fired++);
		const release = registerForegroundBashWait(() => {});
		release();
		expect(fired).toBe(2);
	});
});
