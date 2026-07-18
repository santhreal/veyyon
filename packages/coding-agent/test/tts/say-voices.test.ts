/**
 * `veyyon say --voices` lists every model and voice in the local TTS catalog
 * (with the current selection marked) and exits 0 without touching the worker,
 * and an unknown `--model` is rejected at parse time instead of failing later
 * with an opaque synthesis error.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { KOKORO_VOICES, TTS_LOCAL_MODELS } from "../../src/tts/models";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

async function runSay(args: string[], stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const home = mkdtempSync(path.join(tmpdir(), "veyyon-say-voices-"));
	const proc = Bun.spawn(["bun", cliPath, "say", ...args], {
		env: { ...process.env, HOME: home, VEYYON_CONFIG_DIR: path.join(home, ".veyyon"), NO_COLOR: "1" },
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("say --voices", () => {
	it("lists every catalog model and voice with the current selection marked, exit 0", async () => {
		const { exitCode, stdout } = await runSay(["--voices"]);
		expect(exitCode).toBe(0);
		for (const spec of TTS_LOCAL_MODELS) expect(stdout).toContain(spec.key);
		for (const voice of KOKORO_VOICES) {
			expect(stdout).toContain(voice.id);
			expect(stdout).toContain(voice.label);
		}
		// Defaults: kokoro + af_heart are the current selection in a fresh home.
		expect(stdout).toMatch(/kokoro.*\(current\)/);
		expect(stdout).toMatch(/af_heart.*\(current\)/);
	}, 30_000);

	it("rejects an unknown --model at parse time with the accepted values", async () => {
		const { exitCode, stderr } = await runSay(["--model", "nope", "hello"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("Expected --model to be one of: kokoro");
	}, 30_000);
});

describe("say error exit codes", () => {
	// Early error returns used to skip the trailing process.exit and exit 0.
	it("exits 1 with a contextual message when --file does not exist", async () => {
		const { exitCode, stderr } = await runSay(["--file", "/nonexistent-say-input.txt"]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('cannot read --file "/nonexistent-say-input.txt"');
	}, 30_000);

	it("exits 1 when the input has nothing speakable", async () => {
		const { exitCode, stderr } = await runSay(["   "]);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("nothing speakable in the input");
	}, 30_000);

	// Reaching "nothing speakable" (not an empty-arg error) proves piped stdin
	// was read as the input text; the speakable happy path is model-heavy and
	// covered by live dogfooding.
	it("reads piped stdin as the text to speak", async () => {
		const { exitCode, stderr } = await runSay([], "  \n\t ");
		expect(exitCode).toBe(1);
		expect(stderr).toContain("nothing speakable in the input");
	}, 30_000);
});
