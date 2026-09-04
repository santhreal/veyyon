/**
 * The launch card of the previous bare launch, replayed onto the terminal before anything loads.
 *
 * WHY THIS EXISTS. The card cannot be composed in 25ms, and the reason is not slow code. Measured
 * on the compiled binary, the import graph that has to exist before a single row can be composed
 * costs about 33ms on its own: the directory resolver, the environment layers, the terminal
 * capability probe, the settings file, the theme and the renderer, each of them already the
 * cheapest form of itself. Paint and flush add about 13ms after that. Trimming a module here and
 * there moves that number by one or two milliseconds and cannot move it by twenty.
 *
 * What CAN move it is not composing the card at all. The frame a bare launch paints is a pure
 * function of the terminal size, the settings, the theme and the facts the last launch recorded,
 * and none of those changed between quitting and starting again. So the previous launch records
 * the exact bytes it wrote and the exact rows those bytes produced, and the next one writes the
 * bytes back before the graph loads. Measured the same way, that path costs 6.3ms.
 *
 * THE BYTES AND THE ROWS ARE ONE RECORDING. The renderer that comes up behind the replay is told
 * the screen already holds those rows ({@link TUI.adoptPaintedWindow}), so its first frame writes
 * only what differs, which for an unchanged launch is nothing. That is only sound while the rows
 * describe the bytes exactly, so both are written in one place, at one moment, from one frame.
 *
 * WHAT A RECORDING HAS TO BE VALID FOR, AND WHAT IT DOES NOT. Being out of date is not one of the
 * things that can go wrong here. The renderer diffs its real frame against the recorded rows, so a
 * recording made before a settings change describes the screen accurately and is corrected row by
 * row when the real card composes, which is the same contract the recorded launch facts already
 * ship: state the last answer, correct it in place. What must be excluded is a recording whose
 * ROWS DO NOT DESCRIBE ITS BYTES on this terminal, because then the diff writes the wrong rows and
 * nothing later notices. That is decided by three things, all cheap:
 *
 *   - the terminal's size, since the bytes are absolute cursor moves within it;
 *   - the environment variables that decide colour depth and glyph support, since they change what
 *     the same rows compose to;
 *   - the binary itself, by mtime and size, since a new build may compose or emit differently.
 *
 * A mismatch is not an error. Nothing is written, the ordinary path runs unchanged, and this run
 * records a fresh copy.
 *
 * WHY ONLY A BARE LAUNCH. `veyyon` with no arguments at all is the only command line this module
 * acts on, tested before argv is parsed because parsing is part of the graph being skipped. Any
 * argument, including one that would still paint a card, takes the ordinary path: the alternative
 * is a second copy of the "does this command paint" decision, running earlier and with less
 * information than the one in `./launch-card`, and a card painted over `veyyon --version` is a
 * worse failure than a launch that took 46ms.
 *
 * This module imports node builtins only, and must keep to that. It is evaluated before the
 * directory resolver, so anything it pulls in is paid by every command that starts, including the
 * ones that print a line and exit.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AdoptedScreen } from "@veyyon/tui/tui";

/**
 * The recording's shape. A copy written by an older shape is discarded rather than read, because
 * every field here is load-bearing for bytes that go straight to the terminal.
 *
 * Exported for `./first-frame-recorder`, which writes the copy this module reads. That module is
 * the only other reader of the four internals this one exports.
 */
export const REPLAY_SHAPE_VERSION = 2;

/**
 * How long a recording may be replayed before the card is composed again.
 *
 * Nothing about a recording goes stale on a clock; this is the rotation the welcome tip needs. A
 * replayed card shows the recorded tip, so without an expiry a terminal that never changes size
 * would show one tip until the next release. A day means the tip changes daily and every launch
 * after the first is fast.
 */
const RECORDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Environment variables the recorded frame is a function of.
 *
 * The directory group decides which profile, settings and cache the card is built from; the
 * terminal group decides colour depth, glyph support and the capability probe's answers. Recorded
 * by value and compared exactly, so an unset variable and an empty one are different states.
 *
 * A variable absent from this list can still change the frame through a FILE, and the file's mtime
 * catches it. What this list has to cover is the input that reaches the frame without touching
 * disk at all.
 */
export const RECORDED_ENV_KEYS: readonly string[] = [
	"COLORFGBG",
	"COLORTERM",
	"FORCE_COLOR",
	"NO_COLOR",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"VEYYON_CODING_AGENT_DIR",
	"VEYYON_CONFIG_DIR",
	"VEYYON_PROFILE",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
];

