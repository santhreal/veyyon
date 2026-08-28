import { type Component, TUI } from "@veyyon/tui";
import { ProcessTerminal } from "@veyyon/tui/terminal";
import { setTerminalHeadless } from "@veyyon/utils";

const GRAB = "\x1b[?1000h\x1b[?1006h";
const RELEASE = "\x1b[?1006l\x1b[?1000l";
const WHEEL_UP = "\x1b[<64;5;5M";
const PAST_IDLE_MS = 4_000;

class Transcript implements Component {
	lines: string[] = Array.from({ length: 40 }, (_, i) => `hist-${i}`);
	renders = 0;
	invalidate(): void {}
	render(): readonly string[] {
		this.renders += 1;
		return this.lines;
	}
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail: string): void {
	if (ok) process.stderr.write(`  PASS  ${label}\n`);
	else {
		process.stderr.write(`  FAIL  ${label} -- ${detail}\n`);
		failures.push(label);
	}
}

setTerminalHeadless(false);
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 12, configurable: true });

let captured = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => {
	captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
	return true;
}) as typeof process.stdout.write;

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
tui.setScrollbackRebuild(false);
const transcript = new Transcript();
tui.addChild(transcript);
tui.setScrollIsolation(true);

try {
	tui.start();
	await Bun.sleep(200);

	process.stderr.write("\nmouse grab / idle release -- wall clock, real scheduler\n\n");

	check("grabs at startup, before any keystroke", captured.includes(GRAB), "no grab bytes after start");

	captured = "";
	const rendersBeforeIdle = transcript.renders;
	await Bun.sleep(PAST_IDLE_MS);
	const rendersDuringIdle = transcript.renders - rendersBeforeIdle;
	check(
		`releases after ${PAST_IDLE_MS}ms idle (native drag-select returns)`,
		captured.includes(RELEASE),
		"no release bytes after the idle window elapsed in real time",
	);
	check(
		"the idle timer alone drives the release (no repaint in the window)",
		rendersDuringIdle === 0 && captured.includes(RELEASE),
		`${rendersDuringIdle} repaint(s) occurred while idle, so the backstop timer is unproven here`,
	);

	captured = "";
	process.stdin.emit("data", "x");
	await Bun.sleep(200);
	check("re-takes the grab on the next keystroke", captured.includes(GRAB), "keystroke did not re-arm the grab");

	process.stdin.emit("data", WHEEL_UP);
	await Bun.sleep(200);
	const frozen = tui.virtualScrollActive;
	captured = "";
	await Bun.sleep(PAST_IDLE_MS);
	check(
		"never releases while the transcript is frozen off the live tail",
		frozen && !captured.includes(RELEASE),
		frozen ? "released the grab while frozen -- the wheel would fall through mid-scroll" : "wheel did not freeze",
	);

	captured = "";
	tui.stop();
	check("releases on stop", captured.includes(RELEASE), "stop() left the terminal grabbed");
} finally {
	process.stdout.write = realWrite;
}

process.stderr.write(
	failures.length === 0 ? "\nall checks passed\n" : `\n${failures.length} FAILED: ${failures.join(", ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
