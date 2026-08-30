import "./warm-natives"; // load the native addon under the real platform before any process.platform mock
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ENHANCED_PASTE_MODE, ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalHeadless } from "@veyyon/utils";

/**
 * WHY. Veyyon wrote `CSI ? 5522 h` at every startup to arm kitty-style enhanced
 * paste. No shipping emulator implements that DEC private mode -- kitty, the
 * terminal the ancillary spec was written for, answers it with
 * `[PARSE ERROR] Unsupported screen mode: 5522 (private)` in its own log, and
 * answers the matching reset the same way. So the feature never armed anywhere,
 * and every session wrote two parse errors into the user's terminal log for a
 * capability nobody had. Captured verbatim from a recording rig's `term.log`,
 * with the emitting bytes found in the app's raw pty output immediately after
 * the DECRQM batch.
 *
 * THE CLASS. An escape that asks a terminal to change mode is never written
 * before that terminal has said it implements the mode, and the paired reset is
 * never written unless the set was. The DECRQM probe and its DA1 sentinel are
 * what make that knowable: every probe resolves, including on terminals that
 * ignore DECRQM entirely, so "wait for the answer" is not "wait forever".
 *
 * The suite drives the real `ProcessTerminal` -- its actual start(), its actual
 * DECRPM parser, its actual stop() -- with stdout captured and DECRPM replies
 * injected on stdin, because the defect was in which bytes reach the terminal
 * and nothing short of the real write path can observe that.
 *
 * WHAT THIS DOES NOT CATCH. It pins mode 5522, the one mode whose set is gated
 * on a report, and the status sweep is pinned against a literal table rather
 * than against the predicate the parser uses, so a change to what a status
 * MEANS shows up here as a failure to explain rather than a silent pass. It does
 * not prove kitty stays quiet for the DECRQM query itself (that is a claim about
 * kitty's parser, checked against a real kitty log, not something a unit test
 * can assert), and it says nothing about the other modes the TUI sets outright
 * -- 2004, 2026, 2031 are set unconditionally by design and are a different
 * decision, not this one.
 */

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

const SET = `\x1b[?${ENHANCED_PASTE_MODE}h`;
const RESET = `\x1b[?${ENHANCED_PASTE_MODE}l`;
const QUERY = `\x1b[?${ENHANCED_PASTE_MODE}$p`;

/** DECRPM status -> whether the mode is implemented, per DEC STD 070: 1 set,
 *  2 reset, 3 permanently set, 4 permanently reset, 0 not recognized. Pinned as
 *  a literal so a change in how a status is read fails here by name. */
const STATUS_MEANS_SUPPORTED: ReadonlyArray<[status: number, supported: boolean]> = [
	[0, false],
	[1, true],
	[2, true],
	[3, true],
	[4, false],
];

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("an unconfirmed terminal mode is never set", () => {
	let previousHeadless = false;

	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	function setup() {
		const writes: string[] = [];
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
			() => {},
			() => {},
		);
		const sent = () => writes.join("");
		return { terminal, sent };
	}

	function report(status: number): void {
		process.stdin.emit("data", `\x1b[?${ENHANCED_PASTE_MODE};${status}$y`);
	}

	it("asks about the mode at startup instead of setting it", () => {
		const { terminal, sent } = setup();
		expect(sent()).toContain(QUERY);
		expect(sent()).not.toContain(SET);
		terminal.stop();
	});

	it("holds the set while the answer is outstanding", () => {
		const { terminal, sent } = setup();
		terminal.requestEnhancedPaste();
		expect(sent()).not.toContain(SET);
		terminal.stop();
	});

	for (const [status, supported] of STATUS_MEANS_SUPPORTED) {
		it(`${supported ? "sets" : "refuses"} the mode after a DECRPM status of ${status}`, () => {
			const { terminal, sent } = setup();
			terminal.requestEnhancedPaste();
			report(status);
			expect(sent().includes(SET)).toBe(supported);
			terminal.stop();
			// The reset rides on the set: a terminal that never armed is never asked
			// to un-arm, which is what keeps the parse error out of its log.
			expect(sent().includes(RESET)).toBe(supported);
		});
	}

	it("sets the mode when the answer arrived before the request", () => {
		const { terminal, sent } = setup();
		report(1);
		expect(sent()).not.toContain(SET);
		terminal.requestEnhancedPaste();
		expect(sent()).toContain(SET);
		terminal.stop();
	});

	it("never sets the mode nobody asked for, however positive the answer", () => {
		const { terminal, sent } = setup();
		report(1);
		expect(sent()).not.toContain(SET);
		terminal.stop();
		expect(sent()).not.toContain(RESET);
	});

	it("writes one set for repeated requests and repeated answers", () => {
		const { terminal, sent } = setup();
		terminal.requestEnhancedPaste();
		terminal.requestEnhancedPaste();
		report(1);
		report(1);
		terminal.requestEnhancedPaste();
		expect(sent().split(SET).length - 1).toBe(1);
		terminal.stop();
		expect(sent().split(RESET).length - 1).toBe(1);
	});

	it("leaves no reset behind when the session never armed the mode", () => {
		const { terminal, sent } = setup();
		terminal.requestEnhancedPaste();
		report(0);
		terminal.stop();
		expect(sent()).not.toContain(RESET);
		expect(sent()).not.toContain(SET);
	});
});