/** The binary that wrote the recording, by the two stat fields that change when a build does. */
interface RecordedBinary {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

/** A recorded frame: the bytes that painted it, the rows they produced, and what it is valid for. */
export interface FirstFrameRecording {
	readonly version: number;
	readonly cols: number;
	readonly rows: number;
	readonly env: Readonly<Record<string, string>>;
	readonly binary: RecordedBinary;
	readonly bytes: string;
	/** The screen those bytes produced, as the engine composed it. */
	readonly screen: AdoptedScreen;
	/**
	 * The tip the recorded card is showing.
	 *
	 * A replayed launch shows this one rather than drawing a fresh one, because the alternative is
	 * the card rewriting its own three tip rows a moment after the operator started reading them.
	 * {@link RECORDING_MAX_AGE_MS} is what keeps the rotation: the recording expires, the card
	 * composes, and it draws a new tip.
	 */
	readonly tip: string;
	/** When it was written, against which {@link RECORDING_MAX_AGE_MS} is measured. */
	readonly recordedAtMs: number;
}

/**
 * The recording's fixed home, resolved without the directory resolver.
 *
 * Not `getFirstFrameCachePath()`, which is the same file's real name: reaching that function means
 * loading `@veyyon/utils/dirs`, and the 8.7ms that costs is a third of the budget this module
 * exists to defend. The recorded environment covers the difference — a run whose `XDG_*` or
 * `VEYYON_CODING_AGENT_DIR` differs from the recording's does not replay it — so the fixed path
 * holds one recording for whichever configuration wrote it last, and every other configuration
 * takes the ordinary path.
 *
 * `VEYYON_FIRST_FRAME_CACHE` names the file outright, for the same reason `VEYYON_GITHUB_CACHE_DB`
 * does: `os.homedir()` is fixed at process start under Bun, so a suite cannot move this file by
 * assigning `HOME` and would otherwise have to write into the operator's own cache to test it.
 */
export function recordingPath(): string {
	const override = process.env.VEYYON_FIRST_FRAME_CACHE;
	if (override) return override;
	return path.join(os.homedir(), ".veyyon", "cache", "first-frame.json");
}

/**
 * True for `veyyon` with no arguments on a terminal, and nothing else.
 *
 * Deliberately narrower than {@link shouldPrepaintLaunchCard}, which decides the same question with
 * parsed arguments a few milliseconds later. This one runs before the parser exists, so it answers
 * only the case that needs no parsing.
 */
export function isBareInteractiveLaunch(): boolean {
	return process.argv.length === 2 && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * The terminal size the card will be composed at, resolved exactly as the renderer resolves it.
 *
 * `process.stdout.columns` is not that size. A pty whose dimensions are set after the process
 * starts reports 0 here and a real size a few milliseconds later, and under `script(1)` with no
 * controlling terminal it reports 0 for the whole of this function's life. The renderer never sees
 * that 0: `ProcessTerminal.columns` falls back through `COLUMNS` to 80, so the card composes at
 * 80x24 and the recording stores 80x24.
 *
 * Comparing the raw value against a recording written from the resolved one rejects every launch
 * on such a terminal, which is a replay that silently never fires. The two must read the size the
 * same way, so this mirrors `ProcessTerminal.columns` and `.rows` in `@veyyon/tui/terminal`, which
 * own it. Mirrored rather than imported because this module is evaluated before the import graph
 * and may import node builtins only;
 * `packages/coding-agent/test/a-replayed-card-describes-the-screen-it-replays.test.ts` fails if the
 * two ever disagree.
 */
function terminalSize(): { cols: number; rows: number } {
	return {
		cols: process.stdout.columns || Number(process.env.COLUMNS) || 80,
		rows: process.stdout.rows || Number(process.env.LINES) || 24,
	};
}

/** The value of every recorded variable, as the recording stores them. */
function readEnv(): Record<string, string> {
	const snapshot: Record<string, string> = {};
	for (const key of RECORDED_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) snapshot[key] = value;
	}
	return snapshot;
}

/**
 * The recorded variables as this process received them, read once, here.
 *
 * Not read again at either end. This module is `cli.ts`'s first import, so module evaluation is the
 * only moment at which the replay's comparison and the recording written 40ms later are looking at
 * the same environment: startup consumes some of these on the way past. `VEYYON_PROFILE` is deleted
 * from `process.env` once the profile is resolved, so a recording that read the environment at the
 * point the card was composed stored it as absent, the next launch compared that against an entry
 * environment that still had it, and no launch under a profile ever replayed. Both ends read this.
 */
export const ENTRY_ENV: Readonly<Record<string, string>> = readEnv();

/** Whether the running binary is exactly the one that wrote the recording. */
function binaryUnchanged(binary: RecordedBinary): boolean {
	if (binary.path !== process.execPath) return false;
	try {
		const stat = fs.statSync(process.execPath);
		return stat.mtimeMs === binary.mtimeMs && stat.size === binary.size;
	} catch {
		return false;
	}
}

/** Whether a recording's environment is the one this process received. */
function envUnchanged(recorded: Readonly<Record<string, string>>): boolean {
	const recordedKeys = Object.keys(recorded);
	if (recordedKeys.length !== Object.keys(ENTRY_ENV).length) return false;
	for (const key of recordedKeys) {
		if (recorded[key] !== ENTRY_ENV[key]) return false;
	}
	return true;
}

/** A recording is a recording only if every field is the type the replay is about to trust. */
function asRecording(value: unknown): FirstFrameRecording | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<FirstFrameRecording>;
	if (candidate.version !== REPLAY_SHAPE_VERSION) return undefined;
	if (typeof candidate.cols !== "number" || typeof candidate.rows !== "number") return undefined;
	if (typeof candidate.bytes !== "string" || candidate.bytes.length === 0) return undefined;
	const screen = candidate.screen;
	if (typeof screen !== "object" || screen === null) return undefined;
	if (!Array.isArray(screen.window) || screen.window.some(row => typeof row !== "string")) return undefined;
	for (const position of [screen.frameLength, screen.width, screen.height, screen.cursorRow, screen.windowTopRow]) {
		if (typeof position !== "number" || !Number.isInteger(position)) return undefined;
	}
	if (typeof candidate.tip !== "string") return undefined;
	if (typeof candidate.recordedAtMs !== "number") return undefined;
	const binary = candidate.binary;
	if (typeof binary?.path !== "string" || typeof binary.mtimeMs !== "number" || typeof binary.size !== "number") {
		return undefined;
	}
	if (typeof candidate.env !== "object" || candidate.env === null) return undefined;
	for (const entry of Object.values(candidate.env)) {
		if (typeof entry !== "string") return undefined;
	}
	return candidate as FirstFrameRecording;
}

