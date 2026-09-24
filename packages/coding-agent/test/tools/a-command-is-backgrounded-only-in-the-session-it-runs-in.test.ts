/**
 * Which command a manual background moves, when more than one is waiting.
 *
 * Why this suite exists: the foreground-bash registry held ONE global wait
 * stack. Two windows attached to the same host share that process, so the
 * background request sent from one window resolved whichever command was
 * registered last — reclaiming another window's turn and leaving the
 * requesting window still waiting. The registry is now keyed by session
 * (bash-foreground-registry.ts), and the class this suite closes is every
 * registry operation that could still cross a session boundary: the query,
 * the command line, the request, the release and the change notification.
 *
 * The keys are swept as pairs rather than asserted for one session, because
 * the defect was not specific to a session id: a terminal host registers
 * under `null` and a desktop window under its session id, and `null` reaching
 * a named session is the same defect as one name reaching another.
 *
 * What it does not catch: the wiring from a host action to
 * `requestManualBackground` (that is `bash-manual-background.test.ts` and the
 * gui-host suite), and the bash tool's own conversion of a resolved wait into
 * a background job.
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

/**
 * The session keys a host registers under: a terminal with no session of its
 * own, and two desktop windows. Every pair of distinct keys is swept, so a
 * key that reaches another is caught whichever direction it leaks in.
 */
const KEYS: Array<string | null> = [null, "window-one", "window-two"];

const PAIRS: Array<[string | null, string | null]> = KEYS.flatMap(waiting =>
	KEYS.filter(other => other !== waiting).map((other): [string | null, string | null] => [waiting, other]),
);

function name(session: string | null): string {
	return session ?? "no session";
}

describe("a manual background reaches the session that asked for it", () => {
	beforeEach(() => {
		resetForegroundBashRegistryForTest();
	});

	afterEach(() => {
		resetForegroundBashRegistryForTest();
	});

	for (const [waiting, other] of PAIRS) {
		it(`leaves the wait in ${name(waiting)} alone when ${name(other)} asks`, () => {
			let resolved = 0;
			registerForegroundBashWait(waiting, "bun test", () => resolved++);

			expect(hasForegroundBashWait(other)).toBe(false);
			expect(foregroundBashCommand(other)).toBeUndefined();
			expect(requestManualBackground(other)).toBe(false);
			expect(resolved).toBe(0);

			expect(requestManualBackground(waiting)).toBe(true);
			expect(resolved).toBe(1);
		});

		it(`releasing the wait in ${name(other)} leaves ${name(waiting)} waiting`, () => {
			const order: string[] = [];
			registerForegroundBashWait(waiting, "mine", () => order.push("mine"));
			const release = registerForegroundBashWait(other, "theirs", () => order.push("theirs"));

			release();

			expect(hasForegroundBashWait(other)).toBe(false);
			expect(hasForegroundBashWait(waiting)).toBe(true);
			expect(foregroundBashCommand(waiting)).toBe("mine");
			expect(requestManualBackground(waiting)).toBe(true);
			expect(order).toEqual(["mine"]);
		});
	}

	/** Each session reports its own command line, so a window's control names
	 * the command that window is waiting on. */
	it("reports each session's own command while several wait at once", () => {
		for (const [index, session] of KEYS.entries()) {
			registerForegroundBashWait(session, `command ${index}`, () => {});
		}
		for (const [index, session] of KEYS.entries()) {
			expect(foregroundBashCommand(session)).toBe(`command ${index}`);
			expect(hasForegroundBashWait(session)).toBe(true);
		}
	});

	/** A control repaints from the notification, so a change in one session
	 * must not name another: a window whose command is untouched would draw a
	 * control for a wait it does not have. A request resolves the waiter and
	 * the waiter releases, so the release is what the control hears. */
	it("names only the session whose waits changed", () => {
		const changed: Array<string | null> = [];
		const unsubscribe = onForegroundBashWaitChange(session => changed.push(session));

		const releaseWindow = registerForegroundBashWait("window-one", "sleep 60", () => {});
		const releaseTerminal = registerForegroundBashWait(null, "sleep 90", () => {});
		releaseWindow();
		expect(requestManualBackground(null)).toBe(true);
		releaseTerminal();

		expect(changed).toEqual(["window-one", null, "window-one", null]);
		unsubscribe();
	});

	/** The last wait of a session takes the session out of the registry, so a
	 * window that closes mid-command leaves nothing for the next window
	 * opened under the same id to find. */
	it("forgets a session once its last wait is released", () => {
		const release = registerForegroundBashWait("window-one", "sleep 60", () => {});
		registerForegroundBashWait("window-two", "sleep 90", () => {});

		release();

		expect(hasForegroundBashWait("window-one")).toBe(false);
		expect(foregroundBashCommand("window-one")).toBeUndefined();
		expect(requestManualBackground("window-one")).toBe(false);
		expect(hasForegroundBashWait("window-two")).toBe(true);
	});
});
