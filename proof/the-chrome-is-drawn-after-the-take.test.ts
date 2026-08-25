/**
 * WHY THIS SUITE EXISTS
 *
 * The recorder used to draw the window chrome while it recorded: picom rounded
 * the corners, blended the terminal at 0.72 over a backdrop, and blurred what
 * was behind it, every frame. The backdrop does not move, so that recomputed one
 * static picture thirty times a second, and it cost the take: measured in the
 * recorder image at 2560x1440, with blur on, ffmpeg could GRAB only 69 of 360
 * frames, because the X server had nothing left to answer a capture with.
 * Opacity alone, without blur, still cost a third. Nothing downstream recovers a
 * frame that was never drawn.
 *
 * So the capture records the terminal on a flat backdrop and proof/compose-chrome.sh
 * draws the rounding, the shadow and the opacity afterwards. That moves the look
 * of every published frame into a script, and a script that quietly does the
 * wrong thing is worse than a compositor that does the right thing slowly: a
 * rescaled take is soft, a resampled one stutters, and a pass that skipped the
 * mask ships square corners under a themed name. None of that is visible in a
 * frame count or an exit code.
 *
 * THE CLASS THIS CLOSES. Every way the pass can silently change the take rather
 * than dress it: resampling the rate, rescaling the canvas, dropping the mask,
 * dropping the opacity, and failing open on a missing input, a missing binary or
 * a format it does not handle. Each is asserted on the composited FILE, by
 * probing the pixels and the stream, not by reading the script.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about whether the take was smooth --
 * proof/motion-gate.sh owns that, and the header on a composited file is as
 * uninformative as the header on the capture was. It does not compare the result
 * against what picom drew, so a change in the backdrop recipe or the shadow
 * geometry passes here and shows up only in a capture. And it pins the contract
 * at the configured geometry, so a scene that overrides SCENE_WIDTH is covered
 * only in so far as the pass reads the same config the session did.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
// Absolute, because one case runs the pass with a PATH that holds no tools, and a
// bare "bash" would then fail to spawn instead of reaching the guard being tested.
const BASH = "/bin/bash";
const COMPOSE = path.join(REPO_ROOT, "proof", "compose-chrome.sh");
const CONFIG = path.join(REPO_ROOT, "proof", "docker", "scene-config.sh");

/** What the pass reported, and how it ended. */
interface PassResult {
	code: number;
	stderr: string;
}

/**
 * The geometry the pass will use, read from the config the sessions read rather
 * than restated here. A suite that hardcodes 1600x1000 stops testing the moment
 * someone changes the default, and goes green while doing it.
 */
async function sceneConfig(): Promise<Record<string, string>> {
	const script =
		`source ${JSON.stringify(CONFIG)}\n` +
		'for n in ${SCENE_ENV_VARS}; do printf "%s=%s\\n" "${n}" "${!n}"; done\n';
	const { stdout } = await run(BASH, ["-c", script]);
	const out: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return out;
}

async function compose(input: string, output: string, env?: NodeJS.ProcessEnv): Promise<PassResult> {
	try {
		const { stderr } = await run(BASH, [COMPOSE, input, output], {
			env: { ...process.env, ...env },
			maxBuffer: 1 << 22,
		});
		return { code: 0, stderr };
	} catch (error: unknown) {
		const e = error as { code?: number; stderr?: string };
		return { code: typeof e.code === "number" ? e.code : 1, stderr: e.stderr ?? "" };
	}
}

/** `width,height,r_frame_rate` of a video's first stream. */
async function probe(file: string): Promise<{ width: number; height: number; rate: string }> {
	const { stdout } = await run("ffprobe", [
		...["-v", "error", "-select_streams", "v:0"],
		...["-show_entries", "stream=width,height,r_frame_rate"],
		...["-of", "csv=p=0", file],
	]);
	const [w, h, rate] = stdout.trim().split(",");
	return { width: Number(w), height: Number(h), rate: rate ?? "" };
}

