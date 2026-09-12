/**
 * WHY: `startRecording` and `startStreamingRecording` walk the detected
 * recorders in priority order. A recorder that exits at startup is not the end
 * of dictation: the next one is tried, and only when every recorder has failed
 * does the caller get an error, one that lists each recorder's own failure so
 * the operator can tell a missing microphone from a missing binary.
 *
 * THE CLASS THIS CLOSES: a fallback walk that stops at the first failure, or
 * that reports the last failure alone. Both entry points share one walk, so a
 * regression in either shape fails here for both.
 *
 * WHAT IT DOES NOT CATCH: the audio each backend produces. The stubs are `/bin/sh`
 * scripts that either exit at once or sleep, so the suite proves the order and
 * the aggregation, not that sox or ffmpeg record anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startRecording, startStreamingRecording } from "@veyyon/coding-agent/speech/stt/recorder";
import * as toolsManager from "@veyyon/coding-agent/utils/tools-manager";
import * as utils from "@veyyon/utils";

describe.skipIf(process.platform === "win32")("a recorder that fails to start yields to the next", () => {
	let stubDir: string;
	let failingBin: string;
	let liveBin: string;

	beforeEach(async () => {
		stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-stt-fallback-"));
		failingBin = path.join(stubDir, "failing");
		liveBin = path.join(stubDir, "live");
		await fs.writeFile(failingBin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		await fs.writeFile(liveBin, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
		vi.spyOn(toolsManager, "getToolPath").mockReturnValue(null);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(stubDir, { recursive: true, force: true });
	});

	/** Resolve `sox` and `ffmpeg` to the given stubs and hide every other tool. */
	function detect(sox: string | null, ffmpeg: string | null): void {
		vi.spyOn(utils, "$which").mockImplementation(name => (name === "sox" ? sox : name === "ffmpeg" ? ffmpeg : null));
	}

	// `stop()` on the ffmpeg path sends `q` and waits up to 3 s before killing;
	// the sleeping stub never reads it, so the arm pays that deadline.
	it("starts the second recorder when the first exits at startup", async () => {
		detect(failingBin, liveBin);
		const handle = await startRecording(path.join(stubDir, "out.wav"));
		await handle.stop();
	}, 15_000);

	it("lists every recorder's failure when none starts", async () => {
		detect(failingBin, failingBin);
		const error = await startRecording(path.join(stubDir, "out.wav")).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		const lines = (error as Error).message.split("\n");
		expect(lines[0]).toBe("No audio recorder could start — run `veyyon setup speech`.");
		expect(lines.slice(1)).toEqual([
			`sox (${failingBin}): sox exited immediately (code 3): (no output)`,
			`ffmpeg (${failingBin}): ffmpeg exited immediately (code 3): (no output)`,
		]);
	});

	it("streams from the second recorder when the first exits at startup", async () => {
		detect(failingBin, liveBin);
		const handle = await startStreamingRecording(() => {});
		expect(handle).not.toBeNull();
		await handle?.stop();
	}, 15_000);
	it("lists every streaming recorder's failure when none starts", async () => {
		detect(failingBin, failingBin);
		const error = await startStreamingRecording(() => {}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		const lines = (error as Error).message.split("\n");
		expect(lines[0]).toBe("No streaming audio recorder could start.");
		expect(lines.slice(1)).toEqual([
			`sox (${failingBin}): sox exited immediately (code 3): (no output)`,
			`ffmpeg (${failingBin}): ffmpeg exited immediately (code 3): (no output)`,
		]);
	});
});
