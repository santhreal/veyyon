import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalHeadless } from "@veyyon/utils";

/**
 * WHY: `start()` on a running `ProcessTerminal` installed a second stdout `resize`
 * listener and a second stdin `data` reader. `stop()` removes only the newest of each,
 * so the older reader stayed on stdin with a destroyed buffer: the next byte any later
 * reader received threw inside it, and a test file that restarted a terminal broke
 * every later file that fed stdin.
 *
 * The class this closes: repeated starts hold one listener per event that one start
 * holds, and `stop()` returns stdin and stdout to the listeners they had before. The
 * events are read from the emitters at run time, so a listener a later change adds is
 * counted without naming it here.
 *
 * What it does NOT catch: listeners on emitters other than stdin and stdout, such as
 * process signal handlers.
 */

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

function listenerCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [name, emitter] of [
		["stdin", process.stdin],
		["stdout", process.stdout],
	] as const) {
		for (const event of emitter.eventNames()) {
			const count = emitter.listenerCount(event);
			if (count > 0) counts[`${name}:${String(event)}`] = count;
		}
	}
	return counts;
}

describe("ProcessTerminal listener cleanup", () => {
	let previousHeadless: boolean;
	let terminal: ProcessTerminal | undefined;

	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTty);
		restoreProperty(process.stdout, "isTTY", stdoutIsTty);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	});

	it("holds one listener per event however often start() runs, and stop() removes them", () => {
		const before = listenerCounts();
		terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		const once = listenerCounts();
		terminal.start(
			() => {},
			() => {},
		);
		terminal.start(
			() => {},
			() => {},
		);

		expect(once["stdin:data"]).toBe((before["stdin:data"] ?? 0) + 1);
		expect(listenerCounts()).toEqual(once);
		terminal.stop();
		expect(listenerCounts()).toEqual(before);
	});

	it("delivers stdin to the latest start() once, without the reader it replaced", () => {
		const received: string[] = [];
		terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(`first:${data}`),
			() => {},
		);
		terminal.start(
			data => received.push(`second:${data}`),
			() => {},
		);

		process.stdin.emit("data", "x");
		terminal.stop();
		// A reader left over from the first start would throw here, on a destroyed buffer.
		expect(() => process.stdin.emit("data", "y")).not.toThrow();
		expect(received).toEqual(["second:x"]);
	});
});