/** One pixel, as `srgba(r,g,b,a)` with 8-bit components. */
async function pixel(file: string, x: number, y: number): Promise<string> {
	const { stdout } = await run("magick", [
		file,
		"-depth",
		"8",
		"-format",
		`%[pixel:p{${x},${y}}]`,
		"info:",
	]);
	return stdout.trim();
}

/**
 * A flat single-colour canvas, so any difference in the composited output is the
 * chrome and not the content. `rate` is deliberately never the default capture
 * rate, so a pass that hardcodes 30 is caught rather than agreed with.
 */
async function flatVideo(dir: string, w: number, h: number, rate: number): Promise<string> {
	const file = path.join(dir, `flat-${w}x${h}-${rate}.mp4`);
	await run("ffmpeg", [
		...["-loglevel", "error", "-y"],
		...["-f", "lavfi", "-i", `color=c=#20c020:size=${w}x${h}:rate=${rate}:duration=0.5`],
		...["-c:v", "libx264", "-pix_fmt", "yuv420p", file],
	]);
	return file;
}

async function flatStill(dir: string, w: number, h: number): Promise<string> {
	const file = path.join(dir, `flat-${w}x${h}.png`);
	await run("magick", ["-size", `${w}x${h}`, "xc:#20c020", file]);
	return file;
}

/**
 * A PATH holding only the named binaries, symlinked out of the real one. Used to
 * take a tool away from the pass without taking away the shell it runs in.
 */
async function stubPath(dir: string, keep: string[]): Promise<string> {
	const bin = path.join(dir, "stub-bin");
	await mkdir(bin, { recursive: true });
	for (const name of keep) {
		const { stdout } = await run(BASH, ["-c", `command -v ${name}`]);
		await symlink(stdout.trim(), path.join(bin, name));
	}
	return bin;
}

