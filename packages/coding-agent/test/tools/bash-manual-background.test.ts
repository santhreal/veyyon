/**
 * Manual bash backgrounding (`app.bash.background`, default Ctrl+B, and the
 * desktop's background control).
 *
 * Why this suite exists: bash could only move to the background AUTOMATICALLY
 * (wall-clock threshold or stall watcher). When the operator could already see
 * a command would run long, the only keys were wait or interrupt — the required
 * behavior was a key that reclaims the turn. The registry
 * (bash-foreground-registry.ts) connects a host's request to the bash tool's
 * foreground wait; this suite locks the registry contract and the end-to-end
 * tool behavior: a foreground-waiting command converts to a background job with
 * `reason: "manual"` and its own operator notice.
 *
 * A wait is keyed by the session its command runs in, so the request one
 * window sends reaches its own command and no other window's. The cross-session
 * invariants are in
 * `a-command-is-backgrounded-only-in-the-session-it-runs-in.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	foregroundBashCommand,
	hasForegroundBashWait,
	onForegroundBashWaitChange,
	registerForegroundBashWait,
	requestManualBackground,
	resetForegroundBashRegistryForTest,
} from "@veyyon/coding-agent/tools/shell/bash-foreground-registry";

const SESSION = "session-under-test";

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
		expect(hasForegroundBashWait(SESSION)).toBe(false);
		expect(foregroundBashCommand(SESSION)).toBeUndefined();
		expect(requestManualBackground(SESSION)).toBe(false);
	});

	it("resolves the registered wait and reports consumption", () => {
		let resolved = 0;
		registerForegroundBashWait(SESSION, "bun test", () => resolved++);
		expect(hasForegroundBashWait(SESSION)).toBe(true);
		expect(foregroundBashCommand(SESSION)).toBe("bun test");
		expect(requestManualBackground(SESSION)).toBe(true);
		expect(resolved).toBe(1);
	});

	/** Nested foreground waits (an agent's bash inside a turn): the NEWEST
	 * wait wins — the innermost command is the one on screen. */
	it("resolves the newest wait when several are registered", () => {
		const order: string[] = [];
		registerForegroundBashWait(SESSION, "outer", () => order.push("outer"));
		registerForegroundBashWait(SESSION, "inner", () => order.push("inner"));
		expect(foregroundBashCommand(SESSION)).toBe("inner");
		expect(requestManualBackground(SESSION)).toBe(true);
		expect(order).toEqual(["inner"]);
	});

	/** Unregister must be idempotent and precise: releasing one wait leaves
	 * the others intact, and a stale double-release removes nothing else. */
	it("unregisters exactly the released wait", () => {
		const order: string[] = [];
		registerForegroundBashWait(SESSION, "a", () => order.push("a"));
		const releaseB = registerForegroundBashWait(SESSION, "b", () => order.push("b"));
		releaseB();
		releaseB();
		expect(hasForegroundBashWait(SESSION)).toBe(true);
		expect(foregroundBashCommand(SESSION)).toBe("a");
		expect(requestManualBackground(SESSION)).toBe(true);
		expect(order).toEqual(["a"]);
	});

	/** A control subscribes here; it must fire on register AND release so the
	 * control appears and vanishes with the wait, not on a poll, and name the
	 * session that changed so one window's control does not repaint for
	 * another's command. */
	it("notifies listeners with the session that changed, on register and on release", () => {
		const changed: Array<string | null> = [];
		onForegroundBashWaitChange(session => changed.push(session));
		const release = registerForegroundBashWait(SESSION, "sleep 60", () => {});
		release();
		expect(changed).toEqual([SESSION, SESSION]);
	});
});
