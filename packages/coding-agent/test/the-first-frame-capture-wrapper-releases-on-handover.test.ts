/**
 * WHY THIS SUITE EXISTS:
 *
 * During startup, `paintFirstFrame` borrows `ui.terminal.write` by installing a capture wrapper to
 * record the pristine bytes rendered for first-frame replay.
 *
 * Previously, `stopCapture` was called ONLY by `settleReplayRecording`. In a typed launch (input
 * arriving before or during first frame), `launch-card.ts` intentionally skips
 * `settleReplayRecording` because typed input cannot be replayed as a pristine card. Furthermore,
 * `FirstFrame.release()` never stopped capture, cleared `captured`, or settled recording state.
 *
 * Consequently:
 * 1. For every typed launch, `terminal.write` remained monkey-patched for the entire session,
 *    accumulating every subsequent terminal write (streaming tokens, chat turns, tool execution
 *    diffs) into an unbounded memory string.
 * 2. If `settleReplayRecording` was called after a typed handover or direct release, it would write
 *    an empty recording to disk.
 * 3. `release()` did not restore borrowed writer ownership when unmounting.
 *
 * THE CLASS:
 * Borrowed terminal writer ownership must be strictly bounded by the first-frame lifecycle. On any
 * lifecycle transition — typed input detection in `settleQueuedInput`, normal recording settlement
 * in `settleReplayRecording`, or frame teardown in `release` — the capture wrapper MUST terminate,
 * the captured memory buffer MUST be released, and `terminal.write` MUST be restored to its original
 * unwrapped function without clobbering third-party wrappers. Output must reach the destination
 * terminal exactly once on every path, persisted recordings must be byte-exact, and cleanup
 * operations must be completely idempotent.
 *
 * WHAT IT DOES NOT CATCH:
 * How the operating system or terminal emulator processes the written ANSI escape sequences.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { setTerminalHeadless } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";
import { parseArgs } from "../src/cli/args";
import { clearFirstFrameRecording, recordFirstFrame } from "../src/cli/first-frame-recorder";
import { type FirstFrameRecording, recordingPath } from "../src/cli/first-frame-replay";
import { runStartupPrologue } from "../src/cli/launch-card";
import { type StartupPrologue, takeStartupPrologue } from "../src/cli/prologue-handoff";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { resetLaunchFactsForTest } from "../src/modes/launch-facts";
import { CURRENT_SETUP_VERSION } from "../src/modes/setup-version";
import { type FirstFrame, paintFirstFrame, takeFirstFrame } from "../src/modes/terminal/first-frame";
import * as ttyInputFlush from "../src/modes/terminal/tty-input-flush";
import { resetGroundTintsForTest } from "../src/theme/ground-tints";
import { initTheme } from "../src/theme/theme";

let isolated: IsolatedConfigRoot;
let previousFirstFrameCache: string | undefined;
const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
let previousHeadless = false;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function send(data: string): void {
	process.stdin.emit("data", data);
}

function readPersistedRecording(): FirstFrameRecording | undefined {
	const file = recordingPath();
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(fs.readFileSync(file, "utf8")) as FirstFrameRecording;
}

const frames: FirstFrame[] = [];
let stdoutWrites: string[] = [];

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	stdoutWrites = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
	previousHeadless = setTerminalHeadless(false);

	resetSettingsForTest();
	isolated = enterIsolatedConfigRoot("first-frame-capture-lifecycle", { defaultProfile: true });
	await Settings.init({ inMemory: true, cwd: isolated.root });

	previousFirstFrameCache = process.env.VEYYON_FIRST_FRAME_CACHE;
	process.env.VEYYON_FIRST_FRAME_CACHE = path.join(isolated.root, "first-frame.json");

	spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		stdoutWrites.push(String(chunk));
		return true;
	});
	spyOn(ttyInputFlush, "flushPendingTtyInput").mockReturnValue(true);
	resetLaunchFactsForTest();
});

afterEach(() => {
	for (const frame of frames) {
		frame.release();
		frame.ui.stop();
	}
	frames.length = 0;
	takeFirstFrame()?.release();
	resetGroundTintsForTest();
	resetLaunchFactsForTest();
	resetSettingsForTest();
	setTerminalHeadless(previousHeadless);
	restoreProperty(process.stdin, "isTTY", stdinIsTty);
	restoreProperty(process.stdout, "isTTY", stdoutIsTty);
	restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	if (previousFirstFrameCache === undefined) {
		delete process.env.VEYYON_FIRST_FRAME_CACHE;
	} else {
		process.env.VEYYON_FIRST_FRAME_CACHE = previousFirstFrameCache;
	}
	mock.restore();
	isolated?.restore();
});

describe("the first-frame capture wrapper lifecycle", () => {
	it("terminates capture and restores borrowed terminal writer when typing is detected", async () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const terminal = frame.ui.terminal;
		const originalWrite = Object.getPrototypeOf(terminal).write;
		// While capture is active, terminal.write is wrapped
		expect(terminal.write).not.toBe(originalWrite);

		// Operator types into the composer before/during startup
		send("fix the bug");

		// settleQueuedInput detects typing and must stop capture immediately
		const typed = await frame.settleQueuedInput();
		expect(typed).toBe(true);

		// Borrowed writer ownership is returned to the original terminal writer
		expect(terminal.write).toBe(originalWrite);

		// In a typed launch, launch-card.ts skips settleReplayRecording.
		// Subsequent post-handover terminal writes must go directly to the terminal
		// without accumulating in any first-frame buffer.
		const writeCountBefore = stdoutWrites.length;
		terminal.write("post-handover interactive output");
		expect(stdoutWrites.length).toBe(writeCountBefore + 1);
		expect(stdoutWrites.at(-1)).toBe("post-handover interactive output");

		// If settleReplayRecording is mistakenly called after a typed startup,
		// it must not write an empty or corrupt recording to disk.
		await frame.settleReplayRecording();
		expect(readPersistedRecording()).toBeUndefined();

		// Frame release is clean and preserves the unwrapped terminal writer
		frame.release();
		expect(terminal.write).toBe(originalWrite);

		// Calling settleReplayRecording after release also persists nothing
		await frame.settleReplayRecording();
		expect(readPersistedRecording()).toBeUndefined();
	});

	it("records byte-exact pristine card and restores terminal writer on normal settlement", async () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const terminal = frame.ui.terminal;
		const originalWrite = Object.getPrototypeOf(terminal).write;

		// `ui.start` terminal setup (queries/probes) ran synchronously during `paintFirstFrame`.
		// Clear stdoutWrites now so we capture only the frame paint writes that follow.
		stdoutWrites = [];

		// No typing occurred
		const typed = await frame.settleQueuedInput();
		expect(typed).toBe(false);

		// Snapshot the pristine writes produced during first-frame composition
		const pristineWrites = stdoutWrites.join("");
		expect(pristineWrites.length).toBeGreaterThan(0);

		// Settle replay recording using the real recorder
		await frame.settleReplayRecording();
		// Real recording file is persisted on disk
		const recording = readPersistedRecording();
		expect(recording).toBeDefined();
		expect(recording?.cols).toBe(terminal.columns);
		expect(recording?.rows).toBe(terminal.rows);
		// The recorded bytes match the exact pristine bytes emitted during card paint
		expect(recording?.bytes).toBe(pristineWrites);

		// Writer ownership is returned
		expect(terminal.write).toBe(originalWrite);

		// Post-handover terminal writes do not alter or corrupt the persisted recording file
		terminal.write("post-handover stream delta");
		const recordingAfter = readPersistedRecording();
		expect(recordingAfter?.bytes).toBe(pristineWrites);

		frame.release();
		expect(terminal.write).toBe(originalWrite);
	});

	it("terminates capture and releases buffer on direct frame release", async () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const terminal = frame.ui.terminal;
		const originalWrite = Object.getPrototypeOf(terminal).write;

		// Frame is released directly (e.g. quiet mode, error, or discarded singleton)
		frame.release();
		expect(terminal.write).toBe(originalWrite);

		// Calling settleReplayRecording after release is a safe no-op that persists nothing
		await frame.settleReplayRecording();
		expect(readPersistedRecording()).toBeUndefined();
		expect(terminal.write).toBe(originalWrite);
	});

	it("handles repeated release and settlement calls idempotently", async () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const terminal = frame.ui.terminal;
		const originalWrite = Object.getPrototypeOf(terminal).write;

		// First settle writes the recording
		await frame.settleReplayRecording();
		const initialRecording = readPersistedRecording();
		expect(initialRecording).toBeDefined();
		expect(terminal.write).toBe(originalWrite);

		// Second settle is an idempotent no-op and does not overwrite or corrupt
		await frame.settleReplayRecording();
		const secondRecording = readPersistedRecording();
		expect(secondRecording?.bytes).toBe(initialRecording?.bytes);
		expect(terminal.write).toBe(originalWrite);

		// First release
		frame.release();
		expect(terminal.write).toBe(originalWrite);

		// Second release is a no-op
		frame.release();
		expect(terminal.write).toBe(originalWrite);
	});
	it("preserves external wrappers when borrowed writer ownership is replaced during capture", () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const terminal = frame.ui.terminal;
		const originalWrite = Object.getPrototypeOf(terminal).write;
		const firstFrameWrapper = terminal.write;

		// An external layer wraps terminal.write on top of first-frame's wrapper
		const externalWrites: string[] = [];
		const externalWrapper = (data: string): void => {
			externalWrites.push(data);
			firstFrameWrapper.call(terminal, data);
		};
		terminal.write = externalWrapper;

		// Direct release runs while external wrapper sits on top
		frame.release();

		// stopCapture did not stomp the external wrapper
		expect(terminal.write).toBe(externalWrapper);

		// Calling the external wrapper delivers write through to originalWrite without first-frame capture
		const countBefore = stdoutWrites.length;
		terminal.write("nested write");
		expect(externalWrites).toContain("nested write");
		expect(stdoutWrites.length).toBe(countBefore + 1);
		expect(stdoutWrites.at(-1)).toBe("nested write");

		// When external wrapper is unwrapped, terminal.write returns to originalWrite
		terminal.write = originalWrite;
		expect(terminal.write).toBe(originalWrite);
	});

	it("delivers terminal writes exactly once during capture and after handover", async () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const terminal = frame.ui.terminal;

		// Explicit write during capture
		const countDuring = stdoutWrites.length;
		terminal.write("during capture write");
		expect(stdoutWrites.length).toBe(countDuring + 1);
		expect(stdoutWrites.at(-1)).toBe("during capture write");

		// Release frame
		frame.release();

		// Explicit write after handover
		const countAfter = stdoutWrites.length;
		terminal.write("after handover write");
		expect(stdoutWrites.length).toBe(countAfter + 1);
		expect(stdoutWrites.at(-1)).toBe("after handover write");
	});

	it("shares the same pending promise across concurrent settlement calls and awaits publication", async () => {
		const frame = paintFirstFrame("1.1.1");
		frames.push(frame);

		const typed = await frame.settleQueuedInput();
		expect(typed).toBe(false);

		const settle1 = frame.settleReplayRecording();
		const settle2 = frame.settleReplayRecording();
		const settle3 = frame.settleReplayRecording();

		// All concurrent calls share the exact same pending promise
		expect(settle1).toBe(settle2);
		expect(settle2).toBe(settle3);

		await Promise.all([settle1, settle2, settle3]);

		const recording = readPersistedRecording();
		expect(recording).toBeDefined();
		expect(recording?.cols).toBe(frame.ui.terminal.columns);
		expect(recording?.rows).toBe(frame.ui.terminal.rows);
	});

	for (const boundary of ["stat", "rename"] as const) {
		it(`stops capture synchronously before async publication yields and isolates snapshot during blocked ${boundary}`, async () => {
			const frame = paintFirstFrame("1.1.1");
			frames.push(frame);

			const terminal = frame.ui.terminal;
			const originalWrite = Object.getPrototypeOf(terminal).write;

			stdoutWrites = [];
			const typed = await frame.settleQueuedInput();
			expect(typed).toBe(false);

			const pristineWrites = stdoutWrites.join("");
			expect(pristineWrites.length).toBeGreaterThan(0);

			const writeGate = Promise.withResolvers<void>();
			const writeStarted = Promise.withResolvers<void>();
			const realStat = fsp.stat;
			const realRename = fsp.rename;
			let statSpy: { mockRestore: () => void } | undefined;
			let renameSpy: { mockRestore: () => void } | undefined;

			if (boundary === "stat") {
				statSpy = spyOn(fsp, "stat").mockImplementation((async (...args: Parameters<typeof fsp.stat>) => {
					if (args[0] === process.execPath) {
						writeStarted.resolve();
						await writeGate.promise;
					}
					return realStat(...args);
				}) as typeof fsp.stat);
			} else {
				renameSpy = spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
					writeStarted.resolve();
					await writeGate.promise;
					return realRename(oldPath, newPath);
				});
			}

			let timeout: NodeJS.Timeout | undefined;
			let settlementPromise: Promise<void> | undefined;
			try {
				settlementPromise = frame.settleReplayRecording();

				// Capture stops synchronously before any I/O yields
				expect(terminal.write).toBe(originalWrite);

				// 1s rejection timer ensures failure before boundary cannot hang test
				timeout = setTimeout(() => {
					writeStarted.reject(new Error(`timed out waiting for ${boundary} to be called`));
				}, 1000);
				await writeStarted.promise;
				clearTimeout(timeout);
				timeout = undefined;

				// While publication is in-flight, send real stdin input and verify interactive progress
				send(`typed during ${boundary}`);
				const inputFlushed = Promise.withResolvers<void>();
				setImmediate(inputFlushed.resolve);
				await inputFlushed.promise;
				expect(frame.editor.getText()).toBe(`typed during ${boundary}`);
				expect(stdoutWrites.join("")).toContain(`typed during ${boundary}`);

				// Frame release occurs while publication is in-flight
				frame.release();

				// Concurrent settlement call while in-flight returns the same pending settlement
				let concurrentSettled = false;
				const concurrentSettle = frame.settleReplayRecording();
				expect(concurrentSettle).toBe(settlementPromise);
				concurrentSettle.then(() => {
					concurrentSettled = true;
				});

				const checkMicrotask = Promise.withResolvers<void>();
				setImmediate(checkMicrotask.resolve);
				await checkMicrotask.promise;
				expect(concurrentSettled).toBe(false);

				// Unblock the async file publication
				writeGate.resolve();
				await settlementPromise;
				expect(concurrentSettled).toBe(true);

				// Persisted recording matches pristine snapshot and is untouched by writes during publication
				const recording = readPersistedRecording();
				expect(recording).toBeDefined();
				expect(recording?.bytes).toBe(pristineWrites);
				expect(recording?.bytes).not.toContain(`typed during ${boundary}`);
			} finally {
				clearTimeout(timeout);
				writeGate.resolve();
				if (settlementPromise) {
					try {
						await settlementPromise;
					} catch {
						// Ignore in cleanup
					}
				}
				statSpy?.mockRestore();
				renameSpy?.mockRestore();
			}
		});
	}

	it("snapshots screen window rows and options synchronously before any await in recordFirstFrame", async () => {
		const mutableOptions = {
			bytes: "pristine-bytes",
			cols: 80,
			rows: 24,
			screen: {
				window: ["row1", "row2", "row3"],
				frameLength: 3,
				width: 80,
				height: 24,
				cursorRow: 2,
				windowTopRow: 0,
			},
			tip: "original tip",
		};
		const pendingRecord = recordFirstFrame(mutableOptions);
		// Immediately mutate caller's options and screen fields before awaiting
		mutableOptions.bytes = "corrupted-bytes";
		mutableOptions.cols = 999;
		mutableOptions.rows = 999;
		mutableOptions.tip = "corrupted tip";
		mutableOptions.screen.window.push("corrupted row");
		mutableOptions.screen.window[0] = "mutated row";
		mutableOptions.screen.frameLength = 99;
		mutableOptions.screen.width = 999;
		mutableOptions.screen.height = 999;
		mutableOptions.screen.cursorRow = 99;
		mutableOptions.screen.windowTopRow = 99;

		await pendingRecord;

		const recording = readPersistedRecording();
		expect(recording).toBeDefined();
		expect(recording?.bytes).toBe("pristine-bytes");
		expect(recording?.cols).toBe(80);
		expect(recording?.rows).toBe(24);
		expect(recording?.tip).toBe("original tip");
		expect(recording?.screen).toEqual({
			window: ["row1", "row2", "row3"],
			frameLength: 3,
			width: 80,
			height: 24,
			cursorRow: 2,
			windowTopRow: 0,
		});
	});

	it("clears a real valid recording asynchronously and handles repeated deletion idempotently", async () => {
		const screen = {
			window: ["row1", "row2"],
			frameLength: 2,
			width: 80,
			height: 24,
			cursorRow: 1,
			windowTopRow: 0,
		};
		await recordFirstFrame({
			bytes: "card-bytes",
			cols: 80,
			rows: 24,
			screen,
			tip: "tip",
		});
		expect(readPersistedRecording()).toBeDefined();

		const started = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const realRm = fsp.rm;
		const rmSpy = spyOn(fsp, "rm").mockImplementation(async (...args) => {
			started.resolve();
			await resume.promise;
			await realRm(...args);
		});
		const deadline = setTimeout(() => started.reject(new Error("asynchronous deletion did not start")), 1000);
		let deletion: Promise<void> | undefined;
		try {
			deletion = clearFirstFrameRecording();
			await started.promise;
			expect(readPersistedRecording()).toBeDefined();
			let settled = false;
			deletion.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			resume.resolve();
			await deletion;
			expect(settled).toBe(true);
			expect(readPersistedRecording()).toBeUndefined();
			await clearFirstFrameRecording();
			expect(readPersistedRecording()).toBeUndefined();
		} finally {
			clearTimeout(deadline);
			resume.resolve();
			try {
				await deletion;
			} finally {
				rmSpy.mockRestore();
			}
		}
	});
	it("completes runStartupPrologue handoff without blocking on asynchronous recorder filesystem completion", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: isolated.root,
			overrides: {
				onboardingVersion: CURRENT_SETUP_VERSION,
				"startup.quiet": false,
				"startup.showSplash": false,
			},
		});

		const writeGate = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const handoffDeadline = Promise.withResolvers<never>();
		const realRename = fsp.rename;
		const destination = recordingPath();
		const renameSpy = spyOn(fsp, "rename").mockImplementation(async (oldPath, newPath) => {
			if (String(newPath) === destination) {
				writeStarted.resolve();
				await writeGate.promise;
			}
			return realRename(oldPath, newPath);
		});
		let handoff: Promise<StartupPrologue> | undefined;
		let handoffTimeout: NodeJS.Timeout | undefined;
		let writeTimeout: NodeJS.Timeout | undefined;
		let frame: FirstFrame | undefined;
		try {
			handoff = runStartupPrologue(parseArgs([]));
			handoffTimeout = setTimeout(
				() => handoffDeadline.reject(new Error("prologue handoff waited for recorder publication")),
				2000,
			);
			const prologue = await Promise.race([handoff, handoffDeadline.promise]);
			clearTimeout(handoffTimeout);
			expect(takeStartupPrologue()).toBe(prologue);
			expect(takeStartupPrologue()).toBeUndefined();

			frame = takeFirstFrame();
			if (!frame) throw new Error("completed onboarding did not produce an interactive first frame");
			frames.push(frame);
			const terminal = frame.ui.terminal;
			expect(terminal.write).toBe(Object.getPrototypeOf(terminal).write);

			writeTimeout = setTimeout(
				() => writeStarted.reject(new Error("recorder publication did not reach the filesystem barrier")),
				2000,
			);
			await writeStarted.promise;
			clearTimeout(writeTimeout);
			expect(readPersistedRecording()).toBeUndefined();

			send("post-handoff draft");
			const inputFlushed = Promise.withResolvers<void>();
			setImmediate(inputFlushed.resolve);
			await inputFlushed.promise;
			terminal.write("post-handoff output");
			expect(frame.editor.getText()).toBe("post-handoff draft");
			frame.release();
			writeGate.resolve();
			await frame.settleReplayRecording();

			const recording = readPersistedRecording();
			if (!recording) throw new Error("recorder did not publish after the filesystem barrier opened");
			expect(recording.bytes).not.toContain("post-handoff draft");
			expect(recording.bytes).not.toContain("post-handoff output");
			expect(recording.screen.window.some(row => row.includes("post-handoff draft"))).toBe(false);
		} finally {
			clearTimeout(handoffTimeout);
			clearTimeout(writeTimeout);
			writeGate.resolve();
			try {
				await handoff;
				takeStartupPrologue();
				if (!frame) {
					frame = takeFirstFrame();
					if (frame) frames.push(frame);
				}
				await frame?.settleReplayRecording();
			} finally {
				renameSpy.mockRestore();
			}
		}
	});
});
