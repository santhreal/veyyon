/**
 * A recording is replayed only when it still describes the screen this launch would paint.
 *
 * THE DEFECT CLASS. The replay writes recorded bytes straight to fd 1 before anything is loaded,
 * and then tells the renderer the terminal holds the recorded rows. Both halves are trusted
 * without being checked against reality, because checking would cost the graph load the replay
 * exists to skip. Everything therefore rests on the validity test: a recording that no longer
 * describes this terminal, this configuration or this binary must be discarded, silently and
 * without a read of it reaching the screen. A field that is recorded and not compared is a card
 * from someone else's terminal painted onto this one, and the renderer will not correct it,
 * because it was told those rows are already right.
 *
 * ENUMERATED FROM THE FILE. The validity arms do not work from a list of fields somebody typed.
 * They walk the recording the writer actually produced, and fail on a field they have no
 * corruption for, so a field added to `FirstFrameRecording` turns this red until someone decides
 * whether it is load-bearing. The environment arms sweep `RECORDED_ENV_KEYS` the same way.
 *
 * WHAT IT DOES NOT CATCH. That the recorded BYTES paint the recorded ROWS. Nothing in this process
 * runs a terminal, so the two are only asserted to travel together; the pairing itself is proved
 * in `packages/tui/test/a-screen-someone-else-painted-is-adopted-or-repainted.test.ts`, against a
 * real VT parser. Nor does it catch a terminal that reports a size it does not have, which no
 * amount of recording can survive.
 *
 * Four type guards in `asRecording` are not independently observable, because a later check
 * rejects the same input: the `cols`/`rows` and env-entry guards are backstopped by the value
 * comparisons in `replayFirstFrame`, and the `screen` and `env` object guards are backstopped by a
 * property read that throws into the catch. Deleting any of them keeps this suite green. They stay
 * because they are what makes the returned `FirstFrameRecording` type true rather than asserted,
 * and the arms that feed a null `screen` and a null `env` pin the catch their fallback depends on.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearFirstFrameRecording,
	isBareInteractiveLaunch,
	RECORDED_ENV_KEYS,
	recordFirstFrame,
	replayFirstFrame,
	takeReplayedFirstFrame,
} from "../src/cli/first-frame-replay";

const COLS = 100;
const ROWS = 30;

/** The rows a launch card recording carries, standing in for the composed card. */
const SCREEN = {
	window: ["veyyon", "", "> ", "", ""],
	frameLength: 3,
	width: COLS,
	height: ROWS,
	cursorRow: 2,
	windowTopRow: 0,
};
const BYTES = "\x1b[2Jveyyon\r\n\r\n> ";
const TIP = "press ? for shortcuts";

/** Everything a test changed about the process, undone after it whatever it asserted. */
const undo: (() => void)[] = [];

afterEach(() => {
	while (undo.length > 0) undo.pop()?.();
	takeReplayedFirstFrame();
});

