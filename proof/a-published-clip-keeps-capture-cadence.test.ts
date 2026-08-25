/**
 * WHY THIS SUITE EXISTS
 *
 * Animated WebP coalesces byte-identical input frames. A real hero rehearsal whose
 * recorder and postprocessing delivered every frame therefore measured 25.1 fps:
 * normal keyboard, spinner, and token pauses merged 400 of 2458 CFR frames. The old
 * 10% moving-average bound rejected that take even though 85.5% of its animation
 * frames retained the 33/34ms capture interval.
 *
 * THE CLASS THIS CLOSES. A valid terminal take with short content pauses passes, but
 * resampling, the historical 14.2fps distribution, and frequent short holds still
 * fail. The average and cadence-share bounds are independent so neither a good mode
 * nor a few fast frames can hide a stuttering clip.
 *
 * WHAT IT DOES NOT CATCH. Capture-time render starvation is measured on the MP4 by
 * proof/motion-gate.sh. This suite covers only timing written into the published WebP.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const TEST_ROOT = path.join(REPO_ROOT, ".internal", "cadence-tests");
const GATE = path.join(REPO_ROOT, "proof", "webp-cadence.py");

interface GateResult {
	code: number;
	output: string;
}

function repeat(duration: number, count: number): number[] {
	return Array.from({ length: count }, () => duration);
}

function animationChunk(duration: number): Buffer {
	const payload = Buffer.alloc(15);
	payload.writeUIntLE(duration, 12, 3);
	const header = Buffer.alloc(8);
	header.write("ANMF", 0, "ascii");
	header.writeUInt32LE(payload.length, 4);
	return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)]);
}

async function syntheticWebp(dir: string, name: string, durations: readonly number[]): Promise<string> {
	const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...durations.map(animationChunk)]);
	const header = Buffer.alloc(8);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(body.length, 4);
	const file = path.join(dir, `${name}.webp`);
	await writeFile(file, Buffer.concat([header, body]));
	return file;
}

async function gate(file: string): Promise<GateResult> {
	try {
		const { stdout, stderr } = await run("python3", [GATE, file, "--expect-ms", "33"]);
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error: unknown) {
		if (!error || typeof error !== "object") return { code: 1, output: String(error) };
		const code = "code" in error && typeof error.code === "number" ? error.code : 1;
		const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
		const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
		return { code, output: `${stdout}${stderr}` };
	}
}

describe("a published clip keeps the cadence the recorder delivered", () => {
	it("accepts the measured production take with natural terminal pauses", async () => {
		await mkdir(TEST_ROOT, { recursive: true });
		const dir = await mkdtemp(path.join(TEST_ROOT, "production-"));
		try {
			const durations = [
				...repeat(33, 1169),
				...repeat(34, 591),
				...repeat(66, 76),
				...repeat(67, 139),
				...repeat(100, 70),
				...repeat(133, 8),
				...repeat(134, 3),
				...repeat(167, 1),
				...repeat(300, 1),
			];
			const result = await gate(await syntheticWebp(dir, "production", durations));
			expect(result.code).toBe(0);
			expect(result.output).toContain("25.1 fps");
			expect(result.output).toContain("85.5% of frames use the capture interval");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects resampling away from the capture interval", async () => {
		await mkdir(TEST_ROOT, { recursive: true });
		const dir = await mkdtemp(path.join(TEST_ROOT, "resampled-"));
		try {
			const result = await gate(await syntheticWebp(dir, "resampled", repeat(83, 100)));
			expect(result.code).toBe(1);
			expect(result.output).toContain("clip was resampled away from its source cadence");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects the historical 14.2fps short-hold distribution", async () => {
		await mkdir(TEST_ROOT, { recursive: true });
		const dir = await mkdtemp(path.join(TEST_ROOT, "historical-"));
		try {
			const durations = [...repeat(33, 44), ...repeat(66, 19), ...repeat(100, 19), ...repeat(134, 18)];
			const result = await gate(await syntheticWebp(dir, "historical", durations));
			expect(result.code).toBe(1);
			expect(result.output).toContain("14.2 fps");
			expect(result.output).toContain("under the 24.2 fps floor");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects frequent off-cadence frames even when the average is fast", async () => {
		await mkdir(TEST_ROOT, { recursive: true });
		const dir = await mkdtemp(path.join(TEST_ROOT, "share-"));
		try {
			const durations = [...repeat(33, 80), ...repeat(40, 20)];
			const result = await gate(await syntheticWebp(dir, "share", durations));
			expect(result.code).toBe(1);
			expect(result.output).toContain("80.0% of moving frames use the capture interval");
			expect(result.output).toContain("under the 85.0% floor");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("sets genuinely still screens aside", async () => {
		await mkdir(TEST_ROOT, { recursive: true });
		const dir = await mkdtemp(path.join(TEST_ROOT, "stills-"));
		try {
			const durations = [...repeat(33, 90), ...repeat(500, 3)];
			const result = await gate(await syntheticWebp(dir, "stills", durations));
			expect(result.code).toBe(0);
			expect(result.output).toContain("3 holds >= 330ms");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
