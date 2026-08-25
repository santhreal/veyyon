/**
 * WHY THIS SUITE EXISTS
 *
 * A hero take shipped at 2560x1440, 60/1 CFR, 7415 frames, 123s, encoded without
 * dropping anything — and it stuttered. Measured with mpdecimate it carried 385
 * unique frames: a flat 3.3 per second through typing, streaming and idle alike.
 * The cause was `--blur-background` in the recorder's picom chrome. A translucent
 * window makes the compositor re-blur everything behind it every frame, on the CPU
 * through xrender, over the whole 2304x1184 inset. That saturates the X server: in
 * the recorder image, one identical counter, six seconds per arm, the blurred arm
 * captured 14 unique frames of 69 GRABBED, against 296 of 359 with no compositor.
 * ffmpeg could not even sample the display, so no encoder setting and no
 * render-loop change downstream could recover frames that were never drawn.
 *
 * Every signal available at the time said the take was fine. `ffprobe` reported
 * 60/1 and 7415 frames; the encoder log was clean; the scene guards all landed.
 * That is the defect: the pipeline had no measurement of whether the picture
 * MOVED, so a capture could be perfect by every recorded number and unwatchable.
 *
 * THE CLASS THIS CLOSES. Not "blur was on once": any change that starves the
 * capture of drawn frames — a compositor effect, a heavier backdrop, a slower
 * terminal, a smaller render budget, a future GPU-less host — now fails at the
 * gate instead of shipping. The gate measures the output rather than inspecting
 * settings, so it catches causes nobody has thought of yet, which is the whole
 * reason it is not a check on the value of a flag.
 *
 * WHAT IT DOES NOT CATCH. Motion fps is a rate, not a distribution: a take that
 * is smooth for a minute and frozen for ten seconds can clear a floor that a
 * uniformly mediocre take fails. It also cannot distinguish a scene that is
 * legitimately still from a pipeline that is stuck, which is why the floor sits
 * far below the capture rate and why SCENE_MOTION_FLOOR exists. And it says
 * nothing about how the frames LOOK — a smooth capture of the wrong colours
 * passes here.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const GATE = path.join(REPO_ROOT, "proof", "motion-gate.sh");

/** Outcome of running the gate: exit code plus what it told the operator. */
interface GateResult {
	code: number;
	output: string;
}

/**
 * A synthetic take. `changesPerSecond` is how often the picture actually
 * changes; `containerFps` is what the file claims. The two are independent,
 * which is precisely the confusion the gate exists to resolve.
 */
interface Take {
	changesPerSecond: number;
	containerFps: number;
	seconds: number;
}

/**
 * Render a take whose content changes at a chosen rate while the container
 * carries a chosen frame rate. `-r` after the source resamples: a 2 fps source
 * written at 60 fps produces genuine 60 fps CFR in which each picture repeats 30
 * times, which is byte-for-byte the shape of the take that shipped.
 */
async function renderTake(dir: string, name: string, take: Take): Promise<string> {
	const file = path.join(dir, `${name}.mp4`);
	await run("ffmpeg", [
		"-loglevel", "error", "-y",
		"-f", "lavfi",
		"-i", `testsrc=size=640x360:rate=${take.changesPerSecond}:duration=${take.seconds}`,
		"-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
		"-pix_fmt", "yuv420p",
		"-r", String(take.containerFps),
		file,
	]);
	return file;
}

async function gate(video: string, floor?: number): Promise<GateResult> {
	const args = floor === undefined ? [GATE, video] : [GATE, video, String(floor)];
	try {
		const { stdout, stderr } = await run("bash", args);
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error: unknown) {
		// execFile rejects with an Error carrying the child's code and streams.
		const failure =
			error && typeof error === "object"
				? (error as { code?: number; stdout?: string; stderr?: string })
				: {};
		return {
			code: typeof failure.code === "number" ? failure.code : 1,
			output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
		};
	}
}

describe("a capture is judged on motion, not on what the container claims", () => {
	it("fails the take that shipped: 60 fps CFR carrying ~3 changes a second", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "motion-gate-"));
		try {
			// The shape of the defect, reproduced: the container is a true 60 fps
			// CFR file and every frame-rate number reads correct.
			const video = await renderTake(dir, "stuttering", {
				changesPerSecond: 3,
				containerFps: 60,
				seconds: 6,
			});

			const claimed = await run("ffprobe", [
				"-v", "quiet", "-select_streams", "v:0",
				"-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video,
			]);
			expect(claimed.stdout.trim()).toBe("60/1");

			const result = await gate(video);
			expect(result.code).toBe(1);
			expect(result.output).toContain("STUTTERING");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("passes a take whose picture actually moves", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "motion-gate-"));
		try {
			const video = await renderTake(dir, "smooth", {
				changesPerSecond: 60,
				containerFps: 60,
				seconds: 6,
			});
			const result = await gate(video);
			expect(result.code).toBe(0);
			expect(result.output).toContain("fps of real change");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("reads the rate the picture changes, not the rate the container claims", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "motion-gate-"));
		try {
			// Same content rate, two different container rates. Motion fps must
			// not move, or the gate is measuring the wrong thing and a stuttering
			// take could be rescued by re-encoding it at a higher frame rate.
			const at30 = await renderTake(dir, "at30", {
				changesPerSecond: 20,
				containerFps: 30,
				seconds: 6,
			});
			const at60 = await renderTake(dir, "at60", {
				changesPerSecond: 20,
				containerFps: 60,
				seconds: 6,
			});

			const read = (output: string): number => {
				const match = output.match(/= (\d+) fps of real change/);
				expect(match).not.toBeNull();
				return Number(match?.[1]);
			};

			const a = read((await gate(at30, 5)).output);
			const b = read((await gate(at60, 5)).output);
			expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 180_000);

	it("refuses a take it cannot measure instead of calling it good", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "motion-gate-"));
		try {
			// Both refusals fail closed, so exit code alone cannot tell them
			// apart — drop the missing-file guard and this case still exits 1
			// through the unmeasurable branch. The message is what distinguishes
			// them, so the message is what gets pinned.
			const missing = await gate(path.join(dir, "does-not-exist.mp4"));
			expect(missing.code).toBe(1);
			expect(missing.output).toContain("is missing or empty");

			// A file that exists and is not a video. Silence here would let a
			// broken encode through as a pass.
			const notAVideo = path.join(dir, "empty.mp4");
			await run("bash", ["-c", `printf 'not a video' > ${JSON.stringify(notAVideo)}`]);
			const unreadable = await gate(notAVideo);
			expect(unreadable.code).toBe(1);
			expect(unreadable.output).toContain("could not measure");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("takes a floor from the caller so a deliberately still take can pass", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "motion-gate-"));
		try {
			const video = await renderTake(dir, "still", {
				changesPerSecond: 3,
				containerFps: 60,
				seconds: 6,
			});
			expect((await gate(video, 12)).code).toBe(1);
			expect((await gate(video, 1)).code).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