function setEnv(key: string, value: string | undefined): void {
	const previous = process.env[key];
	undo.push(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function stub<T extends object>(target: T, key: keyof T, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(target, key);
	undo.push(() => {
		if (previous) Object.defineProperty(target, key, previous);
		else delete target[key];
	});
	Object.defineProperty(target, key, { configurable: true, value, writable: true });
}

/**
 * A bare interactive launch of the recorded size, writing to a scratch recording of its own.
 *
 * Both the argv and the two TTY flags are stubbed because the module reads them directly: it runs
 * before the argument parser exists, which is the whole reason it can answer only this one shape
 * of command line.
 */
function bareLaunch(): { readonly file: string; readonly written: () => string[] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-first-frame-"));
	undo.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "first-frame.json");
	setEnv("VEYYON_FIRST_FRAME_CACHE", file);
	// A recorded variable left set by the surrounding process would be compared against a recording
	// this test wrote with it set too, so the sweep below needs a known starting state, not an
	// empty one: `TERM` present and everything else absent is the state every arm starts from.
	for (const key of RECORDED_ENV_KEYS) setEnv(key, key === "TERM" ? "xterm-256color" : undefined);
	stub(process, "argv", [process.execPath, "veyyon"]);
	stub(process.stdin, "isTTY", true);
	stub(process.stdout, "isTTY", true);
	stub(process.stdout, "columns", COLS);
	stub(process.stdout, "rows", ROWS);
	// The replay writes to fd 1 by number, so the only seam is the module's own `fs`. Captured
	// rather than let through: this suite's stdout is the test runner's.
	const writes: string[] = [];
	const real = fs.writeSync;
	const spy = spyOn(fs, "writeSync").mockImplementation(((fd: number, data: string): number => {
		if (fd === 1 && typeof data === "string") {
			writes.push(data);
			return data.length;
		}
		return (real as (fd: number, data: string) => number)(fd, data);
	}) as typeof fs.writeSync);
	undo.push(() => spy.mockRestore());
	return { file, written: () => writes };
}

function recordOne(): void {
	recordFirstFrame({ bytes: BYTES, cols: COLS, rows: ROWS, screen: SCREEN, tip: TIP });
}

function readRecording(file: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function writeRecording(file: string, recording: unknown): void {
	fs.writeFileSync(file, JSON.stringify(recording));
}

describe("a recording of the launch card", () => {
	it("replays the bytes it recorded and hands back the screen they painted", () => {
		const launch = bareLaunch();
		recordOne();
		replayFirstFrame();
		expect(launch.written()).toEqual([BYTES]);
		expect(takeReplayedFirstFrame()).toEqual({ screen: SCREEN, tip: TIP });
	});

	it("hands the screen back once, so a later frame composes against the screen as it then is", () => {
		bareLaunch();
		recordOne();
		replayFirstFrame();
		expect(takeReplayedFirstFrame()).toBeDefined();
		expect(takeReplayedFirstFrame()).toBeUndefined();
	});

	it("leaves no partial file behind, because the reader is the next process's first read", () => {
		const launch = bareLaunch();
		recordOne();
		expect(fs.readdirSync(path.dirname(launch.file))).toEqual(["first-frame.json"]);
	});

	it("is gone after it is cleared, and clearing one that is already gone is not an error", () => {
		const launch = bareLaunch();
		recordOne();
		clearFirstFrameRecording();
		clearFirstFrameRecording();
		expect(fs.existsSync(launch.file)).toBe(false);
		replayFirstFrame();
		expect(launch.written()).toEqual([]);
	});
});

/**
 * How to break each field of the recording, and how to break each field of the objects nested in
 * it. Every entry must make the recording describe a screen this launch would not paint; the arm
 * asserts nothing is written.
 *
 * Keyed by the dotted path the walker below produces, so an unlisted field is a test failure and
 * not a silently uncovered one.
 */
const CORRUPTIONS: Record<string, (recording: Record<string, unknown>) => void> = {
	// A shape from an older build. Every field below is read positionally by a validator that has
	// already decided the shape is current, so this is the check that makes the rest safe.
	version: r => {
		r.version = 1;
	},
	cols: r => {
		r.cols = COLS - 1;
	},
	rows: r => {
		r.rows = ROWS - 1;
	},
	bytes: r => {
		r.bytes = 42;
	},
	tip: r => {
		r.tip = null;
	},
	// The recording ages out so the welcome tip rotates; a recording older than the window is a
	// card that would show yesterday's tip forever on a terminal that never changes size.
	recordedAtMs: r => {
		r.recordedAtMs = Date.now() - 24 * 60 * 60 * 1000 - 1;
	},
	"env.TERM": r => {
		(r.env as Record<string, string>).TERM = "dumb";
	},
	"binary.path": r => {
		(r.binary as Record<string, unknown>).path = "/nowhere/veyyon";
	},
	"binary.mtimeMs": r => {
		(r.binary as Record<string, unknown>).mtimeMs = 0;
	},
	"binary.size": r => {
		(r.binary as Record<string, unknown>).size = 1;
	},
	"screen.window": r => {
		(r.screen as Record<string, unknown>).window = [1, 2];
	},
	"screen.frameLength": r => {
		(r.screen as Record<string, unknown>).frameLength = "three";
	},
	"screen.width": r => {
		(r.screen as Record<string, unknown>).width = 1.5;
	},
	"screen.height": r => {
		(r.screen as Record<string, unknown>).height = null;
	},
	"screen.cursorRow": r => {
		(r.screen as Record<string, unknown>).cursorRow = "2";
	},
	"screen.windowTopRow": r => {
		delete (r.screen as Record<string, unknown>).windowTopRow;
	},
};

/** Every leaf and every object field of the recording, as dotted paths. */
function fieldPaths(value: Record<string, unknown>, prefix = ""): string[] {
	const paths: string[] = [];
	for (const [key, entry] of Object.entries(value)) {
		const at = prefix === "" ? key : `${prefix}.${key}`;
		if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
			paths.push(...fieldPaths(entry as Record<string, unknown>, at));
			continue;
		}
		paths.push(at);
	}
	return paths;
}

/** Every field whose value is a nested object, as dotted paths. */
function containerPaths(value: Record<string, unknown>, prefix = ""): string[] {
	const paths: string[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const at = prefix === "" ? key : `${prefix}.${key}`;
		paths.push(at, ...containerPaths(entry as Record<string, unknown>, at));
	}
	return paths;
}

function setAt(recording: Record<string, unknown>, at: string, value: unknown): void {
	const parts = at.split(".");
	let cursor = recording;
	for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
	cursor[parts[parts.length - 1] as string] = value;
}

/** A value of a type the field never holds, so reading it as its declared type is a lie. */
function wrongType(value: unknown): unknown {
	return typeof value === "number" ? "not a number" : 0;
}

function valueAt(recording: Record<string, unknown>, at: string): unknown {
	let cursor: unknown = recording;
	for (const part of at.split(".")) cursor = (cursor as Record<string, unknown>)[part];
	return cursor;
}

describe("every field a recording carries", () => {
	it("has a corruption, so a new one fails until someone decides it is load-bearing", () => {
		const launch = bareLaunch();
		recordOne();
		expect(fieldPaths(readRecording(launch.file)).sort()).toEqual(Object.keys(CORRUPTIONS).sort());
	});

	for (const [field, corrupt] of Object.entries(CORRUPTIONS)) {
		it(`is not replayed when ${field} does not describe this launch`, () => {
			const launch = bareLaunch();
			recordOne();
			const recording = readRecording(launch.file);
			corrupt(recording);
			writeRecording(launch.file, recording);
			replayFirstFrame();
			expect(launch.written()).toEqual([]);
			expect(takeReplayedFirstFrame()).toBeUndefined();
		});
	}
});

/**
 * The shape the writer produces, read back once so the sweep below enumerates the fields that
 * exist rather than the fields someone remembered. Probing unwinds itself, leaving no stub set.
 */
function probeShape(): Record<string, unknown> {
	const depth = undo.length;
	const launch = bareLaunch();
	recordOne();
	const recording = readRecording(launch.file);
	while (undo.length > depth) undo.pop()?.();
	takeReplayedFirstFrame();
	return recording;
}

const SHAPE = probeShape();

describe("every field read as a type it does not hold", () => {
	// A stale value is caught by comparing it. A wrong-typed value is caught only by a type guard,
	// and a missing type guard is invisible until a truncated or foreign file reaches the reader,
	// which is the one case that has no other check in front of it.
	for (const at of fieldPaths(SHAPE)) {
		it(`is not replayed when ${at} is not the type the reader trusts`, () => {
			const launch = bareLaunch();
			recordOne();
			const recording = readRecording(launch.file);
			setAt(recording, at, wrongType(valueAt(recording, at)));
			writeRecording(launch.file, recording);
			replayFirstFrame();
			expect(launch.written()).toEqual([]);
			expect(takeReplayedFirstFrame()).toBeUndefined();
		});
	}

	for (const at of containerPaths(SHAPE)) {
		for (const [label, value] of [
			["null", null],
			["a number", 0],
		] as const) {
			it(`is not replayed when ${at} is ${label} instead of an object`, () => {
				const launch = bareLaunch();
				recordOne();
				const recording = readRecording(launch.file);
				setAt(recording, at, value);
				writeRecording(launch.file, recording);
				replayFirstFrame();
				expect(launch.written()).toEqual([]);
				expect(takeReplayedFirstFrame()).toBeUndefined();
			});
		}
	}

	it("sweeps a field that is not empty, so a shape change cannot silently empty it", () => {
		expect(fieldPaths(SHAPE).length).toBeGreaterThan(0);
		expect(containerPaths(SHAPE).sort()).toEqual(["binary", "env", "screen"]);
	});
});

describe("every environment variable the frame is a function of", () => {
	for (const key of RECORDED_ENV_KEYS) {
		it(`is not replayed when ${key} changed after the recording`, () => {
			const launch = bareLaunch();
			recordOne();
			setEnv(key, "changed-after-the-recording");
			replayFirstFrame();
			expect(launch.written()).toEqual([]);
		});

		it(`is not replayed when ${key} was unset after the recording`, () => {
			const launch = bareLaunch();
			setEnv(key, "set-while-recording");
			recordOne();
			setEnv(key, undefined);
			replayFirstFrame();
			expect(launch.written()).toEqual([]);
		});
	}
});

describe("a recording that cannot be trusted", () => {
	it("is not replayed when there is none", () => {
		const launch = bareLaunch();
		replayFirstFrame();
		expect(launch.written()).toEqual([]);
	});

	it("is not replayed when the file is not JSON", () => {
		const launch = bareLaunch();
		recordOne();
		fs.writeFileSync(launch.file, "{ this is not");
		replayFirstFrame();
		expect(launch.written()).toEqual([]);
	});

	it("is not replayed when the file is JSON that is not an object", () => {
		const launch = bareLaunch();
		fs.mkdirSync(path.dirname(launch.file), { recursive: true });
		fs.writeFileSync(launch.file, '"a string"');
		replayFirstFrame();
		expect(launch.written()).toEqual([]);
	});

	it("is not replayed when the bytes are empty, which would paint nothing and claim a screen", () => {
		const launch = bareLaunch();
		recordOne();
		const recording = readRecording(launch.file);
		recording.bytes = "";
		writeRecording(launch.file, recording);
		replayFirstFrame();
		expect(launch.written()).toEqual([]);
		expect(takeReplayedFirstFrame()).toBeUndefined();
	});

	// This runs before the CLI's import graph, so there is no error reporting yet and no handler
	// above it. A throw here is not a failed replay, it is a launch that exits before it prints.
	// Two of the type guards fall through to a property read on null rather than to a comparison,
	// which is safe only because of this, so nothing may remove it.
	for (const [label, body] of [
		["a directory where the file should be", undefined],
		["a screen that is null", '{"version":2,"screen":null}'],
		["an environment that is null", '{"version":2,"env":null}'],
		["a truncated write", '{"version":2,"cols":'],
		["an array", "[]"],
		["a bare number", "7"],
	] as const) {
		it(`does not throw out of the launch on ${label}`, () => {
			const launch = bareLaunch();
			if (body === undefined) fs.mkdirSync(launch.file, { recursive: true });
			else fs.writeFileSync(launch.file, body);
			let threw: unknown;
			try {
				replayFirstFrame();
			} catch (error) {
				threw = error;
			}
			expect(threw).toBeUndefined();
			expect(launch.written()).toEqual([]);
			expect(takeReplayedFirstFrame()).toBeUndefined();
		});
	}
});

describe("the launch a recording may be replayed onto", () => {
	it("is a bare command line on a terminal", () => {
		bareLaunch();
		expect(isBareInteractiveLaunch()).toBe(true);
	});

	it("is not a command line carrying an argument, whatever the argument would have done", () => {
		const launch = bareLaunch();
		recordOne();
		stub(process, "argv", [process.execPath, "veyyon", "--version"]);
		expect(isBareInteractiveLaunch()).toBe(false);
		replayFirstFrame();
		expect(launch.written()).toEqual([]);
	});

	it("is not a pipe on either side, where the bytes would land in somebody's output", () => {
		for (const stream of [process.stdin, process.stdout]) {
			const launch = bareLaunch();
			recordOne();
			stub(stream, "isTTY", false);
			expect(isBareInteractiveLaunch()).toBe(false);
			replayFirstFrame();
			expect(launch.written()).toEqual([]);
			while (undo.length > 0) undo.pop()?.();
		}
	});
});
