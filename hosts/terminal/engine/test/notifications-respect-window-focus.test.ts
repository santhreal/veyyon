/**
 * WHY THIS FILE EXISTS. Veyyon fired every desktop notification unconditionally.
 * The turn-completion toast and the `ask` toast arrived while the operator was
 * watching the terminal that produced them, and under an autonomous run
 * (`--yolo`, where no approval prompt ever stops the agent) that is one toast per
 * turn on a screen the operator is already looking at. The reported symptom was
 * "veyyon notifies me for everything regardless of the permission system"; the
 * cause was not the permission system at all (no approval path has ever sent a
 * notification) but a notification gate with no notion of whether anyone needed
 * to be interrupted.
 *
 * THE CLASS, not the incident. The defect is any notification sender that
 * reaches the operator's desktop while the terminal window holds focus. There
 * are three senders in the product (turn completion, the `ask` tool, the
 * `/debug` protocol probe) and two delivery halves per sender (an in-band OSC for
 * terminals that implement one, and a libnotify fan-out for the BEL terminals
 * that do not). Gating one sender, or one half, leaves the rest nagging. So the
 * gate lives in `TerminalInfo.sendNotification`, the single choke point every
 * sender and both halves pass through, and this suite asserts it there:
 *   - suppressed while focus is KNOWN to be held, for both delivery halves and
 *     every notify protocol;
 *   - delivered while focus is unknown (no terminal reported any), which is the
 *     fail-open that keeps terminals without DECSET 1004 behaving as they did;
 *   - delivered while unfocused, which is the whole point of a notification;
 *   - delivered while focused only for a notification that explicitly asks to be
 *     (`deliverWhenFocused`), which is the operator-requested diagnostic.
 *
 * It also pins the transport this depends on: focus reporting is enabled at
 * startup, disabled at teardown, and the two focus sequences are consumed rather
 * than delivered to the editor as stray keystrokes.
 *
 * WHAT IT DOES NOT CATCH. It cannot prove a real terminal emits `CSI I`/`CSI O`,
 * or that a given terminal implements mode 1004 at all; that is the terminal's
 * side of the contract and the `unknown` fail-open is what makes being wrong
 * about it harmless. It does not assert which notifications the product chooses
 * to send (`completion.notify` / `ask.notify` gating lives in the coding-agent
 * package and has its own suites), only that whatever is sent respects focus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as desktopNotify from "@veyyon/tui/desktop-notify";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { NotifyProtocol, TERMINAL } from "@veyyon/tui/terminal-capabilities";
import {
	consumeWindowFocusEvent,
	FOCUS_REPORTING_DISABLE,
	FOCUS_REPORTING_ENABLE,
	isWindowFocused,
	setWindowFocusState,
	type WindowFocusState,
	windowFocusState,
} from "@veyyon/tui/window-focus";
import { setTerminalHeadless } from "@veyyon/utils";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalTmux = Bun.env.TMUX;
const originalZellij = Bun.env.ZELLIJ;
const originalNotifications = Bun.env.VEYYON_NOTIFICATIONS;
const mutableTerminal = TERMINAL as unknown as { notifyProtocol: NotifyProtocol };
const originalNotifyProtocol = mutableTerminal.notifyProtocol;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

/** Captured stdout writes plus the libnotify fan-out, the two halves a toast can arrive through. */
function captureDelivery(): { writes: string[]; dbus: ReturnType<typeof vi.fn> } {
	const writes: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
	vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(true);
	const dbus = vi.fn();
	vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(dbus);
	return { writes, dbus };
}

/** The real ProcessTerminal, started against a faked TTY, so start/stop writes are observable. */
function setupProcessTerminal(): { terminal: ProcessTerminal; writes: string[]; received: string[] } {
	const writes: string[] = [];
	const received: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});

	const terminal = new ProcessTerminal();
	terminal.start(
		data => received.push(data),
		() => {},
	);
	return { terminal, writes, received };
}

let previousHeadless = false;