/** What a replayed launch hands to the card it is about to compose. */
export interface ReplayedFirstFrame {
	readonly screen: AdoptedScreen;
	readonly tip: string;
}

let replayed: ReplayedFirstFrame | undefined;

/**
 * Why a launch did not replay, appended to the file `VEYYON_REPLAY_DEBUG` names.
 *
 * A rejected recording is indistinguishable from a slow launch on the outside: nothing is written,
 * the ordinary path runs, and the recording is rewritten at the end. That is the right product
 * behavior and it makes "the replay never fires under this launcher" undiagnosable from a timing
 * table. The logger cannot serve here, because this runs before it exists.
 */
function why(reason: string): void {
	const file = process.env.VEYYON_REPLAY_DEBUG;
	if (file === undefined) return;
	try {
		fs.appendFileSync(file, `${process.pid} ${reason}\n`);
	} catch {
		// A diagnostic that cannot be written is not a launch that fails.
	}
}

/**
 * Write the previous launch's card, if this launch is the same launch.
 *
 * Called before the CLI's own import graph is evaluated, so it must not throw for any reason: a
 * damaged, truncated or foreign recording is a launch that paints 40ms later, never a launch that
 * fails.
 */
export function replayFirstFrame(): void {
	if (!isBareInteractiveLaunch()) {
		why(`not-bare argv=${process.argv.length} stdin=${process.stdin.isTTY} stdout=${process.stdout.isTTY}`);
		return;
	}
	try {
		const recording = asRecording(JSON.parse(fs.readFileSync(recordingPath(), "utf8")) as unknown);
		if (recording === undefined) return why("no usable recording");
		if (Date.now() - recording.recordedAtMs > RECORDING_MAX_AGE_MS) return why("aged out");
		const size = terminalSize();
		if (recording.cols !== size.cols || recording.rows !== size.rows) {
			return why(`size ${recording.cols}x${recording.rows} != ${size.cols}x${size.rows}`);
		}
		if (!envUnchanged(recording.env)) {
			return why(`env ${JSON.stringify(recording.env)} != ${JSON.stringify(ENTRY_ENV)}`);
		}
		if (!binaryUnchanged(recording.binary)) {
			return why(`binary ${JSON.stringify(recording.binary)} != ${process.execPath}`);
		}
		fs.writeSync(1, recording.bytes);
		replayed = { screen: recording.screen, tip: recording.tip };
		why("replayed");
	} catch (error) {
		// Every failure here is the same failure: no replay, ordinary path, fresh recording at the
		// end of this run.
		why(`threw ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * The screen the replay left, once.
 *
 * Single-use for the same reason the prologue handoff is: a second frame built in this process must
 * compose against the screen as it then is, not against a card that has since been replaced.
 */
export function takeReplayedFirstFrame(): ReplayedFirstFrame | undefined {
	const taken = replayed;
	replayed = undefined;
	return taken;
}
