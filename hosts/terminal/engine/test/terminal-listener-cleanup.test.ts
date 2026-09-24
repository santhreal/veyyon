import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalHeadless } from "@veyyon/utils";

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
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
	});

	it("does not leak resize listeners when start() is called repeatedly", () => {
		terminal = new ProcessTerminal();
		const initialListeners = process.stdout.listenerCount("resize");

		// Call start() multiple times without stop() in between
		terminal.start(
			() => {},
			() => {},
		);
		terminal.start(
			() => {},
			() => {},
		);
		terminal.start(
			() => {},
			() => {},
		);

		// Only exactly one resize listener should be attached to stdout for this terminal
		expect(process.stdout.listenerCount("resize")).toBe(initialListeners + 1);

		terminal.stop();
		expect(process.stdout.listenerCount("resize")).toBe(initialListeners);
	});
});
