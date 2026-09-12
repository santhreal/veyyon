/**
 * The other half of the first-frame replay: writing the recording the next launch reads.
 *
 * Separate from `./first-frame-replay` because the two halves run at opposite ends of a launch and
 * pay for their imports differently. The reader is `cli.ts`'s first import and is evaluated before
 * the graph exists, so it reaches node builtins only and is held to the boot-path ceiling
 * (`test/architecture/the-boot-path-stays-thin.test.ts`). The writer runs after the card is on the
 * screen, where an ordinary import costs the launch nothing, so it uses the tree's one atomic
 * writer instead of hand-rolling a staging rename.
 */

import * as fsp from "node:fs/promises";
import type { AdoptedScreen } from "@veyyon/tui/tui";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import { ENTRY_ENV, type FirstFrameRecording, REPLAY_SHAPE_VERSION, recordingPath } from "./first-frame-replay";

/**
 * Record this launch's card for the next one.
 *
 * Failure is silent for the same reason the replay's is, one step later: a cache that cannot be
 * written costs the next launch its speedup and nothing else.
 */
export async function recordFirstFrame(options: {
	readonly bytes: string;
	readonly cols: number;
	readonly rows: number;
	readonly screen: AdoptedScreen;
	readonly tip: string;
}): Promise<void> {
	try {
		const destination = recordingPath();
		const binaryPath = process.execPath;
		const recordedAtMs = Date.now();
		const screenSnapshot: AdoptedScreen = {
			window: options.screen.window.slice(),
			frameLength: options.screen.frameLength,
			width: options.screen.width,
			height: options.screen.height,
			cursorRow: options.screen.cursorRow,
			windowTopRow: options.screen.windowTopRow,
		};
		const cols = options.cols;
		const rows = options.rows;
		const bytes = options.bytes;
		const tip = options.tip;
		const stat = await fsp.stat(binaryPath);
		const recording: FirstFrameRecording = {
			version: REPLAY_SHAPE_VERSION,
			cols,
			rows,
			env: ENTRY_ENV,
			binary: { path: binaryPath, mtimeMs: stat.mtimeMs, size: stat.size },
			bytes,
			screen: screenSnapshot,
			tip,
			recordedAtMs,
		};
		// Staged and renamed by the one writer: the reader is the next process's first file read and
		// must never see half a recording. `fsync: false` because a recording lost to a power cut is
		// a launch that composes its card, which is the ordinary path.
		await atomicWriteFile(destination, JSON.stringify(recording), { fsync: false });
	} catch {
		// A cache that cannot be written costs the next launch its speedup and nothing else.
	}
}

/** Discard the recording, so the next launch composes its card. */
export async function clearFirstFrameRecording(): Promise<void> {
	try {
		await fsp.rm(recordingPath(), { force: true });
	} catch {
		// Already gone, or a root nothing may write: either way the next launch composes.
	}
}