describe("the chrome is drawn after the take, and drawing it never alters the take", () => {
	it("hands back the configured canvas, not the cropped terminal", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chrome-canvas-"));
		try {
			const cfg = await sceneConfig();
			const w = Number(cfg.SCENE_WIDTH);
			const h = Number(cfg.SCENE_HEIGHT);
			const out = path.join(dir, "out.mp4");
			const result = await compose(await flatVideo(dir, w, h, 24), out);

			expect(result.code).toBe(0);
			expect(await probe(out)).toMatchObject({ width: w, height: h });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("keeps the take's own frame rate instead of imposing the capture default", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chrome-rate-"));
		try {
			const cfg = await sceneConfig();
			const w = Number(cfg.SCENE_WIDTH);
			const h = Number(cfg.SCENE_HEIGHT);
			// 24 is not SCENE_FPS and not ffmpeg's 25 default, so agreeing with it
			// takes reading the input.
			expect(cfg.SCENE_FPS).not.toBe("24");
			const out = path.join(dir, "out.mp4");

			expect((await compose(await flatVideo(dir, w, h, 24), out)).code).toBe(0);
			expect((await probe(out)).rate).toBe("24/1");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("rounds the terminal's corners and blends it, on a canvas that was flat", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chrome-round-"));
		try {
			const cfg = await sceneConfig();
			const w = Number(cfg.SCENE_WIDTH);
			const h = Number(cfg.SCENE_HEIGHT);
			const margin = Number(cfg.SCENE_MARGIN);
			const input = await flatStill(dir, w, h);
			const out = path.join(dir, "out.png");

			expect((await compose(input, out)).code).toBe(0);

			// The input is one colour everywhere, so the source pixel at the rect's
			// corner and at its centre are identical. After the pass they must not
			// be: the corner is outside the rounding and shows the backdrop.
			expect(await pixel(input, margin + 1, margin + 1)).toBe(await pixel(input, w / 2, h / 2));
			const corner = await pixel(out, margin + 1, margin + 1);
			const centre = await pixel(out, w / 2, h / 2);
			expect(corner).not.toBe(centre);

			// And the centre is the terminal blended, not the terminal copied.
			expect(Number(cfg.SCENE_OPACITY)).toBeLessThan(1);
			expect(centre).not.toBe(await pixel(input, w / 2, h / 2));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("refuses a take of the wrong size rather than rescaling it into a soft one", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chrome-size-"));
		try {
			const cfg = await sceneConfig();
			const w = Number(cfg.SCENE_WIDTH);
			const h = Number(cfg.SCENE_HEIGHT);
			const out = path.join(dir, "out.mp4");
			const result = await compose(await flatVideo(dir, w - 160, h - 100, 24), out);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`${w - 160}x${h - 100}`);
			expect(result.stderr).toContain(`${w}x${h}`);
			expect(await Bun.file(out).exists()).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	it("names a missing input, a missing tool and an unhandled format, and never exits 127", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "chrome-guard-"));
		try {
			const missing = await compose(path.join(dir, "never-written.mp4"), path.join(dir, "a.mp4"));
			expect(missing.code).toBe(1);
			expect(missing.stderr).toContain("never-written.mp4");

			const unhandled = path.join(dir, "take.gif");
			await writeFile(unhandled, "not a take");
			const wrongFormat = await compose(unhandled, path.join(dir, "b.gif"));
			expect(wrongFormat.code).toBe(1);

			// A PATH with coreutils but no media tools is how a recorder image built
			// without them behaves. Left to the shell that is exit 127 out of a
			// filter pipeline, which reads as a broken take rather than a missing
			// package. `dirname` is kept because the script resolves its own
			// location before it can check anything.
			const cfg = await sceneConfig();
			const stub = await stubPath(dir, ["dirname"]);
			const bare = await compose(
				await flatStill(dir, Number(cfg.SCENE_WIDTH), Number(cfg.SCENE_HEIGHT)),
				path.join(dir, "c.png"),
				{ PATH: stub },
			);
			expect(bare.code).toBe(1);
			expect(bare.code).not.toBe(127);
			expect(bare.stderr).toMatch(/ffmpeg|ffprobe|magick/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);
	it("centralizes all scene configuration knobs and generates docker environment arguments", async () => {
		const script =
			`source ${JSON.stringify(CONFIG)}\n` +
			"scene_docker_env_args\n" +
			'echo "COUNT=${#SCENE_DOCKER_ENV[@]}"\n' +
			'echo "VARS=${SCENE_ENV_VARS}"\n';
		const { stdout } = await run(BASH, ["-c", script]);
		const countMatch = stdout.match(/COUNT=(\d+)/);
		const varsMatch = stdout.match(/VARS=([\s\S]*)/);
		expect(countMatch).not.toBeNull();
		expect(varsMatch).not.toBeNull();
		const count = Number(countMatch?.[1]);
		const vars = (varsMatch?.[1] ?? "").trim().split(/\s+/).filter(Boolean);

		// No duplicate variables
		const uniqueVars = new Set(vars);
		expect(uniqueVars.size).toBe(vars.length);

		// All docker args generated as -e pairs
		expect(count).toBe(vars.length * 2);

		// Key knobs present
		expect(uniqueVars.has("SCENE_WIDTH")).toBe(true);
		expect(uniqueVars.has("SCENE_HEIGHT")).toBe(true);
		expect(uniqueVars.has("SCENE_FPS")).toBe(true);
		expect(uniqueVars.has("SCENE_CHROME")).toBe(true);
		expect(uniqueVars.has("SCENE_HOLD")).toBe(true);
		expect(uniqueVars.has("SCENE_TYPING_REPEAT")).toBe(true);
		expect(uniqueVars.has("SCENE_MARK_LEAD_MIN_MS")).toBe(true);
		expect(uniqueVars.has("SCENE_MOTION_FLOOR")).toBe(true);
	});
});