describe("a desktop notification never interrupts an operator who is looking at the terminal", () => {
	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		delete Bun.env.TMUX;
		delete Bun.env.ZELLIJ;
		// This workspace's CI env sets VEYYON_NOTIFICATIONS=off, which short-circuits
		// sendNotification before the focus gate is reached.
		delete Bun.env.VEYYON_NOTIFICATIONS;
		setWindowFocusState("unknown");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setWindowFocusState("unknown");
		mutableTerminal.notifyProtocol = originalNotifyProtocol;
		restoreEnv("TMUX", originalTmux);
		restoreEnv("ZELLIJ", originalZellij);
		restoreEnv("VEYYON_NOTIFICATIONS", originalNotifications);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	/**
	 * Every delivery shape the gate has to cover, derived from the enum rather than
	 * listed by hand: adding a notify protocol to `NotifyProtocol` puts it in this
	 * table automatically, so a new protocol cannot ship past the gate unnoticed.
	 */
	const protocols = Object.entries(NotifyProtocol) as Array<[string, NotifyProtocol]>;

	it("covers every notify protocol the enum declares", () => {
		expect(protocols.length).toBeGreaterThanOrEqual(3);
	});

	for (const [name, protocol] of protocols) {
		it(`sends nothing at all through ${name} while the window is focused`, () => {
			mutableTerminal.notifyProtocol = protocol;
			const { writes, dbus } = captureDelivery();
			setWindowFocusState("focused");

			TERMINAL.sendNotification({ title: "Session", body: "Complete", type: "completion" });

			expect(writes).toEqual([]);
			expect(dbus).not.toHaveBeenCalled();
		});

		it(`delivers through ${name} while the window is unfocused`, () => {
			mutableTerminal.notifyProtocol = protocol;
			const { writes, dbus } = captureDelivery();
			setWindowFocusState("unfocused");

			TERMINAL.sendNotification({ title: "Session", body: "Complete", type: "completion" });

			const delivered = writes.length > 0 || dbus.mock.calls.length > 0;
			expect(delivered).toBe(true);
		});

		it(`delivers through ${name} while focus is unknown, so a terminal without mode 1004 is unaffected`, () => {
			mutableTerminal.notifyProtocol = protocol;
			const { writes, dbus } = captureDelivery();
			expect(windowFocusState()).toBe("unknown");

			TERMINAL.sendNotification({ title: "Session", body: "Complete", type: "completion" });

			const delivered = writes.length > 0 || dbus.mock.calls.length > 0;
			expect(delivered).toBe(true);
		});
	}

	it("suppresses the libnotify fan-out while focused even though its own gate is open", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Bell;
		const { writes, dbus } = captureDelivery();
		setWindowFocusState("focused");

		TERMINAL.sendNotification({ title: "Veyyon", body: "Waiting for input", type: "ask" });

		// The BEL half and the D-Bus half are both silenced: one gate, both halves.
		expect(writes).toEqual([]);
		expect(dbus).not.toHaveBeenCalled();
	});

	it("suppresses a bare string notification while focused", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { writes, dbus } = captureDelivery();
		setWindowFocusState("focused");

		TERMINAL.sendNotification("ping");

		expect(writes).toEqual([]);
		expect(dbus).not.toHaveBeenCalled();
	});

	it("still delivers a notification that asks to be shown while focused", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Bell;
		const { dbus } = captureDelivery();
		setWindowFocusState("focused");

		TERMINAL.sendNotification({
			title: "Veyyon",
			body: "Terminal protocol test",
			type: "test",
			deliverWhenFocused: true,
		});

		expect(dbus).toHaveBeenCalledTimes(1);
	});

	it("keeps suppressing under tmux, where the wrapped OSC is a separate delivery path", () => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { writes } = captureDelivery();
		setWindowFocusState("focused");

		TERMINAL.sendNotification("ping");

		expect(writes).toEqual([]);
	});

	it("keeps suppressing under Zellij, the other early-return delivery path", () => {
		Bun.env.ZELLIJ = "0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc9;
		const { writes } = captureDelivery();
		setWindowFocusState("focused");

		TERMINAL.sendNotification("ping");

		expect(writes).toEqual([]);
	});
});

describe("focus reporting is what tells the gate anything", () => {
	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		setWindowFocusState("unknown");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setWindowFocusState("unknown");
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	/** Only these two sequences mean focus. Everything else is input and must stay input. */
	const sequences: Array<{ sequence: string; expected: WindowFocusState | "not a focus event" }> = [
		{ sequence: "\x1b[I", expected: "focused" },
		{ sequence: "\x1b[O", expected: "unfocused" },
		{ sequence: "\x1b[A", expected: "not a focus event" },
		{ sequence: "\x1b[1;2I", expected: "not a focus event" },
		{ sequence: "\x1b[200~", expected: "not a focus event" },
		{ sequence: "I", expected: "not a focus event" },
		{ sequence: "O", expected: "not a focus event" },
		{ sequence: "\x1b[i", expected: "not a focus event" },
	];

	for (const { sequence, expected } of sequences) {
		it(`reads ${JSON.stringify(sequence)} as ${expected}`, () => {
			setWindowFocusState("unfocused");
			const consumed = consumeWindowFocusEvent(sequence);
			if (expected === "not a focus event") {
				expect(consumed).toBe(false);
				expect(windowFocusState()).toBe("unfocused");
				return;
			}
			expect(consumed).toBe(true);
			expect(windowFocusState()).toBe(expected);
			expect(isWindowFocused()).toBe(expected === "focused");
		});
	}

	it("enables focus reporting when the terminal starts and disables it when it stops", () => {
		const { terminal, writes } = setupProcessTerminal();
		try {
			expect(writes.some(write => write.includes(FOCUS_REPORTING_ENABLE))).toBe(true);
		} finally {
			terminal.stop();
		}
		expect(writes.some(write => write.includes(FOCUS_REPORTING_DISABLE))).toBe(true);
	});

	it("starts from 'nothing reported yet', so a stale focused state cannot swallow notifications", () => {
		setWindowFocusState("focused");
		const { terminal } = setupProcessTerminal();
		try {
			expect(windowFocusState()).toBe("unknown");
		} finally {
			terminal.stop();
		}
	});

	it("forgets the reported focus when the terminal is handed back", () => {
		const { terminal } = setupProcessTerminal();
		process.stdin.emit("data", "\x1b[I");
		expect(windowFocusState()).toBe("focused");
		terminal.stop();
		expect(windowFocusState()).toBe("unknown");
	});

	it("routes real focus reports off stdin into the state without delivering them as keystrokes", () => {
		const { terminal, received } = setupProcessTerminal();
		try {
			process.stdin.emit("data", "\x1b[O");
			expect(windowFocusState()).toBe("unfocused");
			process.stdin.emit("data", "\x1b[I");
			expect(windowFocusState()).toBe("focused");
			// A focus report is not a keystroke. Forwarding it put `\x1b[I` into the
			// editor on any terminal a previous application had left in mode 1004.
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("still delivers ordinary input while focus reporting is on", () => {
		const { terminal, received } = setupProcessTerminal();
		try {
			process.stdin.emit("data", "hello");
			process.stdin.emit("data", "\x1b[A");
			// The buffer decides its own batching (plain text arrives per character,
			// an escape sequence arrives whole), so assert the bytes that reached the
			// editor rather than how they were grouped.
			expect(received.join("")).toBe("hello\x1b[A");
		} finally {
			terminal.stop();
		}
	});
});
