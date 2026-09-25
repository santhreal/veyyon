/**
 * WHY: the deferred prune of old addon caches reported a directory it could not remove with
 * `console.error`. The prune fires after the interactive UI has drawn, so the line landed on the
 * terminal between frames, pushed the composer down and left the renderer drawing against rows that
 * had moved. On Windows the common cause was not even a problem: a second, older veyyon still open
 * keeps its own version's addon mapped, Windows refuses to unlink a loaded DLL with EPERM, and every
 * launch of the new version wrote the same line over its own UI.
 *
 * Closed here: a prune notice never goes to stdout or stderr, it waits for a surface when none is
 * attached yet (the prune runs before a session exists) and reaches it once one attaches, it fans
 * out to every attached surface and stops at a detached one, and a cache held by a running process
 * is not reported at all, because a later launch removes it once that process exits. Every other
 * failure is still reported with its path and its reason.
 *
 * NOT closed here: whether a surface renders the notice without disturbing the layout. That is the
 * operator-notice channel's contract, covered by its own suites; this file proves the loader hands
 * the notice to that channel instead of the terminal.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	attachNativeNoticeSink,
	isAddonHeldByRunningProcess,
	type NativeCachePruneReport,
	scheduleStaleNativeCleanup,
} from "../native/loader-state.js";

/** Everything written to the process's own stdout and stderr while a test runs. */
let terminal: string[] = [];
let detachDrain: (() => void) | undefined;

beforeEach(() => {
	terminal = [];
	const capture = (chunk: unknown): boolean => {
		terminal.push(String(chunk));
		return true;
	};
	spyOn(process.stderr, "write").mockImplementation(capture);
	spyOn(process.stdout, "write").mockImplementation(capture);
	spyOn(console, "error").mockImplementation((...args: unknown[]) => void terminal.push(args.join(" ")));
	spyOn(console, "warn").mockImplementation((...args: unknown[]) => void terminal.push(args.join(" ")));
	// Drain anything an earlier test left waiting, so each test starts with an empty queue.
	detachDrain = attachNativeNoticeSink(() => {});
	detachDrain();
});

afterEach(() => {
	detachDrain?.();
	(process.stderr.write as unknown as { mockRestore(): void }).mockRestore();
	(process.stdout.write as unknown as { mockRestore(): void }).mockRestore();
	(console.error as unknown as { mockRestore(): void }).mockRestore();
	(console.warn as unknown as { mockRestore(): void }).mockRestore();
});

/** Run one scheduled prune to completion with a canned report and the default notice route. */
async function prune(report: NativeCachePruneReport): Promise<void> {
	const scheduled = scheduleStaleNativeCleanup({
		nativesDir: "/natives",
		currentVersion: "1.5.4",
		schedule: callback => {
			callback();
			return undefined;
		},
		reclaim: async () => report,
	});
	await scheduled.settled;
}

const stuck = { dir: "/natives/1.5.2", reason: "EACCES: permission denied, rm '/natives/1.5.2'" };
const held = { dir: "/natives/1.5.3", reason: "EPERM: operation not permitted, rm '/natives/1.5.3'" };

describe("a stale addon cache notice never writes over the interactive UI", () => {
	it("hands a failed removal to the attached surface and writes nothing to the terminal", async () => {
		const shown: string[] = [];
		const detach = attachNativeNoticeSink(message => shown.push(message));
		try {
			await prune({ removed: [], failed: [stuck], inUse: [] });
		} finally {
			detach();
		}
		expect(terminal).toEqual([]);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(stuck.dir);
		expect(shown[0]).toContain(stuck.reason);
	});

	it("holds a notice raised before any surface exists and delivers it once one attaches", async () => {
		await prune({ removed: [], failed: [stuck], inUse: [] });
		expect(terminal).toEqual([]);

		const shown: string[] = [];
		const detach = attachNativeNoticeSink(message => shown.push(message));
		detach();
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(stuck.dir);

		// Delivered once: a surface attaching later does not see it again.
		const later: string[] = [];
		const detachLater = attachNativeNoticeSink(message => later.push(message));
		detachLater();
		expect(later).toEqual([]);
	});

	it("reaches every attached surface and stops at one that detached", async () => {
		const first: string[] = [];
		const second: string[] = [];
		const detachFirst = attachNativeNoticeSink(message => first.push(message));
		const detachSecond = attachNativeNoticeSink(message => second.push(message));
		detachFirst();
		try {
			await prune({ removed: [], failed: [stuck], inUse: [] });
		} finally {
			detachSecond();
		}
		expect(first).toEqual([]);
		expect(second).toHaveLength(1);
	});

	it("does not report a cache a running veyyon still holds, and still reports a real failure beside it", async () => {
		const shown: string[] = [];
		const detach = attachNativeNoticeSink(message => shown.push(message));
		try {
			await prune({ removed: [], failed: [stuck], inUse: [held] });
		} finally {
			detach();
		}
		expect(terminal).toEqual([]);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toContain(stuck.dir);
		expect(shown.some(message => message.includes(held.dir))).toBe(false);
	});

	it("a surface that throws does not stop the prune from settling or the next surface from hearing it", async () => {
		const shown: string[] = [];
		const detachBroken = attachNativeNoticeSink(() => {
			throw new Error("surface disposed");
		});
		const detach = attachNativeNoticeSink(message => shown.push(message));
		try {
			await prune({ removed: [], failed: [stuck], inUse: [] });
		} finally {
			detachBroken();
			detach();
		}
		expect(shown).toHaveLength(1);
	});
});

describe("which removal failures mean a running process holds the addon", () => {
	const withCode = (code: string): Error => Object.assign(new Error(`${code}: failed`), { code });

	it.each([
		["win32", "EPERM", true],
		["win32", "EBUSY", true],
		["win32", "EACCES", false],
		["win32", "ENOENT", false],
		["linux", "EPERM", false],
		["linux", "EBUSY", false],
		["darwin", "EPERM", false],
	] as const)("%s %s -> %p", (platform, code, expected) => {
		expect(isAddonHeldByRunningProcess(withCode(code), platform)).toBe(expected);
	});

	it("an error with no code is a real failure", () => {
		expect(isAddonHeldByRunningProcess(new Error("boom"), "win32")).toBe(false);
		expect(isAddonHeldByRunningProcess("EPERM", "win32")).toBe(false);
	});
});
