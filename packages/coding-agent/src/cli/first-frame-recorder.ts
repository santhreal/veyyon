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

import * as fs from "node:fs";
import type { AdoptedScreen } from "@veyyon/tui/tui";
import { atomicWriteFileSync } from "@veyyon/utils/atomic-write";
import { ENTRY_ENV, type FirstFrameRecording, REPLAY_SHAPE_VERSION, recordingPath } from "./first-frame-replay";

/**
 * Record this launch's card for the next one.
 *
 * Failure is silent for the same reason the replay's is, one step later: a cache that cannot be
 * written costs the next launch its speedup and nothing else.
 */
export function recordFirstFrame(options: {
	readonly bytes: string;
	readonly cols: number;
	readonly rows: number;
	readonly screen: AdoptedScreen;
	readonly tip: string;
}): void {
	try {
		const stat = fs.statSync(process.execPath);
		const recording: FirstFrameRecording = {
			version: REPLAY_SHAPE_VERSION,
			cols: options.cols,
			rows: options.rows,
			env: ENTRY_ENV,
			binary: { path: process.execPath, mtimeMs: stat.mtimeMs, size: stat.size },
			bytes: options.bytes,
			screen: options.screen,
			tip: options.tip,
			recordedAtMs: Date.now(),
		};
		// Staged and renamed by the one writer: the reader is the next process's first file read and
		// must never see half a recording. `fsync: false` because a recording lost to a power cut is
		// a launch that composes its card, which is the ordinary path.
		atomicWriteFileSync(recordingPath(), JSON.stringify(recording), { fsync: false });
	} catch {
		// A cache that cannot be written costs the next launch its speedup and nothing else.
	}
}

/** Discard the recording, so the next launch composes its card. */
export function clearFirstFrameRecording(): void {
	try {
		fs.rmSync(recordingPath(), { force: true });
	} catch {
		// Already gone, or a root nothing may write: either way the next launch composes.
	}
}
